// Open Food Facts proxy endpoints: text search and barcode lookup.
//
// Remote results are mapped to a common shape and cached as rows in the
// 'foods' collection (source='off', upserted by (source, source_id)) so
// diary entries can reference them like any other food.
package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

// offClient is the shared HTTP client for Open Food Facts requests.
var offClient = &http.Client{Timeout: 10 * time.Second}

// offNutriments is the subset of the OFF nutriments object we care about.
type offNutriments struct {
	EnergyKcal100g any     `json:"energy-kcal_100g"`
	Proteins100g   any     `json:"proteins_100g"`
	Carbs100g      any     `json:"carbohydrates_100g"`
	Fat100g        any     `json:"fat_100g"`
}

// offProduct is the mapped product shape returned to the frontend.
type offProduct struct {
	Barcode      string  `json:"barcode"`
	Name         string  `json:"name"`
	Brand        string  `json:"brand"`
	KcalPer100g  float64 `json:"kcal_per_100g"`
	Protein100g  float64 `json:"protein_per_100g"`
	Carbs100g    float64 `json:"carbs_per_100g"`
	Fat100g      float64 `json:"fat_per_100g"`
}

// GET /api/saolrian/food/search?q=...
func foodSearchHandler(e *core.RequestEvent) error {
	q := strings.TrimSpace(e.Request.URL.Query().Get("q"))
	if q == "" {
		return e.BadRequestError("missing q parameter", nil)
	}

	// local custom foods first (case-insensitive name match)
	local, err := searchLocalFoods(e, q)
	if err != nil {
		return e.InternalServerError("failed to search local foods", err)
	}

	resp := map[string]any{
		"local":  local,
		"remote": []offProduct{},
		"error":  "",
	}

	// proxy to Open Food Facts; degrade gracefully when unreachable
	products, offErr := offSearch(q)
	if offErr != nil {
		resp["error"] = "Open Food Facts is unreachable: " + offErr.Error()
	} else {
		// cache into foods (best effort; failures are not fatal)
		for _, p := range products {
			cacheOFFProduct(e, p)
		}
		resp["remote"] = products
	}

	return e.JSON(http.StatusOK, resp)
}

// GET /api/saolrian/food/barcode/{code}
func foodBarcodeHandler(e *core.RequestEvent) error {
	code := e.Request.PathValue("code")
	if code == "" {
		return e.BadRequestError("missing barcode", nil)
	}

	product, err := offBarcode(code)
	if err != nil {
		if err == errNotFound {
			return e.NotFoundError("product not found", nil)
		}
		return e.InternalServerError("Open Food Facts is unreachable: "+err.Error(), nil)
	}

	cacheOFFProduct(e, *product)

	return e.JSON(http.StatusOK, map[string]any{"product": product})
}

// ---------------------------------------------------------------------
// local foods
// ---------------------------------------------------------------------

// searchLocalFoods returns the user's own foods whose name contains q
// (case-insensitive).
func searchLocalFoods(e *core.RequestEvent, q string) ([]map[string]any, error) {
	records, err := e.App.FindRecordsByFilter(
		"foods",
		"user = {:uid} && name ~ {:q}",
		"name", 50, 0,
		map[string]any{"uid": e.Auth.Id, "q": q},
	)
	if err != nil {
		return nil, err
	}

	out := make([]map[string]any, 0, len(records))
	for _, r := range records {
		out = append(out, foodToMap(r))
	}
	return out, nil
}

// foodToMap maps a foods record to the same shape as offProduct plus id.
func foodToMap(r *core.Record) map[string]any {
	return map[string]any{
		"id":             r.Id,
		"barcode":        r.GetString("barcode"),
		"name":           r.GetString("name"),
		"brand":          r.GetString("brand"),
		"kcal_per_100g":  r.GetFloat("kcal_per_100g"),
		"protein_per_100g": r.GetFloat("protein_per_100g"),
		"carbs_per_100g": r.GetFloat("carbs_per_100g"),
		"fat_per_100g":   r.GetFloat("fat_per_100g"),
		"default_serving_g": r.GetFloat("default_serving_g"),
		"source":         r.GetString("source"),
	}
}

// ---------------------------------------------------------------------
// Open Food Facts
// ---------------------------------------------------------------------

var errNotFound = fmt.Errorf("not found")

// offSearch queries the OFF search API and maps the results.
func offSearch(q string) ([]offProduct, error) {
	u := "https://world.openfoodfacts.org/cgi/search.pl?" + url.Values{
		"search_terms":  {q},
		"search_simple": {"1"},
		"action":        {"process"},
		"json":          {"1"},
		"page_size":     {"20"},
		"fields":        {"code,product_name,brands,nutriments"},
	}.Encode()

	body, err := fetchJSON(u)
	if err != nil {
		return nil, err
	}

	var parsed struct {
		Products []struct {
			Code        string         `json:"code"`
			ProductName string         `json:"product_name"`
			Brands      string         `json:"brands"`
			Nutriments  offNutriments  `json:"nutriments"`
		} `json:"products"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, err
	}

	out := make([]offProduct, 0, len(parsed.Products))
	for _, p := range parsed.Products {
		out = append(out, mapOffProduct(p.Code, p.ProductName, p.Brands, p.Nutriments))
	}
	return out, nil
}

// offBarcode queries the OFF v2 product API and maps the result.
func offBarcode(code string) (*offProduct, error) {
	u := fmt.Sprintf("https://world.openfoodfacts.org/api/v2/product/%s.json", url.PathEscape(code))

	body, err := fetchJSON(u)
	if err != nil {
		return nil, err
	}

	var parsed struct {
		Status  int    `json:"status"`
		Product struct {
			Code        string        `json:"code"`
			ProductName string        `json:"product_name"`
			Brands      string        `json:"brands"`
			Nutriments  offNutriments `json:"nutriments"`
		} `json:"product"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, err
	}
	if parsed.Status != 1 {
		return nil, errNotFound
	}

	p := mapOffProduct(parsed.Product.Code, parsed.Product.ProductName, parsed.Product.Brands, parsed.Product.Nutriments)
	return &p, nil
}

// fetchJSON performs a GET with the shared 10s client and returns the body.
func fetchJSON(u string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Saolrian/1.0 (self-hosted calorie tracker)")

	resp, err := offClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return nil, errNotFound
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected status %d", resp.StatusCode)
	}

	return io.ReadAll(resp.Body)
}

// mapOffProduct converts raw OFF fields to the shared product shape.
func mapOffProduct(code, name, brands string, n offNutriments) offProduct {
	return offProduct{
		Barcode:     code,
		Name:        name,
		Brand:       brands,
		KcalPer100g: toFloat(n.EnergyKcal100g),
		Protein100g: toFloat(n.Proteins100g),
		Carbs100g:   toFloat(n.Carbs100g),
		Fat100g:     toFloat(n.Fat100g),
	}
}

// cacheOFFProduct upserts a cached foods row keyed by (source='off', source_id).
func cacheOFFProduct(e *core.RequestEvent, p offProduct) {
	if p.Barcode == "" || p.Name == "" {
		return
	}

	col, err := e.App.FindCollectionByNameOrId("foods")
	if err != nil {
		return
	}

	existing, findErr := e.App.FindFirstRecordByFilter(
		"foods",
		"source = 'off' && source_id = {:sid}",
		map[string]any{"sid": p.Barcode},
	)

	var rec *core.Record
	if findErr == nil {
		rec = existing
	} else {
		rec = core.NewRecord(col)
		rec.Set("source", "off")
		rec.Set("source_id", p.Barcode)
		// cached OFF products are shared: no owning user
	}

	rec.Set("barcode", p.Barcode)
	rec.Set("name", p.Name)
	if p.Brand != "" {
		rec.Set("brand", p.Brand)
	}
	rec.Set("kcal_per_100g", p.KcalPer100g)
	rec.Set("protein_per_100g", p.Protein100g)
	rec.Set("carbs_per_100g", p.Carbs100g)
	rec.Set("fat_per_100g", p.Fat100g)
	if rec.GetFloat("default_serving_g") == 0 {
		rec.Set("default_serving_g", 100.0)
	}

	_ = e.App.Save(rec) // best effort; a cache miss must not break the search
}

// toFloat coerces OFF's loosely-typed numeric values.
func toFloat(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case string:
		var f float64
		_, err := fmt.Sscanf(strings.TrimSpace(x), "%g", &f)
		if err != nil {
			return 0
		}
		return f
	default:
		return 0
	}
}

package source

import (
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/boanntech/saolrian/backend/internal/food"
	"github.com/boanntech/saolrian/backend/internal/foodpack/format"
)

// ErrMappingNotInSource means the mapping table references a nutrient code
// the dataset does not define — a stale mapping that would silently drop
// data.
var ErrMappingNotInSource = errors.New("mapped nutrient code absent from source dataset")

const (
	usdaLicence = "public-domain"
	usdaRegion  = "us"
)

// USDAOptions configures the FoodData Central adapter.
type USDAOptions struct {
	Dir       string   // directory of extracted FDC CSVs
	DataTypes []string // e.g. "foundation_food", "sr_legacy_food"
	Mapping   *Mapping
}

// LoadUSDA reads the FDC CSV export and returns canonical reference foods.
func LoadUSDA(o USDAOptions) ([]format.RefFood, error) {
	if o.Mapping == nil {
		return nil, errors.New("usda: mapping is required")
	}

	nutrients, err := usdaNutrients(o.Dir)
	if err != nil {
		return nil, err
	}
	if err := usdaCheckMapping(o.Mapping, nutrients); err != nil {
		return nil, err
	}

	foods, order, err := usdaFoods(o.Dir, o.DataTypes)
	if err != nil {
		return nil, err
	}

	profiles := map[string]food.Profile{}
	if err := usdaEachRow(filepath.Join(o.Dir, "food_nutrient.csv"),
		[]string{"fdc_id", "nutrient_id", "amount"},
		func(get func(string) string) error {
			fdcID := get("fdc_id")
			if _, ok := foods[fdcID]; !ok {
				return nil // a food we filtered out
			}
			n, ok := nutrients[get("nutrient_id")]
			if !ok {
				return nil // nutrient not in this release's table
			}
			amount, err := strconv.ParseFloat(strings.TrimSpace(get("amount")), 64)
			if err != nil {
				return nil // blank amounts are common and simply mean no data
			}
			key, value, ok := o.Mapping.Apply(n.number, amount)
			if !ok {
				return nil // unmapped or explicitly ignored
			}
			if profiles[fdcID] == nil {
				profiles[fdcID] = food.Profile{}
			}
			profiles[fdcID][key] = value
			return nil
		}); err != nil {
		return nil, err
	}

	portions, err := usdaPortions(o.Dir, foods)
	if err != nil {
		return nil, err
	}

	out := make([]format.RefFood, 0, len(order))
	for _, fdcID := range order {
		f := foods[fdcID]
		prof := profiles[fdcID]
		if prof == nil {
			continue // no nutrient data at all: not worth shipping
		}
		if err := food.Validate(prof); err != nil {
			return nil, fmt.Errorf("usda %s (%s): %w", fdcID, f.name, err)
		}
		p := portions[fdcID]
		var defaultServing float64
		if len(p) > 0 {
			defaultServing = p[0].Grams
		}
		out = append(out, format.RefFood{
			Source:          f.source,
			SourceID:        fdcID,
			Region:          usdaRegion,
			Licence:         usdaLicence,
			Name:            f.name,
			SearchText:      SearchText(f.name),
			Nutrients:       food.Encode(prof),
			Portions:        p,
			DefaultServingG: defaultServing,
		})
	}
	return out, nil
}

type usdaNutrient struct {
	number string
	unit   string
}

type usdaFood struct {
	name   string
	source string
}

// usdaNutrients maps FDC internal nutrient id -> stable nutrient_nbr + unit.
func usdaNutrients(dir string) (map[string]usdaNutrient, error) {
	out := map[string]usdaNutrient{}
	err := usdaEachRow(filepath.Join(dir, "nutrient.csv"),
		[]string{"id", "unit_name", "nutrient_nbr"},
		func(get func(string) string) error {
			out[get("id")] = usdaNutrient{
				number: strings.TrimSpace(get("nutrient_nbr")),
				unit:   strings.ToUpper(strings.TrimSpace(get("unit_name"))),
			}
			return nil
		})
	return out, err
}

// usdaCheckMapping fails the build when the mapping is stale or its factor
// disagrees with the dataset's declared unit.
func usdaCheckMapping(m *Mapping, nutrients map[string]usdaNutrient) error {
	byNumber := map[string]usdaNutrient{}
	for _, n := range nutrients {
		byNumber[n.number] = n
	}
	for _, code := range m.Codes() {
		n, present := byNumber[code]
		unit, mapped := m.UnitFor(code)
		if !mapped {
			continue // explicitly ignored codes need not exist
		}
		if !present {
			return fmt.Errorf("%w: nutrient_nbr %s", ErrMappingNotInSource, code)
		}
		if want := usdaUnitFor(unit); want != "" && n.unit != want {
			return fmt.Errorf("usda nutrient_nbr %s: source unit %q but canonical unit is %q; check the factor in mapping/usda.csv",
				code, n.unit, unit)
		}
	}
	return nil
}

// usdaUnitFor is the FDC spelling of a canonical unit, or "" when the
// mapping deliberately converts between units (factor != 1).
func usdaUnitFor(u food.Unit) string {
	switch u {
	case food.UnitKcal:
		return "KCAL"
	case food.UnitG:
		return "G"
	case food.UnitMg:
		return "MG"
	case food.UnitUg:
		return "UG"
	}
	return ""
}

func usdaFoods(dir string, dataTypes []string) (map[string]usdaFood, []string, error) {
	want := map[string]bool{}
	for _, dt := range dataTypes {
		want[dt] = true
	}
	foods := map[string]usdaFood{}
	var order []string

	err := usdaEachRow(filepath.Join(dir, "food.csv"),
		[]string{"fdc_id", "data_type", "description"},
		func(get func(string) string) error {
			dt := strings.TrimSpace(get("data_type"))
			if !want[dt] {
				return nil
			}
			name := strings.TrimSpace(get("description"))
			if name == "" {
				return nil
			}
			id := get("fdc_id")
			src := "usda_sr"
			if dt == "foundation_food" {
				src = "usda_foundation"
			}
			foods[id] = usdaFood{name: name, source: src}
			order = append(order, id)
			return nil
		})
	return foods, order, err
}

func usdaPortions(dir string, foods map[string]usdaFood) (map[string][]format.Portion, error) {
	units := map[string]string{}
	if err := usdaEachRow(filepath.Join(dir, "measure_unit.csv"),
		[]string{"id", "name"},
		func(get func(string) string) error {
			units[get("id")] = strings.TrimSpace(get("name"))
			return nil
		}); err != nil {
		return nil, err
	}

	type seqPortion struct {
		seq int
		p   format.Portion
	}
	acc := map[string][]seqPortion{}

	err := usdaEachRow(filepath.Join(dir, "food_portion.csv"),
		[]string{"fdc_id", "seq_num", "amount", "measure_unit_id", "modifier", "gram_weight"},
		func(get func(string) string) error {
			id := get("fdc_id")
			if _, ok := foods[id]; !ok {
				return nil
			}
			grams, err := strconv.ParseFloat(strings.TrimSpace(get("gram_weight")), 64)
			if err != nil || grams <= 0 {
				return nil
			}
			label := usdaPortionLabel(get("amount"), units[get("measure_unit_id")], get("modifier"))
			if label == "" {
				return nil
			}
			seq, _ := strconv.Atoi(strings.TrimSpace(get("seq_num")))
			acc[id] = append(acc[id], seqPortion{seq: seq, p: format.Portion{Label: label, Grams: grams}})
			return nil
		})
	if err != nil {
		return nil, err
	}

	out := make(map[string][]format.Portion, len(acc))
	for id, ps := range acc {
		sort.SliceStable(ps, func(i, j int) bool { return ps[i].seq < ps[j].seq })
		list := make([]format.Portion, 0, len(ps))
		for _, sp := range ps {
			list = append(list, sp.p)
		}
		out[id] = list
	}
	return out, nil
}

// usdaPortionLabel builds "1 medium" / "1 cup, sliced" from FDC's split
// amount / measure unit / modifier columns. "undetermined" is FDC's
// placeholder unit and contributes nothing.
func usdaPortionLabel(amount, unit, modifier string) string {
	amount = strings.TrimSpace(amount)
	unit = strings.TrimSpace(unit)
	modifier = strings.TrimSpace(modifier)
	if unit == "undetermined" {
		unit = ""
	}
	head := strings.TrimSpace(amount + " " + unit)
	switch {
	case head != "" && modifier != "":
		return head + " " + modifier
	case head != "":
		return head
	case modifier != "":
		return modifier
	}
	return ""
}

// usdaEachRow streams a CSV, calling fn with a column accessor. It fails
// fast if any required column is missing from the header.
func usdaEachRow(path string, required []string, fn func(get func(string) string) error) error {
	f, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open %s: %w", filepath.Base(path), err)
	}
	defer f.Close()

	r := csv.NewReader(f)
	r.FieldsPerRecord = -1
	r.ReuseRecord = true
	r.LazyQuotes = true

	header, err := r.Read()
	if err != nil {
		return fmt.Errorf("read header of %s: %w", filepath.Base(path), err)
	}
	col := map[string]int{}
	for i, h := range header {
		col[strings.Trim(strings.TrimSpace(h), "\"")] = i
	}
	for _, name := range required {
		if _, ok := col[name]; !ok {
			return fmt.Errorf("%s: missing required column %q", filepath.Base(path), name)
		}
	}

	for {
		rec, err := r.Read()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("read %s: %w", filepath.Base(path), err)
		}
		get := func(name string) string {
			i, ok := col[name]
			if !ok || i >= len(rec) {
				return ""
			}
			return rec[i]
		}
		if err := fn(get); err != nil {
			return err
		}
	}
}

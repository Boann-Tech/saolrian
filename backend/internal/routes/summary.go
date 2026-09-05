// Package routes registers the custom /api/saolrian/ endpoints.
package routes

import (
	"fmt"
	"net/http"
	"time"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"

	"github.com/boanntech/saolrian/backend/internal/tdee"
)

// Register mounts all Saolrian custom routes on the router.
func Register(grp *router.Router[*core.RequestEvent]) {
	g := grp.Group("/api/saolrian")
	g.Bind(apis.RequireAuth())

	g.GET("/summary", summaryHandler)
	g.GET("/food/search", foodSearchHandler)
	g.GET("/food/barcode/{code}", foodBarcodeHandler)
	g.POST("/import/loseit", loseItImportHandler)
	g.GET("/push/vapid-key", pushVapidKeyHandler)
	g.POST("/push/subscribe", pushSubscribeHandler)
	g.POST("/push/unsubscribe", pushUnsubscribeHandler)
}

// ---------------------------------------------------------------------
// GET /api/saolrian/summary?date=YYYY-MM-DD
// ---------------------------------------------------------------------

type mealSlotGroup struct {
	ID            string        `json:"id"`
	Name          string        `json:"name"`
	SortOrder     float64       `json:"sort_order"`
	PctAllocation float64       `json:"pct_allocation"`
	Entries       []entryJSON   `json:"entries"`
	Totals        totalsJSON    `json:"totals"`
}

type entryJSON struct {
	ID           string  `json:"id"`
	MealSlot     string  `json:"meal_slot"`
	Food         string  `json:"food,omitempty"`
	Name         string  `json:"name"`
	Brand        string  `json:"brand,omitempty"`
	Grams        float64 `json:"grams"`
	Kcal         float64 `json:"kcal"`
	Protein      float64 `json:"protein"`
	Carbs        float64 `json:"carbs"`
	Fat          float64 `json:"fat"`
	LoggedAt     string  `json:"logged_at"`
	Source       string  `json:"source"`
}

type totalsJSON struct {
	Kcal    float64 `json:"kcal"`
	Protein float64 `json:"protein"`
	Carbs   float64 `json:"carbs"`
	Fat     float64 `json:"fat"`
}

func summaryHandler(e *core.RequestEvent) error {
	day := e.Request.URL.Query().Get("date")
	if day == "" {
		day = time.Now().Format("2006-01-02")
	}
	if _, err := time.Parse("2006-01-02", day); err != nil {
		return e.BadRequestError("invalid date, expected YYYY-MM-DD", nil)
	}

	uid := e.Auth.Id

	// all meal slots for the user, ordered
	slots, err := e.App.FindRecordsByFilter(
		"meal_slots", "user = {:uid}", "sort_order", 0, 0,
		map[string]any{"uid": uid},
	)
	if err != nil {
		return e.InternalServerError("failed to load meal slots", err)
	}

	// the day's diary entries
	entries, err := e.App.FindRecordsByFilter(
		"diary_entries",
		"user = {:uid} && logged_at >= {:start} && logged_at < {:end}",
		"logged_at", 0, 0,
		map[string]any{
			"uid":   uid,
			"start": day + " 00:00:00.000Z",
			"end":   nextDay(day) + " 00:00:00.000Z",
		},
	)
	if err != nil {
		return e.InternalServerError("failed to load diary entries", err)
	}

	// group entries by slot; count unmatched entries under an empty slot
	groups := make(map[string]*mealSlotGroup, len(slots))
	ordered := make([]*mealSlotGroup, 0, len(slots))
	for _, s := range slots {
		g := &mealSlotGroup{
			ID:            s.Id,
			Name:          s.GetString("name"),
			SortOrder:     s.GetFloat("sort_order"),
			PctAllocation: s.GetFloat("pct_allocation"),
			Entries:       []entryJSON{},
		}
		groups[s.Id] = g
		ordered = append(ordered, g)
	}
	unassigned := &mealSlotGroup{Name: "Other", Entries: []entryJSON{}}

	var dayTotals totalsJSON
	for _, en := range entries {
		item := entryJSON{
			ID:       en.Id,
			MealSlot: en.GetString("meal_slot"),
			Name:     en.GetString("name_snapshot"),
			Brand:    en.GetString("brand_snapshot"),
			Grams:    en.GetFloat("grams"),
			Kcal:     en.GetFloat("kcal"),
			Protein:  en.GetFloat("protein"),
			Carbs:    en.GetFloat("carbs"),
			Fat:      en.GetFloat("fat"),
			LoggedAt: en.GetString("logged_at"),
			Source:   en.GetString("source"),
		}
		if food := en.GetString("food"); food != "" {
			item.Food = food
		}

		g, ok := groups[item.MealSlot]
		if !ok {
			g = unassigned
		}
		g.Entries = append(g.Entries, item)
		g.Totals.Kcal += item.Kcal
		g.Totals.Protein += item.Protein
		g.Totals.Carbs += item.Carbs
		g.Totals.Fat += item.Fat

		dayTotals.Kcal += item.Kcal
		dayTotals.Protein += item.Protein
		dayTotals.Carbs += item.Carbs
		dayTotals.Fat += item.Fat
	}

	// only include the fallback group if it actually has entries
	resultGroups := make([]*mealSlotGroup, 0, len(ordered)+1)
	for _, g := range ordered {
		resultGroups = append(resultGroups, g)
	}
	if len(unassigned.Entries) > 0 {
		resultGroups = append(resultGroups, unassigned)
	}

	budget, budgetErr := userBudget(e, uid)

	resp := map[string]any{
		"date":    day,
		"slots":   resultGroups,
		"totals":  dayTotals,
		"budget":  budget, // nil when the profile has no weight yet
	}
	if budgetErr != nil {
		resp["budget_message"] = budgetErr.Error()
	}

	return e.JSON(http.StatusOK, resp)
}

// userBudget resolves the calorie budget: manual override when set, otherwise
// the computed TDEE adjusted for the goal. Returns (nil, errReason) when the
// data needed for the computation is missing (e.g. no weight yet).
func userBudget(e *core.RequestEvent, uid string) (any, error) {
	profile, err := e.App.FindFirstRecordByFilter("profiles", "user = {:uid}", map[string]any{"uid": uid})
	if err != nil {
		return nil, fmt.Errorf("no profile found")
	}

	// manual override
	if target := profile.GetFloat("calorie_target"); target > 0 {
		return tdee.Round(target), nil
	}

	// most recent weight
	recent, err := e.App.FindRecordsByFilter(
		"weights", "user = {:uid} && kg > 0", "-measured_at", 1, 0,
		map[string]any{"uid": uid},
	)
	if err != nil || len(recent) == 0 {
		return nil, fmt.Errorf("weight required: log a weight entry or set calorie_target to compute the budget")
	}
	weight := recent[0]

	// age from birth year
	age := 0.0
	if by := profile.GetFloat("birth_year"); by > 0 {
		age = float64(time.Now().Year()) - by
	}
	if age <= 0 {
		return nil, fmt.Errorf("birth_year required: set it in the profile to compute the budget")
	}

	in := tdee.Input{
		Sex:           profile.GetString("sex"),
		HeightCM:      profile.GetFloat("height_cm"),
		AgeYears:      age,
		WeightKG:      weight.GetFloat("kg"),
		BodyFatPct:    profile.GetFloat("body_fat_pct"),
		Formula:       profile.GetString("tdee_formula"),
		ActivityLevel: profile.GetString("activity_level"),
		Goal:          profile.GetString("goal"),
		GoalRate:      profile.GetFloat("goal_rate"),
	}

	return tdee.Round(tdee.Budget(in)), nil
}

// nextDay returns the day after the given YYYY-MM-DD date.
func nextDay(day string) string {
	t, err := time.Parse("2006-01-02", day)
	if err != nil {
		return day
	}
	return t.AddDate(0, 0, 1).Format("2006-01-02")
}

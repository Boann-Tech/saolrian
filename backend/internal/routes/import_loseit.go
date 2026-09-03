// POST /api/saolrian/import/loseit — bulk import of LoseIt CSV rows
// (already parsed to JSON by the frontend).
package routes

import (
	"strings"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

// loseItRow is one parsed CSV row from the frontend.
type loseItRow struct {
	Date     string  `json:"date"`     // YYYY-MM-DD
	Name     string  `json:"name"`
	Quantity float64 `json:"quantity"`
	Unit     string  `json:"unit"` // "g", "ml", "serving", ...
	Meal     string  `json:"meal"` // mapped to a meal_slots row by name
	Kcal     float64 `json:"kcal"`
	ProteinG float64 `json:"protein_g"`
	CarbsG   float64 `json:"carbs_g"`
	FatG     float64 `json:"fat_g"`
}

type loseItRequest struct {
	Rows []loseItRow `json:"rows"`
}

// POST /api/saolrian/import/loseit
func loseItImportHandler(e *core.RequestEvent) error {
	var req loseItRequest
	if err := e.BindBody(&req); err != nil {
		return e.BadRequestError("invalid JSON body", err)
	}

	uid := e.Auth.Id
	imported, skipped := 0, 0

	// cache of slot name -> slot record, filled lazily
	slotsByName := map[string]*core.Record{}

	for _, row := range req.Rows {
		if row.Name == "" || row.Date == "" {
			skipped++
			continue
		}

		slot, err := findOrCreateSlot(e, uid, row.Meal, slotsByName)
		if err != nil {
			skipped++
			continue
		}

		loggedAt, err := time.Parse("2006-01-02", row.Date)
		if err != nil {
			skipped++
			continue
		}

		grams := row.Quantity
		if strings.EqualFold(strings.TrimSpace(row.Unit), "serving") {
			grams = 0 // serving-based rows carry no gram weight
		}

		entries, err := e.App.FindCollectionByNameOrId("diary_entries")
		if err != nil {
			skipped++
			continue
		}

		rec := core.NewRecord(entries)
		rec.Set("user", uid)
		rec.Set("meal_slot", slot.Id)
		rec.Set("name_snapshot", row.Name)
		rec.Set("grams", grams)
		rec.Set("kcal", row.Kcal)
		rec.Set("protein", row.ProteinG)
		rec.Set("carbs", row.CarbsG)
		rec.Set("fat", row.FatG)
		rec.Set("logged_at", loggedAt.UTC().Format("2006-01-02 15:04:05.000Z"))
		rec.Set("source", "import")
		rec.Set("external_id", "loseit")

		if err := e.App.Save(rec); err != nil {
			skipped++
			continue
		}
		imported++
	}

	return e.JSON(200, map[string]any{"imported": imported, "skipped": skipped})
}

// findOrCreateSlot resolves a meal slot by name (case-insensitive), creating
// it when missing. Results are cached per request.
func findOrCreateSlot(e *core.RequestEvent, uid, mealName string, cache map[string]*core.Record) (*core.Record, error) {
	name := strings.TrimSpace(mealName)
	if name == "" {
		name = "Other"
	}
	key := strings.ToLower(name)

	if slot, ok := cache[key]; ok {
		return slot, nil
	}

	slots, err := e.App.FindRecordsByFilter(
		"meal_slots",
		"user = {:uid} && name ~ {:name}",
		"sort_order", 0, 0,
		map[string]any{"uid": uid, "name": name},
	)
	if err != nil {
		return nil, err
	}
	// exact case-insensitive match preferred over the "~" contains hits
	for _, s := range slots {
		if strings.EqualFold(s.GetString("name"), name) {
			cache[key] = s
			return s, nil
		}
	}
	if len(slots) > 0 {
		cache[key] = slots[0]
		return slots[0], nil
	}

	// determine the next sort order
	existing, err := e.App.FindRecordsByFilter(
		"meal_slots", "user = {:uid}", "-sort_order", 1, 0,
		map[string]any{"uid": uid},
	)
	if err != nil {
		return nil, err
	}
	nextSort := 0.0
	if len(existing) > 0 {
		nextSort = existing[0].GetFloat("sort_order") + 1
	}

	col, err := e.App.FindCollectionByNameOrId("meal_slots")
	if err != nil {
		return nil, err
	}
	slot := core.NewRecord(col)
	slot.Set("user", uid)
	slot.Set("name", name)
	slot.Set("sort_order", nextSort)
	if err := e.App.Save(slot); err != nil {
		return nil, err
	}

	cache[key] = slot
	return slot, nil
}

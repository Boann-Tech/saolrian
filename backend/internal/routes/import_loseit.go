// POST /api/saolrian/import/loseit — accepts a per-category payload
// parsed client-side from a LoseIt export zip, creates an import_jobs
// record, and processes every requested category on a detached
// goroutine so the request returns immediately. Progress/result is
// observed via PocketBase realtime subscription on the job record and,
// on completion, a Web Push notification (see internal/push).
package routes

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase/core"

	"github.com/boanntech/saolrian/backend/internal/push"
)

// ---------------------------------------------------------------------
// request shape
// ---------------------------------------------------------------------

type diaryRow struct {
	Date     string  `json:"date"` // YYYY-MM-DD
	Name     string  `json:"name"`
	Quantity float64 `json:"quantity"`
	Unit     string  `json:"unit"`
	Meal     string  `json:"meal"`
	Kcal     float64 `json:"kcal"`
	ProteinG float64 `json:"protein_g"`
	CarbsG   float64 `json:"carbs_g"`
	FatG     float64 `json:"fat_g"`
}

type weightRow struct {
	Date string  `json:"date"` // YYYY-MM-DD
	Kg   float64 `json:"kg"`
}

type exerciseRow struct {
	Date    string  `json:"date"` // YYYY-MM-DD
	Name    string  `json:"name"`
	Minutes float64 `json:"minutes"`
	Kcal    float64 `json:"kcal"`
}

type loseItRequest struct {
	Categories struct {
		Diary    []diaryRow    `json:"diary"`
		Weight   []weightRow   `json:"weight"`
		Exercise []exerciseRow `json:"exercise"`
	} `json:"categories"`
}

// ---------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------

func loseItImportHandler(e *core.RequestEvent) error {
	var req loseItRequest
	if err := e.BindBody(&req); err != nil {
		return e.BadRequestError("invalid JSON body", err)
	}

	uid := e.Auth.Id

	jobsCol, err := e.App.FindCollectionByNameOrId("import_jobs")
	if err != nil {
		return e.InternalServerError("failed to load import_jobs collection", err)
	}

	job := core.NewRecord(jobsCol)
	job.Set("user", uid)
	job.Set("status", "queued")
	job.Set("categories", requestedCategories(req))
	job.Set("counts", map[string]any{})
	if err := e.App.Save(job); err != nil {
		return e.InternalServerError("failed to create import job", err)
	}

	app := e.App
	jobID := job.Id
	go runImportJob(app, jobID, uid, req)

	return e.JSON(http.StatusAccepted, map[string]any{"job_id": jobID})
}

// requestedCategories lists the non-empty category names in the request,
// stored on the job record for display/debugging purposes.
func requestedCategories(req loseItRequest) []string {
	var names []string
	if len(req.Categories.Diary) > 0 {
		names = append(names, "diary")
	}
	if len(req.Categories.Weight) > 0 {
		names = append(names, "weight")
	}
	if len(req.Categories.Exercise) > 0 {
		names = append(names, "exercise")
	}
	return names
}

// ---------------------------------------------------------------------
// job runner
// ---------------------------------------------------------------------

type categoryCount struct {
	Imported int `json:"imported"`
	Skipped  int `json:"skipped"`
}

// runImportJob processes every requested category for one import job,
// updating the job record's status/counts as it goes. It runs on its own
// goroutine, detached from the originating request, so it must not touch
// anything from the *core.RequestEvent — only the app instance.
func runImportJob(app core.App, jobID, uid string, req loseItRequest) {
	defer func() {
		if r := recover(); r != nil {
			failJob(app, jobID, uid, fmt.Sprintf("panic: %v", r))
		}
	}()

	setJobStatus(app, jobID, "running")

	counts := map[string]categoryCount{}

	if len(req.Categories.Diary) > 0 {
		counts["diary"] = importDiaryRows(app, uid, req.Categories.Diary)
	}
	if len(req.Categories.Weight) > 0 {
		counts["weight"] = importWeightRows(app, uid, req.Categories.Weight)
	}
	if len(req.Categories.Exercise) > 0 {
		counts["exercise"] = importExerciseRows(app, uid, req.Categories.Exercise)
	}

	finishJob(app, jobID, uid, counts)
}

func setJobStatus(app core.App, jobID, status string) {
	job, err := app.FindRecordById("import_jobs", jobID)
	if err != nil {
		return
	}
	job.Set("status", status)
	_ = app.Save(job)
}

func finishJob(app core.App, jobID, uid string, counts map[string]categoryCount) {
	job, err := app.FindRecordById("import_jobs", jobID)
	if err != nil {
		return
	}
	job.Set("status", "done")
	job.Set("counts", counts)
	_ = app.Save(job)

	imported, skipped := 0, 0
	for _, c := range counts {
		imported += c.Imported
		skipped += c.Skipped
	}
	push.NotifyUser(app, uid, "Import complete", fmt.Sprintf("%d imported, %d skipped", imported, skipped))
}

func failJob(app core.App, jobID, uid, message string) {
	job, err := app.FindRecordById("import_jobs", jobID)
	if err != nil {
		return
	}
	job.Set("status", "failed")
	job.Set("error", message)
	_ = app.Save(job)

	push.NotifyUser(app, uid, "Import failed", message)
}

// ---------------------------------------------------------------------
// shared dedup helpers
// ---------------------------------------------------------------------

// externalID derives a stable per-row dedup key from the given parts, so
// re-running an import after a fresh LoseIt export doesn't create
// duplicate rows.
func externalID(parts ...string) string {
	h := sha256.Sum256([]byte(strings.Join(parts, "|")))
	return hex.EncodeToString(h[:])[:32]
}

// recordExists reports whether a row with the given (user, source,
// external_id) already exists in the collection.
func recordExists(app core.App, collection, uid, source, externalID string) bool {
	rec, err := app.FindFirstRecordByFilter(
		collection,
		"user = {:uid} && source = {:source} && external_id = {:eid}",
		map[string]any{"uid": uid, "source": source, "eid": externalID},
	)
	return err == nil && rec != nil
}

// ---------------------------------------------------------------------
// diary
// ---------------------------------------------------------------------

func importDiaryRows(app core.App, uid string, rows []diaryRow) categoryCount {
	var c categoryCount
	entriesCol, err := app.FindCollectionByNameOrId("diary_entries")
	if err != nil {
		c.Skipped += len(rows)
		return c
	}
	slotsByName := map[string]*core.Record{}

	for _, row := range rows {
		if row.Name == "" || row.Date == "" {
			c.Skipped++
			continue
		}
		loggedAt, err := time.Parse("2006-01-02", row.Date)
		if err != nil {
			c.Skipped++
			continue
		}

		eid := externalID(row.Date, row.Name, row.Meal, fmt.Sprintf("%g", row.Quantity), row.Unit, fmt.Sprintf("%g", row.Kcal))
		if recordExists(app, "diary_entries", uid, "import", eid) {
			c.Skipped++
			continue
		}

		slot, err := findOrCreateSlot(app, uid, row.Meal, slotsByName)
		if err != nil {
			c.Skipped++
			continue
		}

		grams := row.Quantity
		if strings.EqualFold(strings.TrimSpace(row.Unit), "serving") {
			grams = 0
		}

		rec := core.NewRecord(entriesCol)
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
		rec.Set("external_id", eid)

		if err := app.Save(rec); err != nil {
			c.Skipped++
			continue
		}
		c.Imported++
	}
	return c
}

// findOrCreateSlot resolves a meal slot by name (case-insensitive), creating
// it when missing. Results are cached per call.
func findOrCreateSlot(app core.App, uid, mealName string, cache map[string]*core.Record) (*core.Record, error) {
	name := strings.TrimSpace(mealName)
	if name == "" {
		name = "Other"
	}
	key := strings.ToLower(name)

	if slot, ok := cache[key]; ok {
		return slot, nil
	}

	slots, err := app.FindRecordsByFilter(
		"meal_slots",
		"user = {:uid} && name ~ {:name}",
		"sort_order", 0, 0,
		map[string]any{"uid": uid, "name": name},
	)
	if err != nil {
		return nil, err
	}
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

	existing, err := app.FindRecordsByFilter(
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

	col, err := app.FindCollectionByNameOrId("meal_slots")
	if err != nil {
		return nil, err
	}
	slot := core.NewRecord(col)
	slot.Set("user", uid)
	slot.Set("name", name)
	slot.Set("sort_order", nextSort)
	if err := app.Save(slot); err != nil {
		return nil, err
	}

	cache[key] = slot
	return slot, nil
}

// ---------------------------------------------------------------------
// weight
// ---------------------------------------------------------------------

func importWeightRows(app core.App, uid string, rows []weightRow) categoryCount {
	var c categoryCount
	col, err := app.FindCollectionByNameOrId("weights")
	if err != nil {
		c.Skipped += len(rows)
		return c
	}
	for _, row := range rows {
		if row.Date == "" || row.Kg <= 0 {
			c.Skipped++
			continue
		}
		measuredAt, err := time.Parse("2006-01-02", row.Date)
		if err != nil {
			c.Skipped++
			continue
		}
		measuredAtStr := measuredAt.UTC().Format("2006-01-02 15:04:05.000Z")

		if recordExistsByField(app, "weights", "user = {:uid} && source = {:source} && measured_at = {:d}",
			map[string]any{"uid": uid, "source": "loseit", "d": measuredAtStr}) {
			c.Skipped++
			continue
		}

		rec := core.NewRecord(col)
		rec.Set("user", uid)
		rec.Set("kg", row.Kg)
		rec.Set("measured_at", measuredAtStr)
		rec.Set("source", "loseit")
		if err := app.Save(rec); err != nil {
			c.Skipped++
			continue
		}
		c.Imported++
	}
	return c
}

// recordExistsByField is a lower-level dedup check for collections that
// don't use the (source, external_id) convention (e.g. weights, keyed by
// date instead).
func recordExistsByField(app core.App, collection, filter string, params map[string]any) bool {
	rec, err := app.FindFirstRecordByFilter(collection, filter, params)
	return err == nil && rec != nil
}

// ---------------------------------------------------------------------
// exercise
// ---------------------------------------------------------------------

func importExerciseRows(app core.App, uid string, rows []exerciseRow) categoryCount {
	var c categoryCount
	col, err := app.FindCollectionByNameOrId("exercise_entries")
	if err != nil {
		c.Skipped += len(rows)
		return c
	}
	for _, row := range rows {
		if row.Name == "" || row.Date == "" {
			c.Skipped++
			continue
		}
		loggedAt, err := time.Parse("2006-01-02", row.Date)
		if err != nil {
			c.Skipped++
			continue
		}

		eid := externalID(row.Date, row.Name, fmt.Sprintf("%g", row.Minutes), fmt.Sprintf("%g", row.Kcal))
		if recordExists(app, "exercise_entries", uid, "import", eid) {
			c.Skipped++
			continue
		}

		rec := core.NewRecord(col)
		rec.Set("user", uid)
		rec.Set("name", row.Name)
		rec.Set("minutes", row.Minutes)
		rec.Set("kcal", row.Kcal)
		rec.Set("logged_at", loggedAt.UTC().Format("2006-01-02 15:04:05.000Z"))
		rec.Set("source", "import")
		rec.Set("external_id", eid)
		if err := app.Save(rec); err != nil {
			c.Skipped++
			continue
		}
		c.Imported++
	}
	return c
}

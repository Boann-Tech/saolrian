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
	"log/slog"
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
		Diary    []diaryRow       `json:"diary"`
		Weight   []weightRow      `json:"weight"`
		Exercise []exerciseRow    `json:"exercise"`
		Foods    []foodRow        `json:"foods"`
		Recipes  []foodRow        `json:"recipes"`
		Steps    []dailyValueRow  `json:"steps"`
		Water    []dailyValueRow  `json:"water"`
		BodyFat  []dailyValueRow  `json:"body_fat"`
		Sleep    []dailyValueRow  `json:"sleep"`
		Profile  *profileSnapshot `json:"profile"`
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

	if hasActiveImportJob(e.App, uid) {
		return e.Error(http.StatusConflict, "an import is already running", nil)
	}

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
	if len(req.Categories.Foods) > 0 {
		names = append(names, "foods")
	}
	if len(req.Categories.Recipes) > 0 {
		names = append(names, "recipes")
	}
	if len(req.Categories.Steps) > 0 {
		names = append(names, "steps")
	}
	if len(req.Categories.Water) > 0 {
		names = append(names, "water")
	}
	if len(req.Categories.BodyFat) > 0 {
		names = append(names, "body_fat")
	}
	if len(req.Categories.Sleep) > 0 {
		names = append(names, "sleep")
	}
	if req.Categories.Profile != nil {
		names = append(names, "profile")
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
	if len(req.Categories.Foods) > 0 {
		counts["foods"] = importFoodCatalogRows(app, uid, req.Categories.Foods)
	}
	if len(req.Categories.Recipes) > 0 {
		counts["recipes"] = importFoodCatalogRows(app, uid, req.Categories.Recipes)
	}
	if len(req.Categories.Steps) > 0 {
		counts["steps"] = importDailyMetricRows(app, uid, "steps", req.Categories.Steps)
	}
	if len(req.Categories.Water) > 0 {
		counts["water"] = importDailyMetricRows(app, uid, "water_ml", req.Categories.Water)
	}
	if len(req.Categories.BodyFat) > 0 {
		counts["body_fat"] = importDailyMetricRows(app, uid, "body_fat_pct", req.Categories.BodyFat)
	}
	if len(req.Categories.Sleep) > 0 {
		counts["sleep"] = importDailyMetricRows(app, uid, "sleep_hours", req.Categories.Sleep)
	}
	if req.Categories.Profile != nil {
		counts["profile"] = importProfileSnapshot(app, uid, req.Categories.Profile)
	}

	finishJob(app, jobID, uid, counts)
}

func setJobStatus(app core.App, jobID, status string) {
	job, err := app.FindRecordById("import_jobs", jobID)
	if err != nil {
		return
	}
	job.Set("status", status)
	if err := app.Save(job); err != nil {
		app.Logger().Error("failed to update import job status",
			slog.String("jobId", jobID), slog.String("status", status), slog.String("error", err.Error()))
	}
}

func finishJob(app core.App, jobID, uid string, counts map[string]categoryCount) {
	job, err := app.FindRecordById("import_jobs", jobID)
	if err != nil {
		return
	}
	job.Set("status", "done")
	job.Set("counts", counts)
	if err := app.Save(job); err != nil {
		app.Logger().Error("failed to finish import job",
			slog.String("jobId", jobID), slog.String("userId", uid), slog.String("error", err.Error()))
	}

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
	if err := app.Save(job); err != nil {
		app.Logger().Error("failed to mark import job as failed",
			slog.String("jobId", jobID), slog.String("userId", uid), slog.String("error", err.Error()))
	}

	push.NotifyUser(app, uid, "Import failed", message)
}

// hasActiveImportJob reports whether the given user already has an
// import_jobs row in "queued" or "running" state. Used to reject a second
// concurrent import for the same user: runImportJob has no locking around
// its per-row find-then-save upserts (see importDailyMetricRows), so two
// jobs racing for the same user/date could otherwise violate a unique
// index or silently clobber each other's writes.
func hasActiveImportJob(app core.App, uid string) bool {
	existing, err := app.FindFirstRecordByFilter(
		"import_jobs",
		"user = {:uid} && (status = 'queued' || status = 'running')",
		map[string]any{"uid": uid},
	)
	return err == nil && existing != nil
}

// staleImportJobMessage is recorded on any import_jobs row still marked
// queued/running when SweepStaleImportJobs runs — such a row can only mean
// the process that owned it (and its goroutine) is gone, since a live
// backend is the only thing that ever advances a job out of these states.
const staleImportJobMessage = "interrupted by a server restart"

// SweepStaleImportJobs marks every import_jobs row still in "queued" or
// "running" as "failed". It's meant to run once on app startup: those
// states are only ever driven forward by runImportJob's goroutine, so a
// row stuck in one of them across a restart/crash would otherwise show as
// permanently in-progress in the UI forever.
func SweepStaleImportJobs(app core.App) error {
	stale, err := app.FindRecordsByFilter(
		"import_jobs", "status = 'queued' || status = 'running'",
		"", 0, 0, nil,
	)
	if err != nil {
		return err
	}

	for _, job := range stale {
		job.Set("status", "failed")
		job.Set("error", staleImportJobMessage)
		if err := app.Save(job); err != nil {
			app.Logger().Error("failed to mark stale import job as failed",
				slog.String("jobId", job.Id), slog.String("error", err.Error()))
		}
	}
	return nil
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
		if row.Name == "" || row.Date == "" || row.Quantity < 0 ||
			row.Kcal < 0 || row.ProteinG < 0 || row.CarbsG < 0 || row.FatG < 0 {
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
		if row.Name == "" || row.Date == "" || row.Minutes < 0 {
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

// ---------------------------------------------------------------------
// foods / recipes
// ---------------------------------------------------------------------

// foodRow is one row from either custom-foods.csv (gram-measured, has a
// Brand) or recipes.csv (serving-measured, no Brand) — both land in the
// foods catalog.
type foodRow struct {
	Name     string  `json:"name"`
	UniqueID string  `json:"unique_id"`
	Brand    string  `json:"brand"`
	Quantity float64 `json:"quantity"`
	Measure  string  `json:"measure"`
	Kcal     float64 `json:"kcal"`
	ProteinG float64 `json:"protein_g"`
	CarbsG   float64 `json:"carbs_g"`
	FatG     float64 `json:"fat_g"`
}

// importFoodCatalogRows normalizes gram-measured rows to kcal-per-100g
// directly, and serving-measured rows (all recipes, and any non-gram
// custom food) to "1 serving = 100g" — matching this app's existing
// default-serving convention (backend/internal/routes/food.go:283-284) so
// logging "1 serving" of an imported recipe reproduces its per-serving
// macros exactly.
func importFoodCatalogRows(app core.App, uid string, rows []foodRow) categoryCount {
	var c categoryCount
	col, err := app.FindCollectionByNameOrId("foods")
	if err != nil {
		c.Skipped += len(rows)
		return c
	}
	for _, row := range rows {
		if row.Name == "" || row.UniqueID == "" || row.Quantity <= 0 ||
			row.Kcal < 0 || row.ProteinG < 0 || row.CarbsG < 0 || row.FatG < 0 {
			c.Skipped++
			continue
		}

		if recordExistsByField(app, "foods", "user = {:uid} && source = {:source} && source_id = {:sid}",
			map[string]any{"uid": uid, "source": "loseit", "sid": row.UniqueID}) {
			c.Skipped++
			continue
		}

		var kcalPer100g, proteinPer100g, carbsPer100g, fatPer100g, defaultServingG float64
		if strings.EqualFold(strings.TrimSpace(row.Measure), "grams") {
			scale := 100.0 / row.Quantity
			kcalPer100g = row.Kcal * scale
			proteinPer100g = row.ProteinG * scale
			carbsPer100g = row.CarbsG * scale
			fatPer100g = row.FatG * scale
		} else {
			kcalPer100g = row.Kcal / row.Quantity
			proteinPer100g = row.ProteinG / row.Quantity
			carbsPer100g = row.CarbsG / row.Quantity
			fatPer100g = row.FatG / row.Quantity
			defaultServingG = 100
		}

		rec := core.NewRecord(col)
		rec.Set("user", uid)
		rec.Set("name", row.Name)
		if row.Brand != "" {
			rec.Set("brand", row.Brand)
		}
		rec.Set("kcal_per_100g", kcalPer100g)
		rec.Set("protein_per_100g", proteinPer100g)
		rec.Set("carbs_per_100g", carbsPer100g)
		rec.Set("fat_per_100g", fatPer100g)
		if defaultServingG > 0 {
			rec.Set("default_serving_g", defaultServingG)
		}
		rec.Set("source", "loseit")
		rec.Set("source_id", row.UniqueID)

		if err := app.Save(rec); err != nil {
			c.Skipped++
			continue
		}
		c.Imported++
	}
	return c
}

// ---------------------------------------------------------------------
// daily metrics (steps / water / body fat / sleep)
// ---------------------------------------------------------------------

// dailyValueRow is one row from any of steps.csv, water-intake.csv,
// body-fat.csv or sleep-hours.csv — all share a Date+Value shape and land
// as a single field on the same per-user-per-day daily_metrics row.
type dailyValueRow struct {
	Date  string  `json:"date"`
	Value float64 `json:"value"`
}

// importDailyMetricRows upserts by (user, date): re-importing simply
// overwrites that day's value for the given field, which is the natural
// idempotent behavior for a per-day metric (last import wins).
func importDailyMetricRows(app core.App, uid, field string, rows []dailyValueRow) categoryCount {
	var c categoryCount
	col, err := app.FindCollectionByNameOrId("daily_metrics")
	if err != nil {
		c.Skipped += len(rows)
		return c
	}
	for _, row := range rows {
		if row.Date == "" {
			c.Skipped++
			continue
		}
		d, err := time.Parse("2006-01-02", row.Date)
		if err != nil {
			c.Skipped++
			continue
		}
		dateStr := d.UTC().Format("2006-01-02 15:04:05.000Z")

		rec, err := app.FindFirstRecordByFilter(
			"daily_metrics", "user = {:uid} && date = {:d}",
			map[string]any{"uid": uid, "d": dateStr},
		)
		if err != nil || rec == nil {
			rec = core.NewRecord(col)
			rec.Set("user", uid)
			rec.Set("date", dateStr)
		}
		rec.Set(field, row.Value)
		if rec.GetString("source") == "" {
			rec.Set("source", "loseit")
		}
		if err := app.Save(rec); err != nil {
			c.Skipped++
			continue
		}
		c.Imported++
	}
	return c
}

// ---------------------------------------------------------------------
// profile snapshot
// ---------------------------------------------------------------------

// profileSnapshot is profile.csv's key/value pairs, already normalized by
// the frontend parser to this app's enum values (sex/goal/activity_level)
// — the backend just applies whichever fields are non-empty/non-zero,
// since it's a one-time overwrite of current settings, not a log.
type profileSnapshot struct {
	BirthYear     float64 `json:"birth_year"`
	Sex           string  `json:"sex"`
	HeightCM      float64 `json:"height_cm"`
	CalorieTarget float64 `json:"calorie_target"`
	Goal          string  `json:"goal"`
	ActivityLevel string  `json:"activity_level"`
}

func importProfileSnapshot(app core.App, uid string, snap *profileSnapshot) categoryCount {
	profile, err := app.FindFirstRecordByFilter("profiles", "user = {:uid}", map[string]any{"uid": uid})
	if err != nil {
		return categoryCount{Skipped: 1}
	}
	if snap.BirthYear > 0 {
		profile.Set("birth_year", snap.BirthYear)
	}
	if snap.Sex != "" {
		profile.Set("sex", snap.Sex)
	}
	if snap.HeightCM > 0 {
		profile.Set("height_cm", snap.HeightCM)
	}
	if snap.CalorieTarget > 0 {
		profile.Set("calorie_target", snap.CalorieTarget)
	}
	if snap.Goal != "" {
		profile.Set("goal", snap.Goal)
	}
	if snap.ActivityLevel != "" {
		profile.Set("activity_level", snap.ActivityLevel)
	}
	if err := app.Save(profile); err != nil {
		return categoryCount{Skipped: 1}
	}
	return categoryCount{Imported: 1}
}

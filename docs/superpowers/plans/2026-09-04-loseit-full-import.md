# LoseIt Full Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user upload a single LoseIt export zip, pick which of the ten supported categories to import, and have the import run as a server-side background job that notifies them via Web Push (and an in-app toast/realtime update) when it finishes — even if they've closed the app.

**Architecture:** Frontend unzips and parses the export entirely client-side (matching the app's existing "parse client-side, send JSON" pattern — no new file-upload backend surface). The backend receives a per-category JSON payload, creates an `import_jobs` record, and processes it on a detached goroutine with per-row dedup so re-imports are idempotent; on completion it updates the job record (observed live via PocketBase's built-in realtime subscriptions) and sends a Web Push notification via stored subscriptions and VAPID keys.

**Tech Stack:** Go 1.27 + PocketBase v0.40.2 (backend), React 19 + TypeScript + Vite 6 + vitest 3 (frontend), fflate (zip), SherClockHolmes/webpush-go (Web Push/VAPID), workbox (custom service worker).

**Spec:** [docs/superpowers/specs/2026-09-04-loseit-full-import-design.md](../specs/2026-09-04-loseit-full-import-design.md)

## Global Constraints

- Go module: `github.com/boanntech/saolrian/backend`, Go 1.27, PocketBase v0.40.2 — do not bump PocketBase as part of this work.
- New Go dependency `github.com/SherClockHolmes/webpush-go` (MIT licensed) — add via `go get`, do not hand-pin a version in `go.mod`.
- New frontend dependency `fflate` (MIT licensed, ~8KB) for client-side zip reading.
- New frontend devDependencies `workbox-precaching`, `workbox-routing`, `workbox-strategies`, `workbox-expiration` (Apache-2.0, Google Workbox) — required once `vite-plugin-pwa` switches to the `injectManifest` strategy, since that strategy's custom service worker must import Workbox's runtime packages directly instead of relying on the plugin's bundled ones.
- All new PocketBase collections use the existing owner-scoped rule pattern: `user = @request.auth.id` on every CRUD rule (the `ownerRule` constant in `backend/internal/migrations/migrations.go:204`).
- All dates sent from frontend to backend must be `YYYY-MM-DD` (Go parses with `time.Parse("2006-01-02", ...)` throughout) — LoseIt CSVs use `MM/DD/YYYY`, so every parser must convert.
- `VAPID_PRIVATE_KEY` must only ever live in an environment variable — never logged, never committed. When VAPID env vars are unset, push must no-op gracefully everywhere (self-hosted deployments without push configured still get a fully working import).
- New/changed backend endpoints handle user-uploaded (untrusted) data written to the database — validate required fields (non-empty names/dates, positive quantities) before insert, per the existing importer's pattern.

---

## Pre-existing bug found during planning

While tracing the date pipeline for the new parsers, the existing importer
turned out to be broken: `frontend/src/lib/loseit.ts`'s `parseLoseItCsv`
passes LoseIt's `MM/DD/YYYY` date strings straight through, but
`backend/internal/routes/import_loseit.go:54` parses with
`time.Parse("2006-01-02", row.Date)`, which errors (and thus skips every
row) for any non-ISO date. Task 6 below fixes this with a shared
`toIsoDate` helper and applies it retroactively to `parseLoseItCsv` too,
since all the new parsers need it working and it's the same code path.

---

### Task 1: Migration — new collections and fields

**Files:**
- Create: `backend/internal/migrations/loseit_import.go`
- Test: `backend/internal/migrations/loseit_import_test.go`

**Interfaces:**
- Produces: collections `exercise_entries` (fields: `user`, `name`, `minutes`, `kcal`, `logged_at`, `source`, `external_id`), `import_jobs` (fields: `user`, `status`, `categories`, `counts`, `error`, `created`, `updated`), `push_subscriptions` (fields: `user`, `endpoint`, `p256dh`, `auth`, `created`); `daily_metrics` gains `sleep_hours` and `body_fat_pct`; `foods` gains a second partial unique index for `source = 'loseit'`. All of Task 2 onward depend on these existing.

- [ ] **Step 1: Write the failing migration test**

```go
// backend/internal/migrations/loseit_import_test.go
package migrations_test

import (
	"testing"

	_ "github.com/boanntech/saolrian/backend/internal/migrations"
	"github.com/pocketbase/pocketbase/tests"
)

func TestLoseitImportMigration(t *testing.T) {
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	defer app.Cleanup()

	if err := app.RunAppMigrations(); err != nil {
		t.Fatalf("failed to run app migrations: %v", err)
	}

	for _, name := range []string{"exercise_entries", "import_jobs", "push_subscriptions"} {
		if _, err := app.FindCollectionByNameOrId(name); err != nil {
			t.Errorf("expected collection %q to exist: %v", name, err)
		}
	}

	metrics, err := app.FindCollectionByNameOrId("daily_metrics")
	if err != nil {
		t.Fatalf("daily_metrics collection missing: %v", err)
	}
	for _, field := range []string{"sleep_hours", "body_fat_pct"} {
		if metrics.Fields.GetByName(field) == nil {
			t.Errorf("expected daily_metrics to have field %q", field)
		}
	}

	foods, err := app.FindCollectionByNameOrId("foods")
	if err != nil {
		t.Fatalf("foods collection missing: %v", err)
	}
	if foods.GetIndex("idx_foods_source_sourceId_loseit") == "" {
		t.Error("expected foods to have the loseit dedup index")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && go test ./internal/migrations/... -run TestLoseitImportMigration -v`
Expected: FAIL — the referenced collections/fields/index don't exist yet.

- [ ] **Step 3: Write the migration**

```go
// backend/internal/migrations/loseit_import.go
//
// Adds the collections and fields needed to import a full LoseIt export:
// exercise logs (no prior home), a background job record so imports can
// run async and be observed via realtime, push subscriptions for
// completion notifications, and two additive fields on daily_metrics plus
// a second dedup index on foods for LoseIt-sourced rows.
package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
	"github.com/pocketbase/pocketbase/tools/types"
)

func init() {
	m.Register(func(app core.App) error {
		users, err := app.FindCollectionByNameOrId("users")
		if err != nil {
			return err
		}

		// ---------------------------------------------------------------
		// exercise_entries
		// ---------------------------------------------------------------
		exercise := core.NewBaseCollection("exercise_entries")
		exercise.ListRule = types.Pointer(ownerRule)
		exercise.ViewRule = types.Pointer(ownerRule)
		exercise.CreateRule = types.Pointer(ownerRule)
		exercise.UpdateRule = types.Pointer(ownerRule)
		exercise.DeleteRule = types.Pointer(ownerRule)

		exercise.Fields.Add(
			&core.RelationField{Name: "user", CollectionId: users.Id, Required: true, MaxSelect: 1},
			&core.TextField{Name: "name", Required: true},
			&core.NumberField{Name: "minutes", Min: types.Pointer(0.0)},
			&core.NumberField{Name: "kcal", Required: true},
			&core.DateField{Name: "logged_at", Required: true},
			&core.SelectField{Name: "source", Values: []string{"manual", "import"}, MaxSelect: 1},
			&core.TextField{Name: "external_id"},
		)
		exercise.AddIndex("idx_exercise_user_loggedAt", false, "user, logged_at", "")
		exercise.AddIndex("idx_exercise_dedup", true, "user, source, external_id", "external_id != ''")
		if err := app.Save(exercise); err != nil {
			return err
		}

		// ---------------------------------------------------------------
		// import_jobs
		// ---------------------------------------------------------------
		jobs := core.NewBaseCollection("import_jobs")
		jobs.ListRule = types.Pointer(ownerRule)
		jobs.ViewRule = types.Pointer(ownerRule)
		jobs.CreateRule = types.Pointer(ownerRule)
		jobs.UpdateRule = types.Pointer(ownerRule)
		jobs.DeleteRule = types.Pointer(ownerRule)

		jobs.Fields.Add(
			&core.RelationField{Name: "user", CollectionId: users.Id, Required: true, MaxSelect: 1},
			&core.SelectField{Name: "status", Values: []string{"queued", "running", "done", "failed"}, Required: true, MaxSelect: 1},
			&core.JSONField{Name: "categories", MaxSize: 4096},
			&core.JSONField{Name: "counts", MaxSize: 4096},
			&core.TextField{Name: "error"},
			&core.AutodateField{Name: "created", OnCreate: true},
			&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
		)
		if err := app.Save(jobs); err != nil {
			return err
		}

		// ---------------------------------------------------------------
		// push_subscriptions
		// ---------------------------------------------------------------
		subs := core.NewBaseCollection("push_subscriptions")
		subs.ListRule = types.Pointer(ownerRule)
		subs.ViewRule = types.Pointer(ownerRule)
		subs.CreateRule = types.Pointer(ownerRule)
		subs.UpdateRule = types.Pointer(ownerRule)
		subs.DeleteRule = types.Pointer(ownerRule)

		subs.Fields.Add(
			&core.RelationField{Name: "user", CollectionId: users.Id, Required: true, MaxSelect: 1},
			&core.TextField{Name: "endpoint", Required: true},
			&core.TextField{Name: "p256dh", Required: true},
			&core.TextField{Name: "auth", Required: true},
			&core.AutodateField{Name: "created", OnCreate: true},
		)
		subs.AddIndex("idx_push_subs_user_endpoint", true, "user, endpoint", "")
		if err := app.Save(subs); err != nil {
			return err
		}

		// ---------------------------------------------------------------
		// daily_metrics: sleep_hours + body_fat_pct
		// ---------------------------------------------------------------
		metrics, err := app.FindCollectionByNameOrId("daily_metrics")
		if err != nil {
			return err
		}
		metrics.Fields.Add(
			&core.NumberField{Name: "sleep_hours", Min: types.Pointer(0.0)},
			&core.NumberField{Name: "body_fat_pct", Min: types.Pointer(0.0)},
		)
		if err := app.Save(metrics); err != nil {
			return err
		}

		// ---------------------------------------------------------------
		// foods: dedup index for LoseIt-sourced rows
		// ---------------------------------------------------------------
		foods, err := app.FindCollectionByNameOrId("foods")
		if err != nil {
			return err
		}
		foods.AddIndex("idx_foods_source_sourceId_loseit", true, "source, source_id",
			"source = 'loseit' AND source_id != ''")
		return app.Save(foods)
	}, func(app core.App) error {
		for _, name := range []string{"push_subscriptions", "import_jobs", "exercise_entries"} {
			col, err := app.FindCollectionByNameOrId(name)
			if err != nil {
				continue
			}
			if err := app.Delete(col); err != nil {
				return err
			}
		}

		if foods, err := app.FindCollectionByNameOrId("foods"); err == nil {
			foods.RemoveIndex("idx_foods_source_sourceId_loseit")
			if err := app.Save(foods); err != nil {
				return err
			}
		}

		if metrics, err := app.FindCollectionByNameOrId("daily_metrics"); err == nil {
			metrics.Fields.RemoveByName("sleep_hours")
			metrics.Fields.RemoveByName("body_fat_pct")
			if err := app.Save(metrics); err != nil {
				return err
			}
		}

		return nil
	}, "saolrian_loseit_import.go")
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && go test ./internal/migrations/... -run TestLoseitImportMigration -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/internal/migrations/loseit_import.go backend/internal/migrations/loseit_import_test.go
git commit -m "feat: add collections for LoseIt exercise/job/push-subscription import support"
```

---

### Task 2: Backend — async import job scaffolding + diary/weight/exercise categories

**Files:**
- Modify: `backend/internal/routes/import_loseit.go` (full rewrite)
- Test: `backend/internal/routes/import_loseit_test.go`

**Interfaces:**
- Consumes: collections from Task 1 (`import_jobs`, `exercise_entries`) plus existing `diary_entries`, `weights`, `meal_slots`.
- Produces: `POST /api/saolrian/import/loseit` now returns `202 {"job_id": string}` instead of `200 {"imported","skipped"}`. Exported (package-level, used by Task 3/4/5): `type categoryCount struct { Imported int; Skipped int }`, `func externalID(parts ...string) string`, `func recordExists(app core.App, collection, uid, source, externalID string) bool`, `func setJobStatus(app core.App, jobID, status string)`, `func finishJob(app core.App, jobID, uid string, counts map[string]categoryCount)`, `func failJob(app core.App, jobID, uid, message string)`. Task 3/4/5 add cases to `runImportJob`'s dispatch and fields to `loseItRequest.Categories`.

- [ ] **Step 1: Write the failing test**

```go
// backend/internal/routes/import_loseit_test.go
package routes

import (
	"testing"
	"time"

	_ "github.com/boanntech/saolrian/backend/internal/migrations"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

func newTestAppWithUser(t *testing.T) (*tests.TestApp, *core.Record) {
	t.Helper()
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)
	if err := app.RunAppMigrations(); err != nil {
		t.Fatalf("failed to run migrations: %v", err)
	}

	usersCol, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatalf("users collection missing: %v", err)
	}
	user := core.NewRecord(usersCol)
	user.SetEmail("import-test@example.com")
	user.SetPassword("test-password-123")
	if err := app.Save(user); err != nil {
		t.Fatalf("failed to create test user: %v", err)
	}
	return app, user
}

func waitForJobStatus(t *testing.T, app core.App, jobID string, want string) *core.Record {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		job, err := app.FindRecordById("import_jobs", jobID)
		if err == nil && (job.GetString("status") == want) {
			return job
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("job %s did not reach status %q in time", jobID, want)
	return nil
}

func TestImportDiaryRows_DedupsOnReimport(t *testing.T) {
	app, user := newTestAppWithUser(t)

	rows := []diaryRow{
		{Date: "2023-05-02", Name: "Toast", Quantity: 1, Unit: "serving", Meal: "Breakfast", Kcal: 200, ProteinG: 5, CarbsG: 30, FatG: 4},
	}

	first := importDiaryRows(app, user.Id, rows)
	if first.Imported != 1 || first.Skipped != 0 {
		t.Fatalf("first import: got %+v, want 1 imported, 0 skipped", first)
	}

	second := importDiaryRows(app, user.Id, rows)
	if second.Imported != 0 || second.Skipped != 1 {
		t.Fatalf("re-import: got %+v, want 0 imported, 1 skipped", second)
	}
}

func TestImportWeightRows_DedupsOnReimport(t *testing.T) {
	app, user := newTestAppWithUser(t)

	rows := []weightRow{{Date: "2023-05-02", Kg: 91.5}}

	first := importWeightRows(app, user.Id, rows)
	if first.Imported != 1 {
		t.Fatalf("first import: got %+v, want 1 imported", first)
	}
	second := importWeightRows(app, user.Id, rows)
	if second.Skipped != 1 {
		t.Fatalf("re-import: got %+v, want 1 skipped", second)
	}
}

func TestImportExerciseRows_DedupsOnReimport(t *testing.T) {
	app, user := newTestAppWithUser(t)

	rows := []exerciseRow{{Date: "2023-05-05", Name: "Run", Minutes: 30, Kcal: 250}}

	first := importExerciseRows(app, user.Id, rows)
	if first.Imported != 1 {
		t.Fatalf("first import: got %+v, want 1 imported", first)
	}
	second := importExerciseRows(app, user.Id, rows)
	if second.Skipped != 1 {
		t.Fatalf("re-import: got %+v, want 1 skipped", second)
	}
}

func TestLoseItImportHandler_CreatesJobAndProcessesAsync(t *testing.T) {
	app, user := newTestAppWithUser(t)

	req := loseItRequest{}
	req.Categories.Diary = []diaryRow{
		{Date: "2023-05-02", Name: "Toast", Quantity: 1, Unit: "serving", Meal: "Breakfast", Kcal: 200},
	}

	jobsCol, err := app.FindCollectionByNameOrId("import_jobs")
	if err != nil {
		t.Fatalf("import_jobs collection missing: %v", err)
	}
	job := core.NewRecord(jobsCol)
	job.Set("user", user.Id)
	job.Set("status", "queued")
	job.Set("categories", requestedCategories(req))
	job.Set("counts", map[string]any{})
	if err := app.Save(job); err != nil {
		t.Fatalf("failed to seed job: %v", err)
	}

	go runImportJob(app, job.Id, user.Id, req)

	done := waitForJobStatus(t, app, job.Id, "done")
	entries, err := app.FindRecordsByFilter("diary_entries", "user = {:uid}", "", 0, 0, map[string]any{"uid": user.Id})
	if err != nil || len(entries) != 1 {
		t.Fatalf("expected 1 diary entry, got %d (err=%v)", len(entries), err)
	}
	_ = done
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && go test ./internal/routes/... -run "TestImportDiaryRows|TestImportWeightRows|TestImportExerciseRows|TestLoseItImportHandler" -v`
Expected: FAIL to compile — `diaryRow`, `weightRow`, `exerciseRow`, `importDiaryRows`, `importWeightRows`, `importExerciseRows`, `runImportJob`, `requestedCategories` don't exist with these shapes yet.

- [ ] **Step 3: Rewrite the handler**

```go
// backend/internal/routes/import_loseit.go
//
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
```

Note: this step forward-references `push.NotifyUser`, built in Task 5. Until Task 5 exists, add a temporary placeholder so Task 2 compiles and its own tests (which don't exercise the push path meaningfully) pass:

```go
// backend/internal/push/push.go (temporary — replaced by Task 5)
package push

import "github.com/pocketbase/pocketbase/core"

func NotifyUser(app core.App, uid, title, body string) {}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && go test ./internal/routes/... -run "TestImportDiaryRows|TestImportWeightRows|TestImportExerciseRows|TestLoseItImportHandler" -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/internal/routes/import_loseit.go backend/internal/routes/import_loseit_test.go backend/internal/push/push.go
git commit -m "feat: run LoseIt import as an async job with per-row dedup (diary/weight/exercise)"
```

---

### Task 3: Backend — foods and recipes categories

**Files:**
- Modify: `backend/internal/routes/import_loseit.go`
- Modify: `backend/internal/routes/import_loseit_test.go`

**Interfaces:**
- Consumes: `categoryCount`, `recordExists`, `externalID` from Task 2.
- Produces: `type foodRow struct{...}`, `func importFoodCatalogRows(app core.App, uid string, rows []foodRow) categoryCount`, used for both the `foods` and `recipes` request keys (same shape, same destination collection `foods`, differing only in whether `Brand` is populated).

- [ ] **Step 1: Write the failing test**

```go
// append to backend/internal/routes/import_loseit_test.go

func TestImportFoodCatalogRows_GramsAndServings(t *testing.T) {
	app, user := newTestAppWithUser(t)

	rows := []foodRow{
		// gram-measured (typical custom-foods.csv row)
		{Name: "Black Bean Sauce", UniqueID: "abc123", Brand: "WAI MAI", Quantity: 500, Measure: "Grams", Kcal: 300, ProteinG: 10, CarbsG: 40, FatG: 5},
		// serving-measured (typical recipes.csv row: totals for N servings)
		{Name: "Chicken Satay", UniqueID: "def456", Quantity: 6, Measure: "Serving", Kcal: 900, ProteinG: 240, CarbsG: 60, FatG: 120},
	}

	result := importFoodCatalogRows(app, user.Id, rows)
	if result.Imported != 2 || result.Skipped != 0 {
		t.Fatalf("got %+v, want 2 imported, 0 skipped", result)
	}

	gram, err := app.FindFirstRecordByFilter("foods", "source_id = {:sid}", map[string]any{"sid": "abc123"})
	if err != nil {
		t.Fatalf("gram-measured food not found: %v", err)
	}
	if got, want := gram.GetFloat("kcal_per_100g"), 60.0; got != want {
		t.Errorf("kcal_per_100g = %v, want %v", got, want)
	}

	serving, err := app.FindFirstRecordByFilter("foods", "source_id = {:sid}", map[string]any{"sid": "def456"})
	if err != nil {
		t.Fatalf("serving-measured food not found: %v", err)
	}
	if got, want := serving.GetFloat("kcal_per_100g"), 150.0; got != want {
		t.Errorf("kcal_per_100g = %v, want %v (900/6 kcal per serving)", got, want)
	}
	if got, want := serving.GetFloat("default_serving_g"), 100.0; got != want {
		t.Errorf("default_serving_g = %v, want %v", got, want)
	}

	// re-import is a no-op (same UniqueId)
	again := importFoodCatalogRows(app, user.Id, rows)
	if again.Skipped != 2 {
		t.Fatalf("re-import: got %+v, want 2 skipped", again)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && go test ./internal/routes/... -run TestImportFoodCatalogRows -v`
Expected: FAIL to compile — `foodRow`/`importFoodCatalogRows` don't exist.

- [ ] **Step 3: Add the foods/recipes category**

Add to `loseItRequest.Categories`:

```go
type loseItRequest struct {
	Categories struct {
		Diary    []diaryRow    `json:"diary"`
		Weight   []weightRow   `json:"weight"`
		Exercise []exerciseRow `json:"exercise"`
		Foods    []foodRow     `json:"foods"`
		Recipes  []foodRow     `json:"recipes"`
	} `json:"categories"`
}
```

Add to `requestedCategories`:

```go
	if len(req.Categories.Foods) > 0 {
		names = append(names, "foods")
	}
	if len(req.Categories.Recipes) > 0 {
		names = append(names, "recipes")
	}
```

Add to `runImportJob`, after the exercise block:

```go
	if len(req.Categories.Foods) > 0 {
		counts["foods"] = importFoodCatalogRows(app, uid, req.Categories.Foods)
	}
	if len(req.Categories.Recipes) > 0 {
		counts["recipes"] = importFoodCatalogRows(app, uid, req.Categories.Recipes)
	}
```

Add the new type and function (custom-foods.csv and recipes.csv share this shape and this destination):

```go
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
		if row.Name == "" || row.UniqueID == "" || row.Quantity <= 0 {
			c.Skipped++
			continue
		}

		if recordExistsByField(app, "foods", "source = {:source} && source_id = {:sid}",
			map[string]any{"source": "loseit", "sid": row.UniqueID}) {
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && go test ./internal/routes/... -run TestImportFoodCatalogRows -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/internal/routes/import_loseit.go backend/internal/routes/import_loseit_test.go
git commit -m "feat: import LoseIt custom foods and recipes into the foods catalog"
```

---

### Task 4: Backend — daily metrics (steps/water/body fat/sleep) and profile snapshot

**Files:**
- Modify: `backend/internal/routes/import_loseit.go`
- Modify: `backend/internal/routes/import_loseit_test.go`

**Interfaces:**
- Consumes: `categoryCount`, `recordExistsByField` from Task 2/3.
- Produces: `type dailyValueRow struct{...}`, `func importDailyMetricRows(app core.App, uid, field string, rows []dailyValueRow) categoryCount`; `type profileSnapshot struct{...}`, `func importProfileSnapshot(app core.App, uid string, snap *profileSnapshot) categoryCount`. Task 8/9 (frontend) must send `sex`/`goal`/`activity_level` already mapped to this app's enum values — the backend applies them as-is.

- [ ] **Step 1: Write the failing test**

```go
// append to backend/internal/routes/import_loseit_test.go

func TestImportDailyMetricRows_UpsertsByDate(t *testing.T) {
	app, user := newTestAppWithUser(t)

	rows := []dailyValueRow{{Date: "2026-04-04", Value: 8416}}
	result := importDailyMetricRows(app, user.Id, "steps", rows)
	if result.Imported != 1 {
		t.Fatalf("got %+v, want 1 imported", result)
	}

	// importing body_fat for the same date updates the same row rather
	// than creating a second one
	importDailyMetricRows(app, user.Id, "body_fat_pct", []dailyValueRow{{Date: "2026-04-04", Value: 22.5}})

	rec, err := app.FindFirstRecordByFilter("daily_metrics", "user = {:uid} && date = {:d}",
		map[string]any{"uid": user.Id, "d": "2026-04-04 00:00:00.000Z"})
	if err != nil {
		t.Fatalf("expected a daily_metrics row: %v", err)
	}
	if got := rec.GetFloat("steps"); got != 8416 {
		t.Errorf("steps = %v, want 8416", got)
	}
	if got := rec.GetFloat("body_fat_pct"); got != 22.5 {
		t.Errorf("body_fat_pct = %v, want 22.5", got)
	}
}

func TestImportProfileSnapshot_AppliesOnlyProvidedFields(t *testing.T) {
	app, user := newTestAppWithUser(t)

	snap := &profileSnapshot{HeightCM: 178, Sex: "male", Goal: "maintain", ActivityLevel: "moderate"}
	result := importProfileSnapshot(app, user.Id, snap)
	if result.Imported != 1 {
		t.Fatalf("got %+v, want 1 imported", result)
	}

	profile, err := app.FindFirstRecordByFilter("profiles", "user = {:uid}", map[string]any{"uid": user.Id})
	if err != nil {
		t.Fatalf("profile not found: %v", err)
	}
	if got := profile.GetFloat("height_cm"); got != 178 {
		t.Errorf("height_cm = %v, want 178", got)
	}
	if got := profile.GetString("sex"); got != "male" {
		t.Errorf("sex = %v, want male", got)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && go test ./internal/routes/... -run "TestImportDailyMetricRows|TestImportProfileSnapshot" -v`
Expected: FAIL to compile.

- [ ] **Step 3: Add the categories**

Add to `loseItRequest.Categories`:

```go
type loseItRequest struct {
	Categories struct {
		Diary         []diaryRow        `json:"diary"`
		Weight        []weightRow       `json:"weight"`
		Exercise      []exerciseRow     `json:"exercise"`
		Foods         []foodRow         `json:"foods"`
		Recipes       []foodRow         `json:"recipes"`
		Steps         []dailyValueRow   `json:"steps"`
		Water         []dailyValueRow   `json:"water"`
		BodyFat       []dailyValueRow   `json:"body_fat"`
		Sleep         []dailyValueRow   `json:"sleep"`
		Profile       *profileSnapshot  `json:"profile"`
	} `json:"categories"`
}
```

Add to `requestedCategories`:

```go
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
```

Add to `runImportJob`, after the recipes block:

```go
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
```

Add the new types and functions:

```go
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && go test ./internal/routes/... -run "TestImportDailyMetricRows|TestImportProfileSnapshot" -v`
Expected: PASS

- [ ] **Step 5: Run the full backend test suite to catch regressions**

Run: `cd backend && go build ./... && go test ./... -v`
Expected: PASS (all tests, including Tasks 1-3's)

- [ ] **Step 6: Commit**

```bash
git add backend/internal/routes/import_loseit.go backend/internal/routes/import_loseit_test.go
git commit -m "feat: import LoseIt steps/water/body-fat/sleep and profile snapshot"
```

---

### Task 5: Backend — Web Push (VAPID) subscribe/unsubscribe + real send

**Files:**
- Create: `backend/internal/push/push.go` (replaces Task 2's placeholder)
- Create: `backend/internal/routes/push.go`
- Modify: `backend/internal/routes/summary.go:24` (register the three new routes)
- Create: `backend/internal/push/push_test.go`
- Modify: `backend/go.mod` / `backend/go.sum` (new dependency)

**Interfaces:**
- Consumes: `push_subscriptions` collection from Task 1; called by `finishJob`/`failJob` in Task 2's `import_loseit.go` (already written against this exact signature).
- Produces: `func push.Enabled() bool`, `func push.PublicKey() string`, `func push.NotifyUser(app core.App, uid, title, body string)`.

- [ ] **Step 1: Add the dependency**

Run: `cd backend && go get github.com/SherClockHolmes/webpush-go@latest`
Expected: `go.mod`/`go.sum` updated with a pinned version (do not hand-edit the version).

- [ ] **Step 2: Write the failing test**

```go
// backend/internal/push/push_test.go
package push

import "testing"

func TestEnabled_FalseWhenVapidUnset(t *testing.T) {
	t.Setenv("VAPID_PUBLIC_KEY", "")
	t.Setenv("VAPID_PRIVATE_KEY", "")
	if Enabled() {
		t.Error("expected Enabled() to be false when VAPID env vars are unset")
	}
}

func TestEnabled_TrueWhenVapidSet(t *testing.T) {
	t.Setenv("VAPID_PUBLIC_KEY", "pub")
	t.Setenv("VAPID_PRIVATE_KEY", "priv")
	if !Enabled() {
		t.Error("expected Enabled() to be true when both VAPID env vars are set")
	}
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd backend && go test ./internal/push/... -v`
Expected: FAIL to compile — `Enabled` doesn't exist yet (the Task 2 placeholder only has `NotifyUser`).

- [ ] **Step 4: Write the real push package**

```go
// backend/internal/push/push.go
//
// Package push sends Web Push notifications to a user's stored browser
// subscriptions using VAPID authentication. When VAPID keys aren't
// configured (self-hosted deployments that skip push setup), every
// function here is a safe no-op — the import itself still works via
// in-app realtime updates and toasts.
package push

import (
	"encoding/json"
	"log/slog"
	"os"

	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/pocketbase/pocketbase/core"
)

type notificationPayload struct {
	Title string `json:"title"`
	Body  string `json:"body"`
}

// Enabled reports whether VAPID keys are configured.
func Enabled() bool {
	return os.Getenv("VAPID_PUBLIC_KEY") != "" && os.Getenv("VAPID_PRIVATE_KEY") != ""
}

// PublicKey returns the configured VAPID public key, or "" if unset.
func PublicKey() string {
	return os.Getenv("VAPID_PUBLIC_KEY")
}

// NotifyUser sends title/body to every stored push subscription for uid.
// Failures are logged and otherwise ignored — a missed notification must
// never fail the import itself. A subscription the browser has revoked
// (404/410 response) is deleted so future sends don't keep retrying it.
func NotifyUser(app core.App, uid, title, body string) {
	if !Enabled() {
		return
	}

	subs, err := app.FindRecordsByFilter(
		"push_subscriptions", "user = {:uid}", "", 0, 0,
		map[string]any{"uid": uid},
	)
	if err != nil {
		app.Logger().Error("failed to load push subscriptions", slog.String("error", err.Error()))
		return
	}

	msg, err := json.Marshal(notificationPayload{Title: title, Body: body})
	if err != nil {
		return
	}

	for _, s := range subs {
		sub := &webpush.Subscription{
			Endpoint: s.GetString("endpoint"),
			Keys: webpush.Keys{
				P256dh: s.GetString("p256dh"),
				Auth:   s.GetString("auth"),
			},
		}
		resp, err := webpush.SendNotification(msg, sub, &webpush.Options{
			VAPIDPublicKey:  PublicKey(),
			VAPIDPrivateKey: os.Getenv("VAPID_PRIVATE_KEY"),
			TTL:             60,
		})
		if err != nil {
			app.Logger().Error("failed to send push notification",
				slog.String("userId", uid), slog.String("error", err.Error()))
			continue
		}
		resp.Body.Close()

		if resp.StatusCode == 404 || resp.StatusCode == 410 {
			_ = app.Delete(s)
		}
	}
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend && go test ./internal/push/... -v`
Expected: PASS

- [ ] **Step 6: Add the subscribe/unsubscribe/vapid-key endpoints**

```go
// backend/internal/routes/push.go
package routes

import (
	"net/http"

	"github.com/pocketbase/pocketbase/core"

	"github.com/boanntech/saolrian/backend/internal/push"
)

type pushSubscribeRequest struct {
	Endpoint string `json:"endpoint"`
	Keys     struct {
		P256dh string `json:"p256dh"`
		Auth   string `json:"auth"`
	} `json:"keys"`
}

// GET /api/saolrian/push/vapid-key
func pushVapidKeyHandler(e *core.RequestEvent) error {
	return e.JSON(http.StatusOK, map[string]any{
		"enabled":   push.Enabled(),
		"publicKey": push.PublicKey(),
	})
}

// POST /api/saolrian/push/subscribe
func pushSubscribeHandler(e *core.RequestEvent) error {
	var req pushSubscribeRequest
	if err := e.BindBody(&req); err != nil {
		return e.BadRequestError("invalid JSON body", err)
	}
	if req.Endpoint == "" || req.Keys.P256dh == "" || req.Keys.Auth == "" {
		return e.BadRequestError("endpoint and keys are required", nil)
	}

	uid := e.Auth.Id
	col, err := e.App.FindCollectionByNameOrId("push_subscriptions")
	if err != nil {
		return e.InternalServerError("failed to load push_subscriptions collection", err)
	}

	rec, err := e.App.FindFirstRecordByFilter(
		"push_subscriptions", "user = {:uid} && endpoint = {:endpoint}",
		map[string]any{"uid": uid, "endpoint": req.Endpoint},
	)
	if err != nil || rec == nil {
		rec = core.NewRecord(col)
		rec.Set("user", uid)
		rec.Set("endpoint", req.Endpoint)
	}
	rec.Set("p256dh", req.Keys.P256dh)
	rec.Set("auth", req.Keys.Auth)

	if err := e.App.Save(rec); err != nil {
		return e.InternalServerError("failed to save push subscription", err)
	}
	return e.JSON(http.StatusOK, map[string]any{"ok": true})
}

// POST /api/saolrian/push/unsubscribe
func pushUnsubscribeHandler(e *core.RequestEvent) error {
	var req struct {
		Endpoint string `json:"endpoint"`
	}
	if err := e.BindBody(&req); err != nil {
		return e.BadRequestError("invalid JSON body", err)
	}

	uid := e.Auth.Id
	rec, err := e.App.FindFirstRecordByFilter(
		"push_subscriptions", "user = {:uid} && endpoint = {:endpoint}",
		map[string]any{"uid": uid, "endpoint": req.Endpoint},
	)
	if err == nil && rec != nil {
		_ = e.App.Delete(rec)
	}
	return e.JSON(http.StatusOK, map[string]any{"ok": true})
}
```

- [ ] **Step 7: Register the routes**

Modify `backend/internal/routes/summary.go:24` — after the existing `g.POST("/import/loseit", loseItImportHandler)` line, add:

```go
	g.GET("/push/vapid-key", pushVapidKeyHandler)
	g.POST("/push/subscribe", pushSubscribeHandler)
	g.POST("/push/unsubscribe", pushUnsubscribeHandler)
```

- [ ] **Step 8: Build and run the full backend suite**

Run: `cd backend && go build ./... && go vet ./... && go test ./... -v`
Expected: PASS. This also exercises Task 2-4's `push.NotifyUser` calls against the real (now no-op-when-unconfigured) implementation instead of the placeholder.

- [ ] **Step 9: Commit**

```bash
git add backend/go.mod backend/go.sum backend/internal/push/push.go backend/internal/push/push_test.go backend/internal/routes/push.go backend/internal/routes/summary.go
git commit -m "feat: add Web Push subscribe/unsubscribe endpoints and VAPID-based send"
```

---

### Task 6: Frontend — fix the date bug and add per-category CSV parsers

**Files:**
- Modify: `frontend/src/lib/loseit.ts`
- Create: `frontend/src/lib/loseit.test.ts`

**Interfaces:**
- Produces: `toIsoDate(raw: string): string`; `parseLoseItCsv` (existing, now date-fixed); `parseDateValueCsv(text): DateValueRow[]`; `parseLoseItWeightCsv(text): LoseItWeightRow[]`; `parseLoseItExerciseCsv(text): LoseItExerciseRow[]`; `parseLoseItFoodCatalogCsv(text): LoseItFoodCatalogRow[]`; `parseLoseItProfileCsv(text): LoseItProfileSnapshot`. Task 7 (`loseitZip.ts`) imports all of these plus their row types.

- [ ] **Step 1: Write the failing test for the date bug fix**

```typescript
// frontend/src/lib/loseit.test.ts
import { describe, it, expect } from 'vitest';
import { toIsoDate, parseLoseItCsv } from './loseit';

describe('toIsoDate', () => {
  it('converts LoseIt MM/DD/YYYY dates to YYYY-MM-DD', () => {
    expect(toIsoDate('05/02/2023')).toBe('2023-05-02');
    expect(toIsoDate('12/1/2026')).toBe('2026-12-01');
  });

  it('passes through an already-ISO date unchanged', () => {
    expect(toIsoDate('2026-04-04')).toBe('2026-04-04');
  });
});

describe('parseLoseItCsv', () => {
  it('emits ISO dates so the backend\'s time.Parse("2006-01-02", ...) succeeds', () => {
    const csv = 'Date,Name,Meal,Quantity,Units,Calories\n05/02/2023,Toast,Breakfast,1,Servings,200\n';
    const rows = parseLoseItCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe('2023-05-02');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/loseit.test.ts`
Expected: FAIL — `toIsoDate` doesn't exist, and `parseLoseItCsv`'s date is still `05/02/2023`.

- [ ] **Step 3: Add `toIsoDate` and fix `parseLoseItCsv`**

In `frontend/src/lib/loseit.ts`, add near the other helpers (after `num`):

```typescript
/** Converts a LoseIt `MM/DD/YYYY` date to `YYYY-MM-DD`. Passes through an
 * already-ISO date unchanged. The backend parses every date with Go's
 * `time.Parse("2006-01-02", ...)`, so every LoseIt date must go through
 * this before being sent. */
export function toIsoDate(raw: string): string {
  const trimmed = raw.trim();
  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (!mdy) return trimmed;
  const [, mm, dd, yyyy] = mdy;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}
```

In `parseLoseItCsv`'s row-building loop, change:

```typescript
    rows.push({
      date,
      name,
```

to:

```typescript
    rows.push({
      date: toIsoDate(date),
      name,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/loseit.test.ts`
Expected: PASS

- [ ] **Step 5: Commit the bug fix on its own**

```bash
git add frontend/src/lib/loseit.ts frontend/src/lib/loseit.test.ts
git commit -m "fix: convert LoseIt MM/DD/YYYY dates to ISO before sending to the backend"
```

- [ ] **Step 6: Write failing tests for the weight, exercise, and date-value parsers**

```typescript
// append to frontend/src/lib/loseit.test.ts
import { parseDateValueCsv, parseLoseItWeightCsv, parseLoseItExerciseCsv } from './loseit';

describe('parseDateValueCsv', () => {
  it('parses steps/water/body-fat/sleep-shaped CSVs', () => {
    const csv = 'Date,Value,Secondary Value,Last Updated\n04/04/2026,8416.0,0.0,2026-04-04T00:00:00+0100\n';
    const rows = parseDateValueCsv(csv);
    expect(rows).toEqual([{ date: '2026-04-04', value: 8416 }]);
  });
});

describe('parseLoseItWeightCsv', () => {
  it('parses weight rows and skips deleted ones', () => {
    const csv = 'Date,Weight,Last Updated,Deleted\n05/02/2023,91.99,2023-05-02T23:21:13+0100,false\n05/03/2023,90.5,2023-05-03T00:00:00+0100,true\n';
    const rows = parseLoseItWeightCsv(csv);
    expect(rows).toEqual([{ date: '2023-05-02', kg: 91.99 }]);
  });
});

describe('parseLoseItExerciseCsv', () => {
  it('parses minutes-based exercise rows and skips deleted ones', () => {
    const csv = 'Date,Name,Icon,Type,Quantity,Units,Calories,Deleted\n05/05/2023,Garmin Adjustment,Garmin,Exercise,30,minutes,-176.0,0\n05/06/2023,Run,Run,Exercise,20,minutes,150,1\n';
    const rows = parseLoseItExerciseCsv(csv);
    expect(rows).toEqual([{ date: '2023-05-05', name: 'Garmin Adjustment', minutes: 30, kcal: -176 }]);
  });
});
```

- [ ] **Step 7: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/loseit.test.ts`
Expected: FAIL — the three new parsers don't exist.

- [ ] **Step 8: Implement the weight, exercise, and date-value parsers**

Append to `frontend/src/lib/loseit.ts`:

```typescript
// ---------------------------------------------------------------------
// steps / water-intake / body-fat / sleep-hours (shared Date,Value shape)
// ---------------------------------------------------------------------

export interface DateValueRow {
  date: string;
  value: number;
}

function looksLikeDateValueHeader(cells: string[]): boolean {
  const lower = cells.map((c) => c.trim().toLowerCase());
  return lower[0] === 'date' && lower.includes('value');
}

export function parseDateValueCsv(text: string): DateValueRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const headerIdx = lines.findIndex((l) => looksLikeDateValueHeader(splitCsvLine(l)));
  if (headerIdx === -1) return [];
  const header = splitCsvLine(lines[headerIdx]).map((c) => c.trim().toLowerCase());
  const dateIdx = header.indexOf('date');
  const valueIdx = header.indexOf('value');

  const rows: DateValueRow[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const date = (cells[dateIdx] ?? '').trim();
    if (!date) continue;
    rows.push({ date: toIsoDate(date), value: num(cells[valueIdx]) });
  }
  return rows;
}

// ---------------------------------------------------------------------
// weights.csv
// ---------------------------------------------------------------------

export interface LoseItWeightRow {
  date: string;
  kg: number;
}

function looksLikeWeightHeader(cells: string[]): boolean {
  const lower = cells.map((c) => c.trim().toLowerCase());
  return lower[0] === 'date' && lower.includes('weight');
}

export function parseLoseItWeightCsv(text: string): LoseItWeightRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const headerIdx = lines.findIndex((l) => looksLikeWeightHeader(splitCsvLine(l)));
  if (headerIdx === -1) return [];
  const header = splitCsvLine(lines[headerIdx]).map((c) => c.trim().toLowerCase());
  const dateIdx = header.indexOf('date');
  const weightIdx = header.indexOf('weight');
  const deletedIdx = header.indexOf('deleted');

  const rows: LoseItWeightRow[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    if (deletedIdx !== -1 && (cells[deletedIdx] ?? '').trim().toLowerCase() === 'true') continue;
    const date = (cells[dateIdx] ?? '').trim();
    const kg = num(cells[weightIdx]);
    if (!date || kg <= 0) continue;
    rows.push({ date: toIsoDate(date), kg });
  }
  return rows;
}

// ---------------------------------------------------------------------
// exercise-logs.csv
// ---------------------------------------------------------------------

export interface LoseItExerciseRow {
  date: string;
  name: string;
  minutes: number;
  kcal: number;
}

function looksLikeExerciseHeader(cells: string[]): boolean {
  const lower = cells.map((c) => c.trim().toLowerCase());
  return lower.includes('date') && lower.includes('name') && lower.some((c) => c.includes('calor'));
}

export function parseLoseItExerciseCsv(text: string): LoseItExerciseRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const headerIdx = lines.findIndex((l) => looksLikeExerciseHeader(splitCsvLine(l)));
  if (headerIdx === -1) return [];
  const header = splitCsvLine(lines[headerIdx]).map((c) => c.trim().toLowerCase());
  const dateIdx = header.indexOf('date');
  const nameIdx = header.indexOf('name');
  const qtyIdx = header.indexOf('quantity');
  const unitsIdx = header.indexOf('units');
  const kcalIdx = header.indexOf('calories');
  const deletedIdx = header.indexOf('deleted');

  const rows: LoseItExerciseRow[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    if (deletedIdx !== -1 && (cells[deletedIdx] ?? '').trim() === '1') continue;
    const date = (cells[dateIdx] ?? '').trim();
    const name = (cells[nameIdx] ?? '').trim();
    if (!date || !name) continue;
    const isMinutes = unitsIdx !== -1 && (cells[unitsIdx] ?? '').trim().toLowerCase() === 'minutes';
    rows.push({
      date: toIsoDate(date),
      name,
      minutes: isMinutes ? num(cells[qtyIdx]) : 0,
      kcal: num(cells[kcalIdx]),
    });
  }
  return rows;
}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/loseit.test.ts`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add frontend/src/lib/loseit.ts frontend/src/lib/loseit.test.ts
git commit -m "feat: add LoseIt weight/exercise/daily-metric CSV parsers"
```

- [ ] **Step 11: Write failing tests for the food-catalog and profile parsers**

```typescript
// append to frontend/src/lib/loseit.test.ts
import { parseLoseItFoodCatalogCsv, parseLoseItProfileCsv } from './loseit';

describe('parseLoseItFoodCatalogCsv', () => {
  it('parses custom-foods.csv rows (has Brand)', () => {
    const csv =
      'Name,UniqueId,Brand,Image,Quantity,Measure,Calories,Fat (g),Protein (g),Carbohydrates (g),Saturated Fat (g),Sugars (g),Fiber (g),Cholesterol (mg),Sodium (mg)\n' +
      'Black Bean Sauce,abc123,WAI MAI,Sauce,500,Grams,300,5,10,40,1,50,2,0,9\n';
    const rows = parseLoseItFoodCatalogCsv(csv);
    expect(rows).toEqual([
      { name: 'Black Bean Sauce', unique_id: 'abc123', brand: 'WAI MAI', quantity: 500, measure: 'Grams', kcal: 300, protein_g: 10, carbs_g: 40, fat_g: 5 },
    ]);
  });

  it('parses recipes.csv rows (no Brand column)', () => {
    const csv =
      'Name,UniqueId,Quantity,Measure,Author,Image Name,Calories,Fat (g),Protein (g),Carbohydrates (g),Saturated Fat (g),Sugars (g),Fiber (g),Cholesterol (mg),Sodium (mg)\n' +
      'Chicken Satay,def456,6,Serving,,Recipe,900,120,240,60,45,92,0,132\n';
    const rows = parseLoseItFoodCatalogCsv(csv);
    expect(rows).toEqual([
      { name: 'Chicken Satay', unique_id: 'def456', brand: '', quantity: 6, measure: 'Serving', kcal: 900, protein_g: 240, carbs_g: 60, fat_g: 120 },
    ]);
  });
});

describe('parseLoseItProfileCsv', () => {
  it('maps LoseIt profile.csv key/value pairs to this app\'s enums', () => {
    const csv = [
      'Name,Value',
      'Birthday,06/06/1990',
      'Gender,Male',
      'Height,178.0',
      'Calorie Adjustment,0.0',
      'Current EER,2383.33',
      'Plan,maintain',
      'Activity Level,Somewhat Active',
    ].join('\n');
    const snap = parseLoseItProfileCsv(csv);
    expect(snap).toEqual({
      birth_year: 1990,
      sex: 'male',
      height_cm: 178,
      goal: 'maintain',
      activity_level: 'moderate',
    });
  });

  it('includes calorie_target only when LoseIt records a non-zero adjustment', () => {
    const csv = ['Name,Value', 'Calorie Adjustment,150', 'Current EER,2400'].join('\n');
    const snap = parseLoseItProfileCsv(csv);
    expect(snap.calorie_target).toBe(2550);
  });
});
```

- [ ] **Step 12: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/loseit.test.ts`
Expected: FAIL — `parseLoseItFoodCatalogCsv`/`parseLoseItProfileCsv` don't exist.

- [ ] **Step 13: Implement the food-catalog and profile parsers**

Append to `frontend/src/lib/loseit.ts`:

```typescript
// ---------------------------------------------------------------------
// custom-foods.csv / recipes.csv (shared shape)
// ---------------------------------------------------------------------

export interface LoseItFoodCatalogRow {
  name: string;
  unique_id: string;
  brand: string;
  quantity: number;
  measure: string;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}

function looksLikeFoodCatalogHeader(cells: string[]): boolean {
  const lower = cells.map((c) => c.trim().toLowerCase());
  return lower.includes('uniqueid') && lower.includes('measure');
}

export function parseLoseItFoodCatalogCsv(text: string): LoseItFoodCatalogRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const headerIdx = lines.findIndex((l) => looksLikeFoodCatalogHeader(splitCsvLine(l)));
  if (headerIdx === -1) return [];
  const header = splitCsvLine(lines[headerIdx]).map((c) => c.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const nameIdx = col('name');
  const uidIdx = col('uniqueid');
  const brandIdx = col('brand');
  const qtyIdx = col('quantity');
  const measureIdx = col('measure');
  const kcalIdx = col('calories');
  const fatIdx = col('fat (g)');
  const proteinIdx = col('protein (g)');
  const carbsIdx = col('carbohydrates (g)');

  const rows: LoseItFoodCatalogRow[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const name = (cells[nameIdx] ?? '').trim();
    const uniqueId = (cells[uidIdx] ?? '').trim();
    const quantity = num(cells[qtyIdx]);
    if (!name || !uniqueId || quantity <= 0) continue;
    rows.push({
      name,
      unique_id: uniqueId,
      brand: brandIdx !== -1 ? (cells[brandIdx] ?? '').trim() : '',
      quantity,
      measure: (cells[measureIdx] ?? '').trim(),
      kcal: num(cells[kcalIdx]),
      protein_g: num(cells[proteinIdx]),
      carbs_g: num(cells[carbsIdx]),
      fat_g: num(cells[fatIdx]),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------
// profile.csv
// ---------------------------------------------------------------------

export interface LoseItProfileSnapshot {
  birth_year?: number;
  sex?: 'male' | 'female' | 'other';
  height_cm?: number;
  calorie_target?: number;
  goal?: 'lose' | 'maintain' | 'gain';
  activity_level?: 'sedentary' | 'light' | 'moderate' | 'very' | 'extreme';
}

function mapActivityLevel(raw: string): LoseItProfileSnapshot['activity_level'] {
  const v = raw.toLowerCase();
  if (v.includes('sedentary')) return 'sedentary';
  if (v.includes('extrem')) return 'extreme';
  if (v.includes('very')) return 'very';
  if (v.includes('light')) return 'light';
  return 'moderate';
}

export function parseLoseItProfileCsv(text: string): LoseItProfileSnapshot {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const values: Record<string, string> = {};
  for (const line of lines) {
    const cells = splitCsvLine(line);
    if (cells.length < 2) continue;
    values[cells[0].trim()] = cells[1].trim();
  }

  const snap: LoseItProfileSnapshot = {};

  const birthday = values['Birthday'];
  if (birthday) {
    const year = Number(toIsoDate(birthday).slice(0, 4));
    if (Number.isFinite(year) && year > 1900) snap.birth_year = year;
  }

  const gender = (values['Gender'] ?? '').toLowerCase();
  if (gender === 'male' || gender === 'female') snap.sex = gender;
  else if (gender) snap.sex = 'other';

  const height = num(values['Height']);
  if (height > 0) snap.height_cm = height;

  const eer = num(values['Current EER']);
  const adjustment = num(values['Calorie Adjustment']);
  if (eer > 0 && adjustment !== 0) snap.calorie_target = eer + adjustment;

  const plan = (values['Plan'] ?? '').toLowerCase();
  if (plan === 'lose' || plan === 'maintain' || plan === 'gain') snap.goal = plan;

  const activity = values['Activity Level'];
  if (activity) snap.activity_level = mapActivityLevel(activity);

  return snap;
}
```

- [ ] **Step 14: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/loseit.test.ts`
Expected: PASS

- [ ] **Step 15: Commit**

```bash
git add frontend/src/lib/loseit.ts frontend/src/lib/loseit.test.ts
git commit -m "feat: add LoseIt custom-foods/recipes and profile.csv parsers"
```

---

### Task 7: Frontend — zip extraction and category dispatch

**Files:**
- Create: `frontend/src/lib/loseitZip.ts`
- Create: `frontend/src/lib/loseitZip.test.ts`
- Modify: `frontend/package.json` (add `fflate`)

**Interfaces:**
- Consumes: every parser from Task 6.
- Produces: `interface LoseItImportCategories { diary?, weight?, exercise?, foods?, recipes?, steps?, water?, body_fat?, sleep?, profile? }`; `interface LoseItCategoryPreview { key, label, count, defaultSelected }`; `async function parseLoseItZip(file: File): Promise<{ categories: LoseItImportCategories; previews: LoseItCategoryPreview[] }>`. Task 9 (`Import.tsx`) consumes this directly.

- [ ] **Step 1: Add the dependency**

Run: `cd frontend && npm install fflate`

- [ ] **Step 2: Write the failing test**

```typescript
// frontend/src/lib/loseitZip.test.ts
import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { parseLoseItZip } from './loseitZip';

function makeZipFile(entries: Record<string, string>): File {
  const encoded: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(entries)) {
    encoded[name] = strToU8(content);
  }
  const zipped = zipSync(encoded);
  return new File([zipped], 'loseit-export.zip', { type: 'application/zip' });
}

describe('parseLoseItZip', () => {
  it('extracts and parses every supported category present in the zip', async () => {
    const file = makeZipFile({
      'food-logs.csv': 'Date,Name,Meal,Quantity,Units,Calories\n05/02/2023,Toast,Breakfast,1,Servings,200\n',
      'weights.csv': 'Date,Weight,Last Updated,Deleted\n05/02/2023,91.99,2023-05-02T00:00:00+0100,false\n',
      'fasting-logs.csv': 'Scheduled start,Scheduled duration,Actual start,Actual end,Deleted\n',
    });

    const { categories, previews } = await parseLoseItZip(file);

    expect(categories.diary).toHaveLength(1);
    expect(categories.weight).toHaveLength(1);
    expect(previews.map((p) => p.key).sort()).toEqual(['diary', 'weight']);
    // unsupported files are read but never surfaced
    expect((categories as Record<string, unknown>).fasting_logs).toBeUndefined();
  });

  it('returns no categories/previews for a zip with none of the known files', async () => {
    const file = makeZipFile({ 'notes.csv': 'Date,Title,Body\n' });
    const { categories, previews } = await parseLoseItZip(file);
    expect(Object.keys(categories)).toHaveLength(0);
    expect(previews).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/loseitZip.test.ts`
Expected: FAIL — `frontend/src/lib/loseitZip.ts` doesn't exist.

- [ ] **Step 4: Implement `loseitZip.ts`**

```typescript
// frontend/src/lib/loseitZip.ts
/** Unzips a LoseIt export client-side and parses every supported category
 * found in it. Unrecognized files (achievements, fasting, etc. — see the
 * design spec's skip list) are simply never looked up, so they're read
 * into memory by unzipSync but never surfaced or acted on. */
import { unzipSync, strFromU8 } from 'fflate';
import {
  parseLoseItCsv,
  parseDateValueCsv,
  parseLoseItWeightCsv,
  parseLoseItExerciseCsv,
  parseLoseItFoodCatalogCsv,
  parseLoseItProfileCsv,
  type LoseItRow,
  type DateValueRow,
  type LoseItWeightRow,
  type LoseItExerciseRow,
  type LoseItFoodCatalogRow,
  type LoseItProfileSnapshot,
} from './loseit';

export interface LoseItImportCategories {
  diary?: LoseItRow[];
  weight?: LoseItWeightRow[];
  exercise?: LoseItExerciseRow[];
  foods?: LoseItFoodCatalogRow[];
  recipes?: LoseItFoodCatalogRow[];
  steps?: DateValueRow[];
  water?: DateValueRow[];
  body_fat?: DateValueRow[];
  sleep?: DateValueRow[];
  profile?: LoseItProfileSnapshot;
}

export interface LoseItCategoryPreview {
  key: keyof LoseItImportCategories;
  label: string;
  count: number;
  defaultSelected: boolean;
}

const CATEGORY_META: Record<keyof LoseItImportCategories, { file: string; label: string; defaultSelected: boolean }> = {
  diary: { file: 'food-logs.csv', label: 'Food logs', defaultSelected: true },
  weight: { file: 'weights.csv', label: 'Weight', defaultSelected: true },
  exercise: { file: 'exercise-logs.csv', label: 'Exercise', defaultSelected: true },
  foods: { file: 'custom-foods.csv', label: 'Custom foods', defaultSelected: true },
  recipes: { file: 'recipes.csv', label: 'Recipes', defaultSelected: true },
  steps: { file: 'steps.csv', label: 'Steps', defaultSelected: true },
  water: { file: 'water-intake.csv', label: 'Water', defaultSelected: true },
  body_fat: { file: 'body-fat.csv', label: 'Body fat', defaultSelected: true },
  sleep: { file: 'sleep-hours.csv', label: 'Sleep', defaultSelected: true },
  profile: { file: 'profile.csv', label: 'Profile & goals', defaultSelected: false },
};

export async function parseLoseItZip(
  file: File,
): Promise<{ categories: LoseItImportCategories; previews: LoseItCategoryPreview[] }> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const entries = unzipSync(buf);

  const text = (name: string): string | null => {
    const data = entries[name];
    return data ? strFromU8(data) : null;
  };

  const categories: LoseItImportCategories = {};
  const previews: LoseItCategoryPreview[] = [];

  function add<K extends keyof LoseItImportCategories>(key: K, rows: LoseItImportCategories[K] | null): void {
    if (!rows) return;
    const count = Array.isArray(rows) ? rows.length : 1;
    if (count === 0) return;
    categories[key] = rows;
    previews.push({ key, label: CATEGORY_META[key].label, count, defaultSelected: CATEGORY_META[key].defaultSelected });
  }

  const diaryText = text(CATEGORY_META.diary.file);
  add('diary', diaryText ? parseLoseItCsv(diaryText) : null);

  const weightText = text(CATEGORY_META.weight.file);
  add('weight', weightText ? parseLoseItWeightCsv(weightText) : null);

  const exerciseText = text(CATEGORY_META.exercise.file);
  add('exercise', exerciseText ? parseLoseItExerciseCsv(exerciseText) : null);

  const foodsText = text(CATEGORY_META.foods.file);
  add('foods', foodsText ? parseLoseItFoodCatalogCsv(foodsText) : null);

  const recipesText = text(CATEGORY_META.recipes.file);
  add('recipes', recipesText ? parseLoseItFoodCatalogCsv(recipesText) : null);

  const stepsText = text(CATEGORY_META.steps.file);
  add('steps', stepsText ? parseDateValueCsv(stepsText) : null);

  const waterText = text(CATEGORY_META.water.file);
  add('water', waterText ? parseDateValueCsv(waterText) : null);

  const bodyFatText = text(CATEGORY_META.body_fat.file);
  add('body_fat', bodyFatText ? parseDateValueCsv(bodyFatText) : null);

  const sleepText = text(CATEGORY_META.sleep.file);
  add('sleep', sleepText ? parseDateValueCsv(sleepText) : null);

  const profileText = text(CATEGORY_META.profile.file);
  if (profileText) {
    const snap = parseLoseItProfileCsv(profileText);
    if (Object.keys(snap).length > 0) {
      categories.profile = snap;
      previews.push({ key: 'profile', label: CATEGORY_META.profile.label, count: 1, defaultSelected: false });
    }
  }

  return { categories, previews };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/loseitZip.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/lib/loseitZip.ts frontend/src/lib/loseitZip.test.ts
git commit -m "feat: unzip and dispatch a LoseIt export to its category parsers"
```

---

### Task 8: Frontend — push subscription helper and custom service worker

**Files:**
- Create: `frontend/src/lib/push.ts`
- Create: `frontend/src/sw.ts`
- Modify: `frontend/vite.config.ts`
- Modify: `frontend/package.json` (add workbox devDependencies)

**Interfaces:**
- Consumes: `GET /api/saolrian/push/vapid-key` and `POST /api/saolrian/push/subscribe` from Task 5; `saolrianSend`/`getClient` from `lib/pb.ts`.
- Produces: `async function ensurePushSubscription(endpoint: string): Promise<boolean>`, consumed by Task 9's `Import.tsx`.

This task's core logic (`ensurePushSubscription`) depends on browser `Notification`/`PushManager`/`serviceWorker` APIs that jsdom doesn't implement, so it's verified by mocking those globals rather than a real service worker — see Step 2.

- [ ] **Step 1: Add workbox devDependencies**

Run: `cd frontend && npm install --save-dev workbox-precaching workbox-routing workbox-strategies workbox-expiration`

- [ ] **Step 2: Write the failing test**

```typescript
// frontend/src/lib/push.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ensurePushSubscription } from './push';

vi.mock('./pb', () => ({
  getClient: () => ({}),
  saolrianSend: vi.fn(),
}));

import { saolrianSend } from './pb';

describe('ensurePushSubscription', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns false without calling Notification when the server has no VAPID key configured', async () => {
    (saolrianSend as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ enabled: false, publicKey: '' });
    vi.stubGlobal('Notification', { requestPermission: vi.fn() });

    const result = await ensurePushSubscription('http://localhost:8090');

    expect(result).toBe(false);
    expect((globalThis.Notification as unknown as { requestPermission: ReturnType<typeof vi.fn> }).requestPermission).not.toHaveBeenCalled();
  });

  it('subscribes and posts the subscription when permission is granted', async () => {
    (saolrianSend as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ enabled: true, publicKey: 'QUJD' }) // vapid-key lookup
      .mockResolvedValueOnce({ ok: true }); // subscribe POST

    vi.stubGlobal('Notification', { requestPermission: vi.fn().mockResolvedValue('granted') });

    const fakeSubscription = {
      toJSON: () => ({ endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } }),
    };
    const registration = {
      pushManager: {
        getSubscription: vi.fn().mockResolvedValue(null),
        subscribe: vi.fn().mockResolvedValue(fakeSubscription),
      },
    };
    vi.stubGlobal('navigator', {
      serviceWorker: { ready: Promise.resolve(registration) },
    });
    vi.stubGlobal('PushManager', function () {});

    const result = await ensurePushSubscription('http://localhost:8090');

    expect(result).toBe(true);
    expect(registration.pushManager.subscribe).toHaveBeenCalled();
    expect(saolrianSend).toHaveBeenCalledWith(
      expect.anything(),
      'POST',
      '/api/saolrian/push/subscribe',
      { endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } },
    );
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/push.test.ts`
Expected: FAIL — `frontend/src/lib/push.ts` doesn't exist.

- [ ] **Step 4: Implement `push.ts`**

```typescript
// frontend/src/lib/push.ts
/** Requests notification permission and subscribes this browser to Web
 * Push, registering the subscription with the backend. A no-op (returns
 * false) if push isn't supported, permission is denied, or the server
 * has no VAPID key configured — the import still works via in-app
 * realtime updates and toasts in every one of those cases. */
import { getClient, saolrianSend } from './pb';

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const base64Safe = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64Safe);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export async function ensurePushSubscription(endpoint: string): Promise<boolean> {
  if (!('serviceWorker' in navigator) || typeof PushManager === 'undefined') return false;

  const pb = getClient(endpoint);
  const config = await saolrianSend<{ enabled: boolean; publicKey: string }>(
    pb,
    'GET',
    '/api/saolrian/push/vapid-key',
  );
  if (!config.enabled) return false;

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return false;

  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.publicKey),
    });
  }

  const json = subscription.toJSON();
  await saolrianSend(pb, 'POST', '/api/saolrian/push/subscribe', {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
  });
  return true;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/push.test.ts`
Expected: PASS

- [ ] **Step 6: Add the custom service worker**

```typescript
// frontend/src/sw.ts
/// <reference lib="webworker" />
import { precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { NetworkFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';

declare let self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);

// Preserves the network-first API caching that the previous generateSW
// config provided via its `workbox.runtimeCaching` option — that option
// has no effect under injectManifest, so it's reimplemented here.
registerRoute(
  ({ url }) => url.pathname.includes('/api/'),
  new NetworkFirst({
    cacheName: 'saolrian-api',
    networkTimeoutSeconds: 4,
    plugins: [new ExpirationPlugin({ maxEntries: 100, maxAgeSeconds: 60 * 60 })],
  }),
);

self.addEventListener('push', (event: PushEvent) => {
  if (!event.data) return;
  const data = event.data.json() as { title: string; body: string };
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',
    }),
  );
});

self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return (client as WindowClient).focus();
      }
      return self.clients.openWindow('/');
    }),
  );
});
```

- [ ] **Step 7: Switch VitePWA to injectManifest**

In `frontend/vite.config.ts`, change:

```typescript
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon.svg'],
      manifest: {
```

to:

```typescript
    VitePWA({
      registerType: 'autoUpdate',
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      includeAssets: ['icons/icon.svg'],
      manifest: {
```

and remove the now-inapplicable `workbox: { ... }` block entirely (its `runtimeCaching` behavior now lives in `src/sw.ts`, per Step 6's comment) — delete from `workbox: {` through its closing `}),` before the final `],` of the `plugins` array.

- [ ] **Step 8: Verify the frontend still builds**

Run: `cd frontend && npm run build`
Expected: builds successfully, producing `dist/sw.js` compiled from `src/sw.ts` (via injectManifest) instead of a generated one.

- [ ] **Step 9: Run the full frontend test suite**

Run: `cd frontend && npm test`
Expected: PASS (no regressions from the vite.config.ts change, since vitest doesn't build the SW)

- [ ] **Step 10: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/lib/push.ts frontend/src/lib/push.test.ts frontend/src/sw.ts frontend/vite.config.ts
git commit -m "feat: add Web Push subscription helper and a custom injectManifest service worker"
```

---

### Task 9: Frontend — rework the Import screen around the zip picker and job status

**Files:**
- Modify: `frontend/src/screens/Import.tsx`
- Modify: `frontend/src/screens/import.css` (small addition for the category checklist)
- Create: `frontend/src/screens/__tests__/Import.test.tsx`

**Interfaces:**
- Consumes: `parseLoseItZip` (Task 7), `ensurePushSubscription` (Task 8), `POST /api/saolrian/import/loseit` → `{ job_id }` (Task 2), PocketBase realtime `pb.collection('import_jobs').subscribe(jobId, cb)`.

- [ ] **Step 1: Write the failing test**

```typescript
// frontend/src/screens/__tests__/Import.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Import from '../Import';
import { AppProvider } from '../../state/AppContext';

const authRecord = { id: 'user-1' };

type JobRecord = { id: string; status: string; counts: Record<string, { imported: number; skipped: number }>; error?: string };
let subscribeCb: ((e: { record: JobRecord }) => void) | null = null;

const fakePb = {
  baseUrl: 'http://localhost:8090',
  authStore: { isValid: true, record: authRecord, onChange: () => () => {} },
  collection: (name: string) => {
    if (name === 'import_jobs') {
      return {
        subscribe: async (_id: string, cb: (e: { record: JobRecord }) => void) => {
          subscribeCb = cb;
          return async () => {};
        },
        unsubscribe: async () => {},
      };
    }
    if (name === 'meal_slots') return { getFullList: async () => [] };
    if (name === 'profiles') return { getFullList: async () => [] };
    if (name === 'weights') return { getList: async () => ({ items: [] }) };
    throw new Error(`unexpected collection ${name}`);
  },
  send: async (path: string) => {
    if (path === '/api/saolrian/import/loseit') return { job_id: 'job-1' };
    throw new Error(`unexpected send ${path}`);
  },
};

vi.mock('../../lib/pb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pb')>();
  return { ...actual, getClient: () => fakePb };
});

vi.mock('../../lib/push', () => ({ ensurePushSubscription: async () => false }));

vi.mock('../../lib/loseitZip', () => ({
  parseLoseItZip: async () => ({
    categories: {
      diary: [{ date: '2023-05-02', name: 'Toast', quantity: 1, unit: 'serving', meal: 'Breakfast', kcal: 200, protein_g: 5, carbs_g: 30, fat_g: 4 }],
    },
    previews: [{ key: 'diary', label: 'Food logs', count: 1, defaultSelected: true }],
  }),
}));

function renderImport() {
  return render(
    <MemoryRouter>
      <AppProvider>
        <Import />
      </AppProvider>
    </MemoryRouter>,
  );
}

describe('Import screen', () => {
  it('shows found categories, starts the job, and reports the result via realtime updates', async () => {
    renderImport();
    const user = userEvent.setup();

    const input = screen.getByLabelText('Upload Lose It export zip');
    const file = new File(['zip-bytes'], 'loseit-export.zip', { type: 'application/zip' });
    await user.upload(input, file);

    expect(await screen.findByText(/Food logs/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Import 1 selected/ }));

    await waitFor(() => expect(subscribeCb).not.toBeNull());
    subscribeCb!({ record: { id: 'job-1', status: 'done', counts: { diary: { imported: 1, skipped: 0 } } } });

    expect(await screen.findByText(/Imported 1, skipped 0/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/screens/__tests__/Import.test.tsx`
Expected: FAIL — the current `Import.tsx` has no file-category picker or `aria-label="Upload Lose It export zip"`.

- [ ] **Step 3: Rewrite `Import.tsx`**

```tsx
// frontend/src/screens/Import.tsx
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApp, saolrianSend } from '../state/AppContext';
import { parseLoseItZip, type LoseItCategoryPreview, type LoseItImportCategories } from '../lib/loseitZip';
import { ensurePushSubscription } from '../lib/push';
import { toCsv, buildExportFilename, downloadText, type ExportRow } from '../lib/export';
import { getClient } from '../lib/pb';
import type { DiaryEntry } from '../lib/types';
import { useToast } from '../components/ui';
import { formatInt } from '../lib/format';
import './import.css';

interface ImportJobRecord {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  counts: Record<string, { imported: number; skipped: number }>;
  error?: string;
}

export default function Import() {
  const { endpoint } = useApp();
  const toast = useToast();
  const navigate = useNavigate();

  const [fileName, setFileName] = useState('');
  const [categories, setCategories] = useState<LoseItImportCategories | null>(null);
  const [previews, setPreviews] = useState<LoseItCategoryPreview[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [parseErr, setParseErr] = useState('');
  const [job, setJob] = useState<ImportJobRecord | null>(null);
  const [starting, setStarting] = useState(false);
  const [exporting, setExporting] = useState(false);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setParseErr('');
    setJob(null);
    try {
      const { categories: cats, previews: prevs } = await parseLoseItZip(file);
      if (prevs.length === 0) {
        setParseErr('No importable Lose It! data found in this file.');
        setCategories(null);
        setPreviews([]);
        return;
      }
      setCategories(cats);
      setPreviews(prevs);
      setSelected(new Set(prevs.filter((p) => p.defaultSelected).map((p) => p.key)));
    } catch {
      setParseErr('Could not read that file — is it a Lose It! export zip?');
      setCategories(null);
      setPreviews([]);
    }
  };

  const toggle = (key: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const startImport = async () => {
    if (!categories || selected.size === 0) return;
    setStarting(true);
    try {
      const pb = getClient(endpoint);
      const payload: Record<string, unknown> = {};
      for (const key of selected) {
        payload[key] = (categories as Record<string, unknown>)[key];
      }

      void ensurePushSubscription(endpoint);

      const res = await saolrianSend<{ job_id: string }>(pb, 'POST', '/api/saolrian/import/loseit', {
        categories: payload,
      });

      setJob({ id: res.job_id, status: 'queued', counts: {} });

      await pb.collection('import_jobs').subscribe<ImportJobRecord>(res.job_id, (e) => {
        const rec = e.record;
        setJob(rec);
        if (rec.status === 'done' || rec.status === 'failed') {
          void pb.collection('import_jobs').unsubscribe(res.job_id);
          if (rec.status === 'done') {
            const totals = Object.values(rec.counts).reduce(
              (acc, c) => ({ imported: acc.imported + c.imported, skipped: acc.skipped + c.skipped }),
              { imported: 0, skipped: 0 },
            );
            toast(`Imported ${formatInt(totals.imported)}, skipped ${formatInt(totals.skipped)}.`);
          } else {
            toast(rec.error || 'Import failed', 'err');
          }
        }
      });
    } catch (ex) {
      toast(ex instanceof Error ? ex.message : 'Import failed to start', 'err');
    } finally {
      setStarting(false);
    }
  };

  const doExport = async () => {
    setExporting(true);
    try {
      const pb = getClient(endpoint);
      const slotNames = new Map<string, string>();
      const slots = await pb.collection('meal_slots').getFullList({ sort: 'sort_order' });
      slots.forEach((s) => slotNames.set(s.id, s.name));

      const all: ExportRow[] = [];
      let page = 1;
      for (;;) {
        const res = await pb.collection('diary_entries').getList(page, 200, {
          sort: '-logged_at',
        });
        res.items.forEach((it) => {
          const e = it as unknown as DiaryEntry;
          all.push({
            name: e.name_snapshot,
            brand: e.brand_snapshot,
            meal: slotNames.get(e.meal_slot) ?? '',
            grams: e.grams,
            kcal: e.kcal,
            protein: e.protein,
            carbs: e.carbs,
            fat: e.fat,
            logged_at: String(e.logged_at).slice(0, 10),
          });
        });
        if (page >= res.totalPages) break;
        page++;
      }

      const today = new Date().toISOString().slice(0, 10);
      downloadText(buildExportFilename(today), toCsv(all));
      toast(`Exported ${all.length} entr${all.length === 1 ? 'y' : 'ies'}`);
    } catch (ex) {
      toast(ex instanceof Error ? ex.message : 'Export failed', 'err');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="import">
      <div className="subhead">
        <button className="backbtn" onClick={() => navigate('/profile')} aria-label="Back to profile">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <h2>Import &amp; export</h2>
        <span style={{ width: 36 }} />
      </div>

      <div className="sec" style={{ paddingTop: 4 }}>
        <div className="card" style={{ padding: '16px 18px' }}>
          <div className="lbl2">Import from Lose It!</div>
          <p className="import-hint">
            Upload your Lose It! export zip (Settings → Export Data in the Lose It! app), then pick
            which parts to bring in.
          </p>
          <input
            type="file"
            accept=".zip,application/zip"
            onChange={(e) => void onFile(e)}
            className="file-input"
            aria-label="Upload Lose It export zip"
          />
          {fileName && <p className="import-file">File: {fileName}</p>}
          {parseErr && (
            <div className="import-err" role="alert">
              {parseErr}
            </div>
          )}

          {previews.length > 0 && !job && (
            <div className="import-preview">
              <ul className="import-category-list">
                {previews.map((p) => (
                  <li key={p.key}>
                    <label>
                      <input type="checkbox" checked={selected.has(p.key)} onChange={() => toggle(p.key)} />
                      {p.label} — {formatInt(p.count)} {p.count === 1 ? 'entry' : 'entries'}
                    </label>
                  </li>
                ))}
              </ul>
              <button className="btn" onClick={() => void startImport()} disabled={starting || selected.size === 0}>
                {starting ? 'Starting…' : `Import ${selected.size} selected`}
              </button>
            </div>
          )}

          {job && (
            <div className="import-result" role="status">
              {job.status === 'queued' || job.status === 'running'
                ? "Importing… you can leave this page, you'll be notified when it's done."
                : job.status === 'done'
                  ? 'Import complete — see the toast for totals.'
                  : `Import failed: ${job.error ?? 'unknown error'}`}
            </div>
          )}
        </div>
      </div>

      <div className="sec" style={{ paddingBottom: 26 }}>
        <div className="card" style={{ padding: '16px 18px' }}>
          <div className="lbl2">Export diary</div>
          <p className="import-hint">Download every diary entry as a CSV file, newest first.</p>
          <button className="btn outline" onClick={() => void doExport()} disabled={exporting}>
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
        </div>
      </div>

      <div className="sec" style={{ paddingBottom: 26 }}>
        <Link to="/profile" className="btn ghost" style={{ width: '100%', textAlign: 'center' }}>
          ← Back to profile
        </Link>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Add the small CSS addition**

Append to `frontend/src/screens/import.css`:

```css
.import-category-list {
  list-style: none;
  margin: 10px 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.import-category-list label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.9rem;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/screens/__tests__/Import.test.tsx`
Expected: PASS

- [ ] **Step 6: Run the full frontend suite**

Run: `cd frontend && npm test`
Expected: PASS — no regressions in other screens.

- [ ] **Step 7: Manual end-to-end check**

Run the app in dev (`cd backend && go run . serve` in one terminal, `cd frontend && npm run dev` in another — set `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` env vars for the backend process if testing push delivery, generated via a short one-off Go program calling `webpush.GenerateVAPIDKeys()`). Sign in, go to Profile → Import & export, upload a real LoseIt export zip, confirm: the category checklist shows plausible row counts, starting the import flips to "Importing…", and it resolves to a toast with totals shortly after (backend logs should show no errors). Re-run the same import and confirm the toast reports everything skipped (dedup working).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/screens/Import.tsx frontend/src/screens/import.css frontend/src/screens/__tests__/Import.test.tsx
git commit -m "feat: rework the Import screen around zip upload, category picker, and async job status"
```

---

## Post-implementation notes

- **Security review**: run the `security-review` skill/checklist over the diff before merging — the spec's "Security notes for review" section flags the VAPID private key handling and the new user-uploaded-data write paths specifically.
- **VAPID key generation for deployment**: document (in the repo's deployment notes, not part of this plan) that a self-hoster generates a keypair once via `webpush.GenerateVAPIDKeys()` and sets `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` as backend environment variables; push is otherwise silently disabled.
- **HTTPS requirement**: real Web Push requires the app be served over HTTPS (or localhost) — call this out wherever deployment is documented, since a plain-HTTP self-hosted instance will have push silently fail to subscribe.

package routes

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	_ "github.com/boanntech/saolrian/backend/internal/migrations"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
	"github.com/pocketbase/pocketbase/tools/router"
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

	// Production always has a profile row for every user, created by the
	// users after-create hook (internal/bootstrap), which isn't wired up
	// in this test app — so seed a minimal one here to match that invariant.
	profilesCol, err := app.FindCollectionByNameOrId("profiles")
	if err != nil {
		t.Fatalf("profiles collection missing: %v", err)
	}
	profile := core.NewRecord(profilesCol)
	profile.Set("user", user.Id)
	if err := app.Save(profile); err != nil {
		t.Fatalf("failed to create test profile: %v", err)
	}
	return app, user
}

// newTestUser creates an additional user (with profile) in an already-set-up
// test app, for tests exercising per-user isolation.
func newTestUser(t *testing.T, app *tests.TestApp, email string) *core.Record {
	t.Helper()
	usersCol, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatalf("users collection missing: %v", err)
	}
	user := core.NewRecord(usersCol)
	user.SetEmail(email)
	user.SetPassword("test-password-123")
	if err := app.Save(user); err != nil {
		t.Fatalf("failed to create test user: %v", err)
	}

	profilesCol, err := app.FindCollectionByNameOrId("profiles")
	if err != nil {
		t.Fatalf("profiles collection missing: %v", err)
	}
	profile := core.NewRecord(profilesCol)
	profile.Set("user", user.Id)
	if err := app.Save(profile); err != nil {
		t.Fatalf("failed to create test profile: %v", err)
	}
	return user
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

func TestImportDiaryRows_SkipsNegativeQuantityAllowsZero(t *testing.T) {
	app, user := newTestAppWithUser(t)

	rows := []diaryRow{
		{Date: "2023-05-02", Name: "Bad Row", Quantity: -1, Unit: "g", Meal: "Breakfast", Kcal: 100},
		{Date: "2023-05-02", Name: "Garmin Adjustment", Quantity: 0, Unit: "serving", Meal: "Breakfast", Kcal: 50},
	}

	got := importDiaryRows(app, user.Id, rows)
	if got.Imported != 1 || got.Skipped != 1 {
		t.Fatalf("got %+v, want 1 imported (zero-quantity row), 1 skipped (negative-quantity row)", got)
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

func TestImportExerciseRows_SkipsNegativeMinutesAllowsZero(t *testing.T) {
	app, user := newTestAppWithUser(t)

	rows := []exerciseRow{
		{Date: "2023-05-05", Name: "Bad Row", Minutes: -5, Kcal: 100},
		{Date: "2023-05-05", Name: "Garmin Adjustment", Minutes: 0, Kcal: 75},
	}

	got := importExerciseRows(app, user.Id, rows)
	if got.Imported != 1 || got.Skipped != 1 {
		t.Fatalf("got %+v, want 1 imported (zero-minutes row), 1 skipped (negative-minutes row)", got)
	}
}

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

// TestImportFoodCatalogRows_DedupIsPerUser guards against a regression where
// the dedup check (and its backing unique index) was scoped only by
// source+source_id, globally across all users. On a multi-user instance two
// different users' LoseIt exports could share a UniqueId (e.g. a shared or
// cloned LoseIt account), and the second user's import would silently skip
// a row it had never actually imported.
func TestImportFoodCatalogRows_DedupIsPerUser(t *testing.T) {
	app, user1 := newTestAppWithUser(t)
	user2 := newTestUser(t, app, "import-test-2@example.com")

	rows := []foodRow{
		{Name: "Black Bean Sauce", UniqueID: "shared-uid", Brand: "WAI MAI", Quantity: 500, Measure: "Grams", Kcal: 300, ProteinG: 10, CarbsG: 40, FatG: 5},
	}

	result1 := importFoodCatalogRows(app, user1.Id, rows)
	if result1.Imported != 1 || result1.Skipped != 0 {
		t.Fatalf("user1 import: got %+v, want 1 imported, 0 skipped", result1)
	}

	result2 := importFoodCatalogRows(app, user2.Id, rows)
	if result2.Imported != 1 || result2.Skipped != 0 {
		t.Fatalf("user2 import: got %+v, want 1 imported, 0 skipped (dedup must be per-user)", result2)
	}

	food1, err := app.FindFirstRecordByFilter("foods", "user = {:uid} && source_id = {:sid}",
		map[string]any{"uid": user1.Id, "sid": "shared-uid"})
	if err != nil {
		t.Fatalf("user1's food not found: %v", err)
	}
	food2, err := app.FindFirstRecordByFilter("foods", "user = {:uid} && source_id = {:sid}",
		map[string]any{"uid": user2.Id, "sid": "shared-uid"})
	if err != nil {
		t.Fatalf("user2's food not found: %v", err)
	}
	if food1.Id == food2.Id {
		t.Fatalf("expected two distinct food records, got the same one: %s", food1.Id)
	}

	// each user re-importing their own row is still deduped
	if again := importFoodCatalogRows(app, user1.Id, rows); again.Skipped != 1 {
		t.Fatalf("user1 re-import: got %+v, want 1 skipped", again)
	}
	if again := importFoodCatalogRows(app, user2.Id, rows); again.Skipped != 1 {
		t.Fatalf("user2 re-import: got %+v, want 1 skipped", again)
	}
}

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

// seedImportJob creates an import_jobs row for the given user with the
// given status, for tests exercising the concurrency guard and the
// stale-job sweep directly (without going through the HTTP handler /
// runImportJob goroutine).
func seedImportJob(t *testing.T, app *tests.TestApp, uid, status string) *core.Record {
	t.Helper()
	jobsCol, err := app.FindCollectionByNameOrId("import_jobs")
	if err != nil {
		t.Fatalf("import_jobs collection missing: %v", err)
	}
	job := core.NewRecord(jobsCol)
	job.Set("user", uid)
	job.Set("status", status)
	job.Set("counts", map[string]any{})
	if err := app.Save(job); err != nil {
		t.Fatalf("failed to seed import job (status=%s): %v", status, err)
	}
	return job
}

// TestHasActiveImportJob_RejectsConcurrentForSameUserOnly guards fix #1: a
// user with a queued/running job must be blocked from starting a second
// one, but that must not affect other users importing at the same time.
func TestHasActiveImportJob_RejectsConcurrentForSameUserOnly(t *testing.T) {
	app, user1 := newTestAppWithUser(t)
	user2 := newTestUser(t, app, "import-test-2@example.com")

	if hasActiveImportJob(app, user1.Id) {
		t.Fatalf("user1 should have no active import job yet")
	}

	seedImportJob(t, app, user1.Id, "running")

	if !hasActiveImportJob(app, user1.Id) {
		t.Fatalf("user1 should be blocked while a job is running")
	}
	if !hasActiveImportJob(app, user1.Id) {
		t.Fatalf("expected hasActiveImportJob to remain true on repeated checks")
	}

	// a different user must still be able to import concurrently
	if hasActiveImportJob(app, user2.Id) {
		t.Fatalf("user2 should not be affected by user1's running job")
	}
}

// TestHasActiveImportJob_QueuedAlsoBlocks covers the "queued" status (the
// brief window between job creation and runImportJob setting it to
// "running"), which must block a second import exactly like "running" does.
func TestHasActiveImportJob_QueuedAlsoBlocks(t *testing.T) {
	app, user := newTestAppWithUser(t)
	seedImportJob(t, app, user.Id, "queued")

	if !hasActiveImportJob(app, user.Id) {
		t.Fatalf("a queued job should block a second import")
	}
}

// TestHasActiveImportJob_DoneAndFailedDoNotBlock ensures the guard only
// looks at in-flight statuses — a finished job (successful or not) must not
// prevent the user from starting a new import.
func TestHasActiveImportJob_DoneAndFailedDoNotBlock(t *testing.T) {
	app, user := newTestAppWithUser(t)
	seedImportJob(t, app, user.Id, "done")
	seedImportJob(t, app, user.Id, "failed")

	if hasActiveImportJob(app, user.Id) {
		t.Fatalf("done/failed jobs should not block a new import")
	}
}

// TestLoseItImportHandler_RejectsSecondConcurrentImport exercises the guard
// as wired into the actual HTTP handler, via a minimal *core.RequestEvent
// (no real HTTP round-trip, matching how e.App/e.Auth are the only fields
// the handler touches).
func TestLoseItImportHandler_RejectsSecondConcurrentImport(t *testing.T) {
	app, user := newTestAppWithUser(t)
	seedImportJob(t, app, user.Id, "running")

	e := &core.RequestEvent{}
	e.App = app
	e.Auth = user
	e.Request = httptest.NewRequest(http.MethodPost, "/api/saolrian/import/loseit", strings.NewReader("{}"))
	e.Request.Header.Set("Content-Type", "application/json")

	err := loseItImportHandler(e)
	if err == nil {
		t.Fatalf("expected an error rejecting the concurrent import, got nil")
	}
	apiErr, ok := err.(*router.ApiError)
	if !ok {
		t.Fatalf("expected a *router.ApiError, got %T (%v)", err, err)
	}
	if apiErr.Status != http.StatusConflict {
		t.Fatalf("status = %d, want %d", apiErr.Status, http.StatusConflict)
	}

	// exactly one import_jobs row must still exist for this user — the
	// handler must not have created a second one before rejecting.
	jobs, err := app.FindRecordsByFilter("import_jobs", "user = {:uid}", "", 0, 0, map[string]any{"uid": user.Id})
	if err != nil {
		t.Fatalf("failed to list import jobs: %v", err)
	}
	if len(jobs) != 1 {
		t.Fatalf("expected exactly 1 import job to remain, got %d", len(jobs))
	}
}

// TestSweepStaleImportJobs_MarksQueuedAndRunningAsFailed guards fix #2:
// on startup, any job left "running" or "queued" by a crashed/restarted
// process must be marked "failed" with an explanatory message instead of
// spinning forever in the UI.
func TestSweepStaleImportJobs_MarksQueuedAndRunningAsFailed(t *testing.T) {
	app, user := newTestAppWithUser(t)

	running := seedImportJob(t, app, user.Id, "running")
	queued := seedImportJob(t, app, user.Id, "queued")
	done := seedImportJob(t, app, user.Id, "done")
	failed := seedImportJob(t, app, user.Id, "failed")

	if err := SweepStaleImportJobs(app); err != nil {
		t.Fatalf("SweepStaleImportJobs failed: %v", err)
	}

	for _, tc := range []struct {
		name string
		id   string
		want string
	}{
		{"running", running.Id, "failed"},
		{"queued", queued.Id, "failed"},
		{"done", done.Id, "done"},
		{"failed", failed.Id, "failed"},
	} {
		rec, err := app.FindRecordById("import_jobs", tc.id)
		if err != nil {
			t.Fatalf("%s: job not found: %v", tc.name, err)
		}
		if got := rec.GetString("status"); got != tc.want {
			t.Errorf("%s: status = %q, want %q", tc.name, got, tc.want)
		}
	}

	sweptRunning, err := app.FindRecordById("import_jobs", running.Id)
	if err != nil {
		t.Fatalf("running job not found: %v", err)
	}
	if got := sweptRunning.GetString("error"); got != staleImportJobMessage {
		t.Errorf("error = %q, want %q", got, staleImportJobMessage)
	}

	// the pre-existing "done"/"failed" jobs must be untouched (no error
	// message stamped on them).
	untouchedDone, err := app.FindRecordById("import_jobs", done.Id)
	if err != nil {
		t.Fatalf("done job not found: %v", err)
	}
	if got := untouchedDone.GetString("error"); got != "" {
		t.Errorf("done job error = %q, want empty (sweep must not touch it)", got)
	}
}

// TestSweepStaleImportJobs_FiresOnAppServe verifies the sweep is actually
// reachable via the same OnServe hook main.go binds it to — not just
// callable in isolation — by binding an equivalent hook here and triggering
// it the way apis.Serve would (after migrations, before the listener
// starts).
func TestSweepStaleImportJobs_FiresOnAppServe(t *testing.T) {
	app, user := newTestAppWithUser(t)
	stuck := seedImportJob(t, app, user.Id, "running")

	app.OnServe().BindFunc(func(se *core.ServeEvent) error {
		if err := SweepStaleImportJobs(se.App); err != nil {
			t.Fatalf("SweepStaleImportJobs failed: %v", err)
		}
		return se.Next()
	})

	event := &core.ServeEvent{App: app}
	if err := app.OnServe().Trigger(event, func(e *core.ServeEvent) error {
		return nil // stand-in for apis.Serve starting the tcp listener
	}); err != nil {
		t.Fatalf("OnServe hook chain failed: %v", err)
	}

	rec, err := app.FindRecordById("import_jobs", stuck.Id)
	if err != nil {
		t.Fatalf("job not found: %v", err)
	}
	if got := rec.GetString("status"); got != "failed" {
		t.Errorf("status = %q, want %q (sweep should have fired via OnServe)", got, "failed")
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

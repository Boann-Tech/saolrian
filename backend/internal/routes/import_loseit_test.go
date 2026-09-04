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

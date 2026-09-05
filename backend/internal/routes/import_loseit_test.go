package routes

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	_ "github.com/boanntech/saolrian/backend/internal/migrations"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

// newTestMux builds a real PocketBase router (default middlewares, incl.
// loadAuthToken, plus this app's /api/saolrian routes) around the given test
// app, the same way PocketBase's own tests.ApiScenario does internally
// (see tests.ApiScenario.test in the vendored pocketbase module) — this lets
// handler tests exercise the actual HTTP layer (auth middleware, e.BindBody,
// status codes/response shape) rather than calling handler funcs directly.
//
// Unlike ApiScenario (which is built for a single request/response per
// scenario), this returns a reusable http.Handler so a test can drive
// several requests against the same app/data — needed for the job-creation
// + row-assertion flow and the two-user push isolation tests below.
func newTestMux(t *testing.T, app *tests.TestApp) http.Handler {
	t.Helper()

	baseRouter, err := apis.NewRouter(app)
	if err != nil {
		t.Fatalf("failed to build base router: %v", err)
	}

	serveEvent := new(core.ServeEvent)
	serveEvent.App = app
	serveEvent.Router = baseRouter

	var mux http.Handler
	err = app.OnServe().Trigger(serveEvent, func(e *core.ServeEvent) error {
		Register(e.Router)
		m, buildErr := e.Router.BuildMux()
		if buildErr != nil {
			return buildErr
		}
		mux = m
		return nil
	})
	if err != nil {
		t.Fatalf("failed to trigger serve event: %v", err)
	}
	return mux
}

// authedRequest builds an httptest request authenticated as the given user,
// the same way PocketBase's own middleware tests do (raw token in the
// "Authorization" header, no "Bearer " prefix — see loadAuthToken in the
// vendored apis/middlewares.go).
func authedRequest(t *testing.T, user *core.Record, method, url string, body []byte) *http.Request {
	t.Helper()
	token, err := user.NewAuthToken()
	if err != nil {
		t.Fatalf("failed to mint auth token: %v", err)
	}
	var req *http.Request
	if body != nil {
		req = httptest.NewRequest(method, url, bytes.NewReader(body))
	} else {
		req = httptest.NewRequest(method, url, nil)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", token)
	return req
}

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

// TestLoseItImportHandlerHTTP_CreatesJobAndPersistsCategories drives the
// handler through a real HTTP request (unlike
// TestLoseItImportHandler_CreatesJobAndProcessesAsync above, which seeds the
// import_jobs row by hand and calls runImportJob directly) so it actually
// exercises e.BindBody, the 202 response shape, e.Auth-based user scoping,
// and requestedCategories persistence end to end.
func TestLoseItImportHandlerHTTP_CreatesJobAndPersistsCategories(t *testing.T) {
	app, user := newTestAppWithUser(t)
	mux := newTestMux(t, app)

	body := []byte(`{
		"categories": {
			"diary": [{"date":"2023-05-02","name":"Toast","quantity":1,"unit":"serving","meal":"Breakfast","kcal":200}],
			"weight": [{"date":"2023-05-02","kg":91.5}]
		}
	}`)
	req := authedRequest(t, user, http.MethodPost, "/api/saolrian/import/loseit", body)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	res := rec.Result()

	if res.StatusCode != http.StatusAccepted {
		t.Fatalf("status = %d, want %d; body = %s", res.StatusCode, http.StatusAccepted, rec.Body.String())
	}

	var respBody struct {
		JobID string `json:"job_id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &respBody); err != nil {
		t.Fatalf("failed to decode response body %q: %v", rec.Body.String(), err)
	}
	if respBody.JobID == "" {
		t.Fatalf("expected a non-empty job_id in response, got %q", rec.Body.String())
	}

	job, err := app.FindRecordById("import_jobs", respBody.JobID)
	if err != nil {
		t.Fatalf("created job not found: %v", err)
	}
	if got := job.GetString("user"); got != user.Id {
		t.Errorf("job.user = %q, want %q (auth scoping via e.Auth.Id)", got, user.Id)
	}
	gotCategories := job.GetStringSlice("categories")
	wantCategories := []string{"diary", "weight"}
	if len(gotCategories) != len(wantCategories) {
		t.Fatalf("job.categories = %v, want %v", gotCategories, wantCategories)
	}
	for i, want := range wantCategories {
		if gotCategories[i] != want {
			t.Errorf("job.categories[%d] = %q, want %q", i, gotCategories[i], want)
		}
	}

	// the job runs asynchronously; wait for it to finish so its goroutine
	// doesn't leak past the test/app cleanup.
	waitForJobStatus(t, app, respBody.JobID, "done")
}

// TestLoseItImportHandlerHTTP_RejectsInvalidJSON exercises e.BindBody's
// error path through the real handler.
func TestLoseItImportHandlerHTTP_RejectsInvalidJSON(t *testing.T) {
	app, user := newTestAppWithUser(t)
	mux := newTestMux(t, app)

	req := authedRequest(t, user, http.MethodPost, "/api/saolrian/import/loseit", []byte(`{not valid json`))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
}

// TestLoseItImportHandlerHTTP_RequiresAuth exercises the RequireAuth
// middleware bound on the /api/saolrian group in Register — an
// unauthenticated request must never reach the handler.
func TestLoseItImportHandlerHTTP_RequiresAuth(t *testing.T) {
	app, _ := newTestAppWithUser(t)
	mux := newTestMux(t, app)

	req := httptest.NewRequest(http.MethodPost, "/api/saolrian/import/loseit", bytes.NewReader([]byte(`{}`)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d; body = %s", rec.Code, http.StatusUnauthorized, rec.Body.String())
	}
}

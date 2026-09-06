package routes

import (
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

// seedDiary writes one diary entry of `kcal` on the given UTC date.
func seedDiary(t *testing.T, app core.App, uid, slotID, date string, kcal float64) {
	t.Helper()
	col, err := app.FindCollectionByNameOrId("diary_entries")
	if err != nil {
		t.Fatalf("diary_entries missing: %v", err)
	}
	rec := core.NewRecord(col)
	rec.Set("user", uid)
	rec.Set("meal_slot", slotID)
	rec.Set("name_snapshot", "Test food")
	rec.Set("grams", 100)
	rec.Set("kcal", kcal)
	rec.Set("protein", 10)
	rec.Set("carbs", 20)
	rec.Set("fat", 5)
	rec.Set("logged_at", date+" 12:00:00.000Z")
	rec.Set("source", "manual")
	if err := app.Save(rec); err != nil {
		t.Fatalf("failed to seed diary entry: %v", err)
	}
}

func seedWeight(t *testing.T, app core.App, uid, date string, kg float64) {
	t.Helper()
	col, err := app.FindCollectionByNameOrId("weights")
	if err != nil {
		t.Fatalf("weights missing: %v", err)
	}
	rec := core.NewRecord(col)
	rec.Set("user", uid)
	rec.Set("kg", kg)
	rec.Set("measured_at", date+" 07:00:00.000Z")
	if err := app.Save(rec); err != nil {
		t.Fatalf("failed to seed weight: %v", err)
	}
}

func seedSlot(t *testing.T, app core.App, uid string) string {
	t.Helper()
	col, err := app.FindCollectionByNameOrId("meal_slots")
	if err != nil {
		t.Fatalf("meal_slots missing: %v", err)
	}
	rec := core.NewRecord(col)
	rec.Set("user", uid)
	rec.Set("name", "Lunch")
	rec.Set("sort_order", 0)
	if err := app.Save(rec); err != nil {
		t.Fatalf("failed to seed slot: %v", err)
	}
	return rec.Id
}

func TestBuildTrendsZeroFillsAndMarksUnloggedDays(t *testing.T) {
	app, user := newTestAppWithUser(t)
	slot := seedSlot(t, app, user.Id)
	today := time.Date(2026, 3, 10, 0, 0, 0, 0, time.UTC)

	// Two logged days with a three-day gap between them.
	seedDiary(t, app, user.Id, slot, "2026-03-05", 2000)
	seedDiary(t, app, user.Id, slot, "2026-03-09", 1800)

	out, err := buildTrends(app, user.Id, 7, today)
	if err != nil {
		t.Fatalf("buildTrends: %v", err)
	}

	days := out["days"].([]dayJSON)
	if len(days) != 7 {
		t.Fatalf("len(days) = %d, want 7 (one row per calendar day)", len(days))
	}
	if days[0].Date != "2026-03-04" || days[6].Date != "2026-03-10" {
		t.Fatalf("range = %s..%s, want 2026-03-04..2026-03-10", days[0].Date, days[6].Date)
	}

	byDate := map[string]dayJSON{}
	for _, d := range days {
		byDate[d.Date] = d
	}
	if got := byDate["2026-03-05"]; !got.Logged || got.Kcal != 2000 {
		t.Fatalf("2026-03-05 = %+v, want logged with 2000 kcal", got)
	}
	if got := byDate["2026-03-06"]; got.Logged || got.Kcal != 0 {
		t.Fatalf("2026-03-06 = %+v, want unlogged and zero-filled", got)
	}
}

func TestBuildTrendsBucketsByUTCDateNotLocal(t *testing.T) {
	app, user := newTestAppWithUser(t)
	slot := seedSlot(t, app, user.Id)
	today := time.Date(2026, 3, 10, 0, 0, 0, 0, time.UTC)

	// 23:30Z on the 7th belongs to the 7th, matching /summary's bucketing.
	col, _ := app.FindCollectionByNameOrId("diary_entries")
	rec := core.NewRecord(col)
	rec.Set("user", user.Id)
	rec.Set("meal_slot", slot)
	rec.Set("name_snapshot", "Late snack")
	rec.Set("kcal", 500)
	rec.Set("logged_at", "2026-03-07 23:30:00.000Z")
	rec.Set("source", "manual")
	if err := app.Save(rec); err != nil {
		t.Fatalf("save: %v", err)
	}

	out, err := buildTrends(app, user.Id, 7, today)
	if err != nil {
		t.Fatalf("buildTrends: %v", err)
	}

	for _, d := range out["days"].([]dayJSON) {
		if d.Date == "2026-03-07" && d.Kcal != 500 {
			t.Fatalf("2026-03-07 kcal = %v, want 500", d.Kcal)
		}
		if d.Date == "2026-03-08" && d.Kcal != 0 {
			t.Fatalf("2026-03-08 kcal = %v, want 0 — entry leaked across the UTC boundary", d.Kcal)
		}
	}
}

func TestBuildTrendsReturnsInsufficientForANewUser(t *testing.T) {
	app, user := newTestAppWithUser(t)
	today := time.Date(2026, 3, 10, 0, 0, 0, 0, time.UTC)

	out, err := buildTrends(app, user.Id, 90, today)
	if err != nil {
		t.Fatalf("a new user with no data must not error: %v", err)
	}

	est := out["estimate"].(estimateJSON)
	if est.Sufficient {
		t.Fatal("a user with no data cannot have a sufficient estimate")
	}
	if est.Reason == "" {
		t.Fatal("an insufficient estimate must carry a reason")
	}
}

func TestBuildTrendsScopesToTheRequestingUser(t *testing.T) {
	app, user := newTestAppWithUser(t)
	slot := seedSlot(t, app, user.Id)
	today := time.Date(2026, 3, 10, 0, 0, 0, 0, time.UTC)

	seedDiary(t, app, user.Id, slot, "2026-03-09", 1800)

	// A second user's data must never appear in the first user's payload.
	usersCol, _ := app.FindCollectionByNameOrId("users")
	other := core.NewRecord(usersCol)
	other.SetEmail("other-trends@example.com")
	other.SetPassword("test-password-123")
	if err := app.Save(other); err != nil {
		t.Fatalf("save other user: %v", err)
	}
	otherSlot := seedSlot(t, app, other.Id)
	seedDiary(t, app, other.Id, otherSlot, "2026-03-09", 9999)

	out, err := buildTrends(app, user.Id, 7, today)
	if err != nil {
		t.Fatalf("buildTrends: %v", err)
	}

	for _, d := range out["days"].([]dayJSON) {
		if d.Date == "2026-03-09" && d.Kcal != 1800 {
			t.Fatalf("2026-03-09 kcal = %v, want 1800 — another user's rows leaked in", d.Kcal)
		}
	}
}

func TestBuildTrendsComputesEMAOverWeighIns(t *testing.T) {
	app, user := newTestAppWithUser(t)
	today := time.Date(2026, 3, 10, 0, 0, 0, 0, time.UTC)

	seedWeight(t, app, user.Id, "2026-03-08", 80)
	seedWeight(t, app, user.Id, "2026-03-10", 82)

	out, err := buildTrends(app, user.Id, 7, today)
	if err != nil {
		t.Fatalf("buildTrends: %v", err)
	}

	weights := out["weights"].([]weightJSON)
	if len(weights) != 2 {
		t.Fatalf("len(weights) = %d, want 2", len(weights))
	}
	ema := out["ema"].([]emaJSON)
	if len(ema) != 3 {
		t.Fatalf("len(ema) = %d, want 3 (08th seed, 09th carried, 10th updated)", len(ema))
	}
	if !ema[1].Interpolated {
		t.Fatal("the 09th has no weigh-in and must be marked interpolated")
	}
}

// TestBuildTrendsReportsTheActualWindowNotTheConstant guards against a
// regression back to the trend.WindowDays constant: trend.Compute sets
// Estimate.WindowDays from len(days), the number of days actually handed to
// it, not from the package constant. A display range shorter than the
// 28-day estimation window (7 days here) must therefore report a
// window_days of 7, not 28.
func TestBuildTrendsReportsTheActualWindowNotTheConstant(t *testing.T) {
	app, user := newTestAppWithUser(t)
	today := time.Date(2026, 3, 10, 0, 0, 0, 0, time.UTC)

	out, err := buildTrends(app, user.Id, 7, today)
	if err != nil {
		t.Fatalf("buildTrends: %v", err)
	}

	est := out["estimate"].(estimateJSON)
	if est.WindowDays != 7 {
		t.Fatalf("window_days = %d, want 7 (the actual range in scope, not the 28-day constant)", est.WindowDays)
	}
}

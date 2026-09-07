package routes

import (
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

func profileFor(t *testing.T, app *tests.TestApp, uid string) *core.Record {
	t.Helper()
	p, err := app.FindFirstRecordByFilter("profiles", "user = {:uid}", map[string]any{"uid": uid})
	if err != nil {
		t.Fatalf("profile for %s: %v", uid, err)
	}
	return p
}

func TestDailyTargetsDerivesMacroGramsFromTheBudget(t *testing.T) {
	app, user := newTestAppWithUser(t)
	p := profileFor(t, app, user.Id)
	p.Set("protein_pct", 30)
	p.Set("carbs_pct", 40)
	p.Set("fat_pct", 30)
	if err := app.Save(p); err != nil {
		t.Fatalf("save profile: %v", err)
	}

	got := dailyTargets(p, 2000.0)

	// 30% of 2000 = 600 kcal / 4 kcal per gram = 150 g
	if got["protein_g"] != 150.0 {
		t.Errorf("protein_g = %v, want 150", got["protein_g"])
	}
	// 40% of 2000 = 800 / 4 = 200 g
	if got["carbs_g"] != 200.0 {
		t.Errorf("carbs_g = %v, want 200", got["carbs_g"])
	}
	// 30% of 2000 = 600 / 9 = 66.67 -> 67 g
	if got["fat_g"] != 67.0 {
		t.Errorf("fat_g = %v, want 67", got["fat_g"])
	}
}

func TestDailyTargetsUsesTheProfilesWaterAndStepGoals(t *testing.T) {
	app, user := newTestAppWithUser(t)
	p := profileFor(t, app, user.Id)
	p.Set("water_goal_ml", 3000)
	p.Set("steps_goal", 12000)
	if err := app.Save(p); err != nil {
		t.Fatalf("save profile: %v", err)
	}

	got := dailyTargets(p, 2000.0)

	if got["water_ml"] != 3000.0 {
		t.Errorf("water_ml = %v, want the profile's 3000", got["water_ml"])
	}
	if got["steps"] != 12000.0 {
		t.Errorf("steps = %v, want the profile's 12000", got["steps"])
	}
}

func TestDailyTargetsFallsBackToDefaultGoalsWhenUnset(t *testing.T) {
	app, user := newTestAppWithUser(t)
	p := profileFor(t, app, user.Id)

	got := dailyTargets(p, 2000.0)

	if got["water_ml"] != float64(DefaultWaterGoalML) {
		t.Errorf("water_ml = %v, want the %d default", got["water_ml"], DefaultWaterGoalML)
	}
	if got["steps"] != float64(DefaultStepsGoal) {
		t.Errorf("steps = %v, want the %d default", got["steps"], DefaultStepsGoal)
	}
}

func TestDailyTargetsReturnsZeroMacrosWithoutABudget(t *testing.T) {
	app, user := newTestAppWithUser(t)
	p := profileFor(t, app, user.Id)
	p.Set("protein_pct", 30)
	if err := app.Save(p); err != nil {
		t.Fatalf("save profile: %v", err)
	}

	got := dailyTargets(p, nil)

	if got["protein_g"] != 0.0 {
		t.Errorf("protein_g = %v, want 0 when there is no budget", got["protein_g"])
	}
}

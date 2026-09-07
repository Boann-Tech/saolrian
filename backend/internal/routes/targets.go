package routes

import (
	"github.com/pocketbase/pocketbase/core"

	"github.com/boanntech/saolrian/backend/internal/tdee"
)

// Defaults for the daily goals a user hasn't set. Kept here rather than in the
// frontend so the dashboard and the trends cards can't drift apart.
const (
	DefaultWaterGoalML = 2000
	DefaultStepsGoal   = 10000
)

// dailyTargets turns a profile plus the day's calorie budget into the concrete
// per-day targets the UI renders against: macros in grams, water in ml, steps.
//
// `budget` is `any` because callers get it from userBudget/trendsBudget, which
// return nil when the profile lacks the data to compute one. With no budget
// there are no macro targets — the UI is expected to omit the goal rather than
// invent one.
func dailyTargets(profile *core.Record, budget any) map[string]any {
	kcal, _ := budget.(float64)
	grams := func(pct, kcalPerGram float64) float64 {
		if kcal <= 0 || pct <= 0 {
			return 0
		}
		return tdee.Round(kcal * pct / 100 / kcalPerGram)
	}
	orDefault := func(v float64, fallback int) float64 {
		if v > 0 {
			return v
		}
		return float64(fallback)
	}
	return map[string]any{
		"protein_g": grams(profile.GetFloat("protein_pct"), 4),
		"carbs_g":   grams(profile.GetFloat("carbs_pct"), 4),
		"fat_g":     grams(profile.GetFloat("fat_pct"), 9),
		"water_ml":  orDefault(profile.GetFloat("water_goal_ml"), DefaultWaterGoalML),
		"steps":     orDefault(profile.GetFloat("steps_goal"), DefaultStepsGoal),
	}
}

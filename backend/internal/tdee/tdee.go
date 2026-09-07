// Package tdee computes daily calorie budgets from a user profile.
package tdee

import "math"

// Activity multipliers applied to BMR.
var activityMultipliers = map[string]float64{
	"sedentary": 1.2,
	"light":     1.375,
	"moderate":  1.55,
	"very":      1.725,
	"extreme":   1.9,
}

// Input describes everything needed to compute the budget.
type Input struct {
	Sex           string  // male / female / other
	HeightCM      float64
	AgeYears      float64
	WeightKG      float64
	BodyFatPct    float64 // 0 when unknown
	Formula       string  // mifflin / katch
	ActivityLevel string
	Goal          string  // lose / maintain / gain
	GoalRate      float64 // kg per week (negative for loss)
}

// BMR returns the basal metabolic rate (kcal/day).
func BMR(in Input) float64 {
	// Katch-McArdle when body fat is known and requested.
	if in.Formula == "katch" && in.BodyFatPct > 0 {
		lean := in.WeightKG * (1 - in.BodyFatPct/100)
		return 370 + 21.6*lean
	}

	// Mifflin-St Jeor.
	male := 10*in.WeightKG + 6.25*in.HeightCM - 5*in.AgeYears + 5
	female := male - 166 // female: -161 instead of +5
	switch in.Sex {
	case "male":
		return male
	case "female":
		return female
	default: // other: average of both
		return (male + female) / 2
	}
}

// KcalPerKG is the energy in a kilogram of bodyweight, divided by 7 to turn a
// weekly rate into a daily calorie adjustment.
const KcalPerKG = 7700

// Calorie floors: the lowest daily target we will hand a user, whatever rate
// they asked for. Usual clinical guidance is 1200 kcal/day for women and 1500
// for men; anything unknown gets the conservative floor.
const (
	floorMale    = 1500
	floorDefault = 1200
)

// CalorieFloor returns the minimum daily target for a given sex.
func CalorieFloor(sex string) float64 {
	if sex == "male" {
		return floorMale
	}
	return floorDefault
}

// Budget returns the daily calorie target (TDEE adjusted for the goal, then
// clamped up to the calorie floor).
func Budget(in Input) float64 {
	bmr := BMR(in)

	mult, ok := activityMultipliers[in.ActivityLevel]
	if !ok {
		mult = 1.55 // moderate fallback
	}
	tdee := bmr * mult

	// goal_rate is negative for loss, positive for gain, ignored when
	// maintaining.
	adjusted := tdee
	if in.Goal == "lose" || in.Goal == "gain" {
		adjusted = tdee + in.GoalRate*KcalPerKG/7
	}

	return math.Max(CalorieFloor(in.Sex), adjusted)
}

// Round rounds to the nearest whole calorie.
func Round(kcal float64) float64 {
	return math.Round(kcal)
}

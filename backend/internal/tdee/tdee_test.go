package tdee

import "testing"

// A 36-year-old 80kg/180cm male, moderately active: BMR 1750, TDEE 2712.5.
func adult() Input {
	return Input{
		Sex:           "male",
		HeightCM:      180,
		AgeYears:      36,
		WeightKG:      80,
		Formula:       "mifflin",
		ActivityLevel: "moderate",
		Goal:          "maintain",
	}
}

func TestBudgetAppliesWeeklyRate(t *testing.T) {
	in := adult()
	in.Goal = "lose"
	in.GoalRate = -1

	// 1 kg/wk = 7700 kcal over 7 days = 1100 kcal/day.
	if got, want := Budget(in), 2712.5-1100; got != want {
		t.Fatalf("Budget = %v, want %v", got, want)
	}
}

func TestBudgetIgnoresRateWhenMaintaining(t *testing.T) {
	in := adult()
	in.GoalRate = -1

	if got, want := Budget(in), 2712.5; got != want {
		t.Fatalf("Budget = %v, want %v", got, want)
	}
}

func TestBudgetNeverFallsBelowTheCalorieFloor(t *testing.T) {
	// BMR = 10*50 + 6.25*155 - 5*36 - 161 = 1127.75; sedentary x1.2 = 1353.3.
	// A 1 kg/wk deficit would ask for 253.3 kcal/day.
	in := Input{
		Sex:           "female",
		HeightCM:      155,
		AgeYears:      36,
		WeightKG:      50,
		Formula:       "mifflin",
		ActivityLevel: "sedentary",
		Goal:          "lose",
		GoalRate:      -1,
	}

	if got, want := Budget(in), CalorieFloor("female"); got != want {
		t.Fatalf("Budget = %v, want the floor %v", got, want)
	}
}

func TestCalorieFloorBySex(t *testing.T) {
	if got := CalorieFloor("male"); got != 1500 {
		t.Errorf("male floor = %v, want 1500", got)
	}
	if got := CalorieFloor("female"); got != 1200 {
		t.Errorf("female floor = %v, want 1200", got)
	}
	// Unknown/other falls back to the conservative floor.
	if got := CalorieFloor(""); got != 1200 {
		t.Errorf("unknown floor = %v, want 1200", got)
	}
}

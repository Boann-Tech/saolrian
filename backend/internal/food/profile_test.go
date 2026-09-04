package food

import (
	"math"
	"testing"
)

func TestEncodeDecodeRoundTripsAndPreservesAbsence(t *testing.T) {
	// iron is deliberately absent; carbohydrate is deliberately a real zero.
	p := Profile{"energy_kcal": 89, "protein": 1.1, "carbohydrate": 0}

	got := Decode(Encode(p))

	if len(got) != len(p) {
		t.Fatalf("round trip changed key count: got %d, want %d", len(got), len(p))
	}
	if v, ok := got["carbohydrate"]; !ok || v != 0 {
		t.Error("a real zero must survive the round trip as a present zero")
	}
	if _, ok := got["iron"]; ok {
		t.Error("an absent nutrient must not appear after the round trip")
	}
	if math.Abs(got["energy_kcal"]-89) > 0.01 {
		t.Errorf("energy_kcal = %v, want 89", got["energy_kcal"])
	}
}

func TestEncodeUsesNaNForAbsentSlots(t *testing.T) {
	vals := Encode(Profile{"energy_kcal": 100})
	if len(vals) != len(Nutrients) {
		t.Fatalf("encoded length = %d, want %d", len(vals), len(Nutrients))
	}
	ironAt, _ := Index("iron")
	if !math.IsNaN(float64(vals[ironAt])) {
		t.Errorf("absent iron encoded as %v, want NaN", vals[ironAt])
	}
}

func TestDecodeIgnoresUnknownTrailingSlots(t *testing.T) {
	// A pack built with a longer vocabulary must not panic on decode.
	vals := Encode(Profile{"energy_kcal": 100})
	vals = append(vals, 42)
	if got := Decode(vals); got["energy_kcal"] != 100 {
		t.Errorf("energy_kcal = %v, want 100", got["energy_kcal"])
	}
}

func TestScaleKeepsAbsentAbsent(t *testing.T) {
	got := Scale(Profile{"energy_kcal": 89, "protein": 1.1}, 1.5)
	if math.Abs(got["energy_kcal"]-133.5) > 0.001 {
		t.Errorf("energy_kcal = %v, want 133.5", got["energy_kcal"])
	}
	if _, ok := got["iron"]; ok {
		t.Error("Scale invented a nutrient that was absent")
	}
}

func TestValidate(t *testing.T) {
	tests := []struct {
		name    string
		p       Profile
		wantErr bool
	}{
		{"ok", Profile{"energy_kcal": 89, "iron": 0.3}, false},
		{"real zero ok", Profile{"iron": 0}, false},
		{"unknown key", Profile{"unobtainium": 1}, true},
		{"negative", Profile{"iron": -1}, true},
		{"NaN", Profile{"iron": math.NaN()}, true},
		{"unit error looks like over-max", Profile{"iron": 300000}, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := Validate(tc.p)
			if (err != nil) != tc.wantErr {
				t.Errorf("Validate() error = %v, wantErr %v", err, tc.wantErr)
			}
		})
	}
}

package main

import (
	"testing"

	"github.com/boanntech/saolrian/backend/internal/food"
	"github.com/boanntech/saolrian/backend/internal/foodpack/format"
)

func packOf(profiles ...food.Profile) format.Pack {
	p := format.Pack{Version: "test", NutrientKeys: food.Keys()}
	for i, prof := range profiles {
		p.Foods = append(p.Foods, format.RefFood{
			Source: "usda_sr", SourceID: string(rune('a' + i)),
			Name: "Test food", Nutrients: food.Encode(prof),
		})
	}
	p.Sources = []format.SourceInfo{{Source: "usda_sr", Rows: len(p.Foods)}}
	return p
}

func result(t *testing.T, p format.Pack, name string) CheckResult {
	t.Helper()
	for _, r := range runChecks(p) {
		if r.Name == name {
			return r
		}
	}
	t.Fatalf("check %q was not run", name)
	return CheckResult{}
}

func TestEnergyPresentCheck(t *testing.T) {
	ok := packOf(food.Profile{"energy_kcal": 89, "protein": 1})
	if !result(t, ok, "energy_present").Pass {
		t.Error("energy_present failed on a pack where every food has energy")
	}

	bad := packOf(food.Profile{"protein": 1})
	if result(t, bad, "energy_present").Pass {
		t.Error("energy_present passed on a food with no energy value")
	}
}

func TestRangesCheckCatchesUnitError(t *testing.T) {
	bad := packOf(food.Profile{"energy_kcal": 89, "iron": 300000})
	if result(t, bad, "ranges").Pass {
		t.Error("ranges passed on an implausible iron value")
	}
}

func TestAtwaterCheck(t *testing.T) {
	// 4*1.09 + 4*22.8 + 9*0.33 = 98.5 kcal vs a declared 89: ~10% off, fine.
	ok := packOf(food.Profile{
		"energy_kcal": 89, "protein": 1.09, "carbohydrate": 22.8, "fat": 0.33,
	})
	if !result(t, ok, "atwater").Pass {
		t.Error("atwater failed on a plausible banana")
	}

	// Fat scaled by 10 — the classic unit slip Atwater is here to catch.
	bad := packOf(food.Profile{
		"energy_kcal": 89, "protein": 1.09, "carbohydrate": 22.8, "fat": 33,
	})
	if result(t, bad, "atwater").Pass {
		t.Error("atwater passed on a food whose macros cannot produce its energy")
	}
}

// TestAtwaterFibreAdjustmentAvoidsFalsePositive uses real SR Legacy wheat
// bran figures (energy 216 kcal, protein 15.55 g, fat 4.25 g, carbohydrate
// by difference 64.51 g, fibre 42.8 g). Carbohydrate-by-difference includes
// fibre, so treating all of it as 4 kcal/g digestible carbohydrate
// estimates 358 kcal against a declared 216 — a 66% deviation on
// completely correct data, which is exactly the false suspect this check
// exists to avoid. Netting fibre out at 2 kcal/g instead of 4 brings the
// estimate to within the 30% tolerance.
func TestAtwaterFibreAdjustmentAvoidsFalsePositive(t *testing.T) {
	wheatBran := packOf(food.Profile{
		"energy_kcal": 216, "protein": 15.55, "fat": 4.25,
		"carbohydrate": 64.51, "fibre": 42.8,
	})
	if !result(t, wheatBran, "atwater").Pass {
		t.Error("atwater flagged wheat bran as suspect; the fibre adjustment should have cleared it")
	}
}

// TestAtwaterFibreAdjustmentGuardsNegativeNetCarb covers a food whose
// declared fibre exceeds its declared carbohydrate (a mapping-table
// factor error, not a real food) — the fibre-adjusted formula must clamp
// net carbohydrate at zero rather than let a negative term flatter the
// estimate.
func TestAtwaterFibreAdjustmentGuardsNegativeNetCarb(t *testing.T) {
	bad := packOf(food.Profile{
		"energy_kcal": 216, "protein": 15.55, "fat": 4.25,
		"carbohydrate": 10, "fibre": 42.8,
	})
	// est = 4*15.55 + 4*0 + 2*42.8 + 9*4.25 = 62.2 + 0 + 85.6 + 38.25 = 186.05
	// dev = |186.05-216|/216 ≈ 13.9%: within tolerance, proving the clamp
	// (not a large negative contribution) drives the estimate.
	if !result(t, bad, "atwater").Pass {
		t.Error("atwater should clamp net carbohydrate at zero rather than go negative")
	}
}

// TestAtwaterHardBoundFailsOnSingleCatastrophicFood proves the two-tier
// gate: a single food off by orders of magnitude must fail the check even
// though, spread across a large pack, it never trips the 10% fractional
// gate alone.
func TestAtwaterHardBoundFailsOnSingleCatastrophicFood(t *testing.T) {
	profiles := []food.Profile{}
	for i := 0; i < 20; i++ {
		// Plausible bananas: comfortably inside tolerance.
		profiles = append(profiles, food.Profile{
			"energy_kcal": 89, "protein": 1.09, "carbohydrate": 22.8, "fat": 0.33,
		})
	}
	// One food with a 1000x-magnitude error: declared 20 kcal, macros imply
	// 1700. 1/21 checked foods deviate over 30%, i.e. ~4.8% — comfortably
	// under the 10% fractional gate — but this single food is nowhere near
	// plausible and must fail the pack outright.
	profiles = append(profiles, food.Profile{
		"energy_kcal": 20, "protein": 100, "carbohydrate": 100, "fat": 100,
	})

	p := packOf(profiles...)
	r := result(t, p, "atwater")
	if r.Pass {
		t.Errorf("atwater passed a pack containing a food off by >100%%; detail: %s", r.Detail)
	}
}

// TestAtwaterSoftGateFailsOnHighFraction proves the fractional gate still
// does its job when many foods are moderately (30–100%) off, even though
// none individually crosses the hard bound.
func TestAtwaterSoftGateFailsOnHighFraction(t *testing.T) {
	profiles := []food.Profile{
		// One clearly plausible food.
		{"energy_kcal": 89, "protein": 1.09, "carbohydrate": 22.8, "fat": 0.33},
	}
	// Two foods declared 100 kcal whose macros imply 170
	// (4*10 + 4*10 + 9*10 = 170): 70% off — suspect, but nowhere near the
	// 100% hard bound. 2 of 3 checked foods (67%) exceed the tolerance,
	// well past the 10% fractional gate.
	for i := 0; i < 2; i++ {
		profiles = append(profiles, food.Profile{
			"energy_kcal": 100, "protein": 10, "carbohydrate": 10, "fat": 10,
		})
	}

	p := packOf(profiles...)
	r := result(t, p, "atwater")
	if r.Pass {
		t.Errorf("atwater passed a pack where most checked foods deviate over 30%%; detail: %s", r.Detail)
	}
}

func TestMacroSumCheck(t *testing.T) {
	bad := packOf(food.Profile{
		"energy_kcal": 89, "protein": 60, "carbohydrate": 60, "fat": 60, "water": 60,
	})
	if result(t, bad, "macro_sum").Pass {
		t.Error("macro_sum passed on components totalling far more than 100 g")
	}
}

func TestVocabularyCheck(t *testing.T) {
	bad := packOf(food.Profile{"energy_kcal": 89})
	bad.NutrientKeys = []string{"energy_kcal"}
	if result(t, bad, "vocabulary").Pass {
		t.Error("vocabulary passed on a pack built with a stale key list")
	}
}

func TestNonEmptyCheck(t *testing.T) {
	empty := packOf()
	if result(t, empty, "non_empty").Pass {
		t.Error("non_empty passed on a pack with no foods")
	}

	populated := packOf(food.Profile{"energy_kcal": 89, "protein": 1})
	if !result(t, populated, "non_empty").Pass {
		t.Error("non_empty failed on a pack containing a food")
	}
}

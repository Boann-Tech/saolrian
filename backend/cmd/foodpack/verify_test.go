package main

import (
	"strings"
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

// A confirmed, small gap in the source itself (see
// energyPresentMaxMissingFraction's doc comment) must not fail the build;
// only a fraction large enough to look like a mapping regression should.
func TestEnergyPresentCheckToleratesASmallConfirmedFraction(t *testing.T) {
	profiles := make([]food.Profile, 0, 200)
	for i := 0; i < 199; i++ {
		profiles = append(profiles, food.Profile{"energy_kcal": 89, "protein": 1})
	}
	profiles = append(profiles, food.Profile{"protein": 1}) // 1 of 200, 0.5%
	p := packOf(profiles...)
	r := result(t, p, "energy_present")
	if !r.Pass {
		t.Errorf("energy_present failed at a 0.5%% missing fraction, under the %.0f%% bound: %s",
			energyPresentMaxMissingFraction*100, r.Detail)
	}
}

func TestEnergyPresentCheckFailsOnALargeFraction(t *testing.T) {
	profiles := []food.Profile{
		{"energy_kcal": 89, "protein": 1},
		{"energy_kcal": 89, "protein": 1},
		{"protein": 1},
		{"protein": 1}, // 2 of 4, 50% -- far past the confirmed real-data gap
	}
	p := packOf(profiles...)
	if result(t, p, "energy_present").Pass {
		t.Error("energy_present passed at a 50% missing fraction; the tolerance must not admit a real mapping regression")
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

// A very-high-ash food (a mineral-dominated product like baking powder,
// not an ordinary one) must not trip the hard gate even at a catastrophic
// deviation: Atwater arithmetic simply does not model it. It must still
// count toward the fractional gate, so it stays visible in the reported
// percentage.
func TestAtwaterHighAshFoodExemptFromHardGate(t *testing.T) {
	profiles := []food.Profile{}
	for i := 0; i < 20; i++ {
		profiles = append(profiles, food.Profile{
			"energy_kcal": 89, "protein": 1.09, "carbohydrate": 22.8, "fat": 0.33,
		})
	}
	// Real SR Legacy baking powder shape: declared 53 kcal, mostly
	// carbohydrate-by-difference and ash, no protein or fat -- a 108%
	// deviation that would otherwise hard-fail the build.
	profiles = append(profiles, food.Profile{
		"energy_kcal": 53, "protein": 0, "fat": 0, "carbohydrate": 27.7, "ash": 67.3,
	})

	p := packOf(profiles...)
	r := result(t, p, "atwater")
	if !r.Pass {
		t.Errorf("atwater failed on a pack whose only >100%% deviation is a 67.3g/100g-ash food; detail: %s", r.Detail)
	}
	if !strings.Contains(r.Detail, "21") {
		t.Errorf("the exempt food must still be counted as checked/suspect so it stays visible in the percentage; detail: %s", r.Detail)
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

// SR Legacy's independently-measured (not by-difference) cooked-fish
// entries genuinely sum a little past 100g -- up to 106.5g for
// "Fish, salmon, chinook, cooked, dry heat" (fdc_id 171999), see the
// limit's doc comment -- and must not fail the build.
func TestMacroSumCheckAdmitsRealIndependentMeasurementNoise(t *testing.T) {
	realFish := packOf(food.Profile{
		"energy_kcal": 172, "protein": 25.72, "fat": 13.38, "carbohydrate": 0, "water": 65.6, "ash": 1.76,
	}) // sums to 106.46, SR Legacy fdc_id 171999
	if !result(t, realFish, "macro_sum").Pass {
		t.Error("macro_sum failed on SR Legacy's real, confirmed cooked-fish figures (106.46g); the 107 buffer must admit them")
	}
}

// The 107 buffer is still tight enough to catch what this check exists
// for: a column mapped onto the wrong canonical key, such as fibre folded
// into carbohydrate.
func TestMacroSumCheckStillCatchesADoubleCountedColumn(t *testing.T) {
	doubleCounted := packOf(food.Profile{
		"energy_kcal": 89, "protein": 25, "fat": 20, "carbohydrate": 70, "water": 10,
	}) // sums to 125, well past even the widened buffer
	if result(t, doubleCounted, "macro_sum").Pass {
		t.Error("macro_sum passed on a food whose components sum to 125g; the widened buffer must not admit a real mapping error")
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

// Four of the five sources require attribution as a condition of use, so a
// food that cannot be joined to a licence row is a licensing defect.
func TestCheckAttributionRequiresASourceRow(t *testing.T) {
	p := format.Pack{
		NutrientKeys: food.Keys(),
		Sources: []format.SourceInfo{
			{Source: "cnf", Region: "ca", Licence: "ogl-canada", URL: "https://example.test", Rows: 1},
		},
		Foods: []format.RefFood{
			goldenFoodOf("cnf", "1", "Banana, raw", food.Profile{"energy_kcal": 89}),
			goldenFoodOf("ciqual", "2", "Banane", food.Profile{"energy_kcal": 90}),
		},
	}
	got := checkAttribution(p)
	if got.Pass {
		t.Fatal("a food whose source has no attribution row must fail")
	}
	if !strings.Contains(got.Detail, "ciqual") {
		t.Errorf("detail %q does not name the unattributed source", got.Detail)
	}
}

// Each of licence, region and url is independently required: a
// SourceInfo missing just one of the three must still fail, and the
// message must name exactly the field(s) that are empty rather than
// leaving the reader to check all three.
func TestCheckAttributionRequiresLicenceAndURL(t *testing.T) {
	complete := format.SourceInfo{Source: "cnf", Region: "ca", Licence: "ogl-canada", URL: "https://example.test", Rows: 1}
	foods := []format.RefFood{goldenFoodOf("cnf", "1", "Banana, raw", food.Profile{"energy_kcal": 89})}

	for field, mutate := range map[string]func(format.SourceInfo) format.SourceInfo{
		"licence": func(s format.SourceInfo) format.SourceInfo { s.Licence = ""; return s },
		"region":  func(s format.SourceInfo) format.SourceInfo { s.Region = ""; return s },
		"url":     func(s format.SourceInfo) format.SourceInfo { s.URL = ""; return s },
	} {
		t.Run(field, func(t *testing.T) {
			p := format.Pack{
				NutrientKeys: food.Keys(),
				Sources:      []format.SourceInfo{mutate(complete)},
				Foods:        foods,
			}
			got := checkAttribution(p)
			if got.Pass {
				t.Fatalf("a source row missing %s must fail", field)
			}
			if !strings.Contains(got.Detail, field) {
				t.Errorf("detail %q does not name the missing field %q", got.Detail, field)
			}
		})
	}

	// The reverse: a SourceInfo with all three fields set must not trip
	// this branch (TestCheckAttributionPasses covers the whole-check
	// positive case; this confirms the branch itself doesn't fire).
	whole := format.Pack{NutrientKeys: food.Keys(), Sources: []format.SourceInfo{complete}, Foods: foods}
	if got := checkAttribution(whole); !got.Pass {
		t.Errorf("a fully-populated SourceInfo must not fail: %s", got.Detail)
	}
}

// A SourceInfo declared for a source that contributed zero foods to the
// pack is its own defect: the attribution screen would show a licence for
// data that was never actually shipped. This is distinct from every other
// branch, which is triggered by a food whose source lacks a row -- here
// the row exists but nothing points back to it.
func TestCheckAttributionCatchesSourceThatContributedNoFoods(t *testing.T) {
	p := format.Pack{
		NutrientKeys: food.Keys(),
		Sources: []format.SourceInfo{
			{Source: "cnf", Region: "ca", Licence: "ogl-canada", URL: "https://example.test", Rows: 1},
			{Source: "ciqual", Region: "fr", Licence: "etalab-2.0", URL: "https://example.test", Rows: 0},
		},
		Foods: []format.RefFood{goldenFoodOf("cnf", "1", "Banana, raw", food.Profile{"energy_kcal": 89})},
	}
	got := checkAttribution(p)
	if got.Pass {
		t.Fatal("a SourceInfo for a source that contributed no foods must fail")
	}
	if !strings.Contains(got.Detail, "ciqual") {
		t.Errorf("detail %q does not name the source that contributed nothing", got.Detail)
	}
}

// A Rows count that disagrees with the pack is how an attribution screen
// ends up quoting a number nobody can reproduce.
func TestCheckAttributionRequiresAccurateRowCounts(t *testing.T) {
	p := format.Pack{
		NutrientKeys: food.Keys(),
		Sources: []format.SourceInfo{
			{Source: "cnf", Region: "ca", Licence: "ogl-canada", URL: "https://example.test", Rows: 99},
		},
		Foods: []format.RefFood{goldenFoodOf("cnf", "1", "Banana, raw", food.Profile{"energy_kcal": 89})},
	}
	if got := checkAttribution(p); got.Pass {
		t.Fatal("a Rows count that disagrees with the pack must fail")
	}
}

// checkAttribution used to inspect only p.Sources; an adapter that
// declared a perfectly correct SourceInfo row but shipped every food with
// Licence: "" (or Region: "") would still pass, even though design
// section 2 makes licence a per-row field on food_ref, not just a
// per-source one.
func TestCheckAttributionRequiresPerFoodLicenceAndRegion(t *testing.T) {
	complete := format.SourceInfo{Source: "cnf", Region: "ca", Licence: "ogl-canada", URL: "https://example.test", Rows: 1}

	nutrients := food.Encode(food.Profile{"energy_kcal": 89})
	for field, rf := range map[string]format.RefFood{
		"licence": {Source: "cnf", SourceID: "1", Name: "Banana, raw", Region: "ca", Licence: "", Nutrients: nutrients},
		"region":  {Source: "cnf", SourceID: "1", Name: "Banana, raw", Region: "", Licence: "ogl-canada", Nutrients: nutrients},
	} {
		t.Run(field, func(t *testing.T) {
			p := format.Pack{
				NutrientKeys: food.Keys(),
				Sources:      []format.SourceInfo{complete},
				Foods:        []format.RefFood{rf},
			}
			got := checkAttribution(p)
			if got.Pass {
				t.Fatalf("a food missing its per-food %s must fail attribution", field)
			}
			if !strings.Contains(got.Detail, "per-food "+field) {
				t.Errorf("detail %q does not name the missing per-food %s", got.Detail, field)
			}
		})
	}
}

func TestCheckAttributionPasses(t *testing.T) {
	p := format.Pack{
		NutrientKeys: food.Keys(),
		Sources: []format.SourceInfo{
			{Source: "cnf", Region: "ca", Licence: "ogl-canada", URL: "https://example.test", Rows: 1},
		},
		Foods: []format.RefFood{goldenFoodOf("cnf", "1", "Banana, raw", food.Profile{"energy_kcal": 89})},
	}
	if got := checkAttribution(p); !got.Pass {
		t.Fatalf("well-formed pack failed: %s", got.Detail)
	}
}

func TestCheckSubNutrientsPassesOnAConsistentFood(t *testing.T) {
	p := packOf(food.Profile{
		"fat":                 10,
		"fat_saturated":       3,
		"fat_monounsaturated": 3,
		"fat_polyunsaturated": 3,
		"carbohydrate":        50,
		"sugars":              20,
		"starch":              20,
		"fibre":               5,
		"vitamin_a_rae":       100,
		"retinol":             90,
	})
	if got := result(t, p, "sub_nutrients"); !got.Pass {
		t.Fatalf("a consistent food must pass: %s", got.Detail)
	}
}

func TestCheckSubNutrientsFailsWhenFatSubtypesExceedTotal(t *testing.T) {
	p := packOf(food.Profile{
		"fat":                 10,
		"fat_saturated":       20,
		"fat_monounsaturated": 20,
		"fat_polyunsaturated": 20,
	})
	got := result(t, p, "sub_nutrients")
	if got.Pass {
		t.Fatal("fat subtypes summing to 6x total fat must fail")
	}
	if !strings.Contains(got.Detail, "fat") {
		t.Errorf("detail should name the food and the relation, got: %s", got.Detail)
	}
}

// A missing side of a relationship must be skipped, not treated as 0 --
// treating an absent denominator as 0 would make sum > 0*Mult true for
// almost any positive numerator, and absent is never the same as zero
// elsewhere in this codebase.
func TestCheckSubNutrientsSkipsFoodsMissingEitherSide(t *testing.T) {
	p := packOf(food.Profile{
		"fat_saturated":       50,
		"fat_monounsaturated": 50,
		// no "fat" key at all
	})
	if got := result(t, p, "sub_nutrients"); !got.Pass {
		t.Fatalf("a food missing the denominator must be skipped, not failed: %s", got.Detail)
	}

	p2 := packOf(food.Profile{
		"fat": 1,
		// no fat_saturated/mono/poly at all
	})
	if got := result(t, p2, "sub_nutrients"); !got.Pass {
		t.Fatalf("a food missing every numerator must be skipped, not failed: %s", got.Detail)
	}
}

// Below each relation's floor, a near-zero denominator makes the ratio
// meaningless (rounding noise between two trace figures), so it must not
// fail even though the numerator technically exceeds Mult times the
// denominator.
func TestCheckSubNutrientsIgnoresNearZeroTraceNoise(t *testing.T) {
	p := packOf(food.Profile{
		"fat":                 0,
		"fat_saturated":       0.01,
		"fat_monounsaturated": 0.01,
		"fat_polyunsaturated": 0,
	})
	if got := result(t, p, "sub_nutrients"); !got.Pass {
		t.Fatalf("trace-level values below the floor must not fail: %s", got.Detail)
	}
}

package main

import (
	"regexp"
	"strings"
	"testing"

	"github.com/boanntech/saolrian/backend/internal/food"
	"github.com/boanntech/saolrian/backend/internal/foodpack/format"
)

// TestGoldenTableLoads is the golden-table analogue of
// TestCheckedInMappingsLoad: the checked-in CSV must parse, and must carry
// the four foods the spec names plus every unit class.
func TestGoldenTableLoads(t *testing.T) {
	entries, err := loadGoldenTable()
	if err != nil {
		t.Fatalf("loadGoldenTable: %v", err)
	}
	if len(entries) < 4 {
		t.Fatalf("golden table has only %d entries; want at least the four spec-named foods", len(entries))
	}

	wantKeys := map[string]bool{"energy_kcal": false, "iron": false, "vitamin_d": false, "calcium": false}
	units := map[string]bool{} // nutrient unit -> seen
	for _, e := range entries {
		if _, ok := wantKeys[e.NutrientKey]; ok {
			wantKeys[e.NutrientKey] = true
		}
		n, ok := food.Lookup(e.NutrientKey)
		if !ok {
			t.Fatalf("entry references unknown canonical key %q", e.NutrientKey)
		}
		units[string(n.Unit)] = true
		if e.TolerancePct <= 0 {
			t.Errorf("entry %s/%s has non-positive tolerance_pct %v", e.Source, e.NutrientKey, e.TolerancePct)
		}
	}
	for k, seen := range wantKeys {
		if !seen {
			t.Errorf("golden table is missing an entry for %q (spec names banana kcal, spinach iron, salmon vitamin D, milk calcium)", k)
		}
	}
	for _, u := range []string{"kcal", "g", "mg", "ug"} {
		if !units[u] {
			t.Errorf("golden table has no entry anchoring unit class %q", u)
		}
	}
}

// goldenFoodOf builds a minimal RefFood for evalGolden tests.
func goldenFoodOf(source, sourceID, name string, prof food.Profile) format.RefFood {
	return format.RefFood{Source: source, SourceID: sourceID, Name: name, Nutrients: food.Encode(prof)}
}

func goldenPackOf(sources []string, foods ...format.RefFood) format.Pack {
	p := format.Pack{Version: "test", NutrientKeys: food.Keys(), Foods: foods}
	for _, s := range sources {
		p.Sources = append(p.Sources, format.SourceInfo{Source: s})
	}
	return p
}

func TestEvalGoldenPassesWithinTolerance(t *testing.T) {
	entries := []goldenEntry{
		{Source: "usda_sr", NameRegex: regexp.MustCompile(`(?i)banana`), NutrientKey: "energy_kcal", Expected: 89, TolerancePct: 5},
	}
	p := goldenPackOf([]string{"usda_sr"},
		goldenFoodOf("usda_sr", "1", "Bananas, raw", food.Profile{"energy_kcal": 90}))

	r := evalGolden(p, entries)
	if !r.Pass {
		t.Errorf("evalGolden failed a value within tolerance; detail: %s", r.Detail)
	}
}

func TestEvalGoldenFailsOutsideTolerance(t *testing.T) {
	entries := []goldenEntry{
		{Source: "usda_sr", NameRegex: regexp.MustCompile(`(?i)banana`), NutrientKey: "energy_kcal", Expected: 89, TolerancePct: 5},
	}
	p := goldenPackOf([]string{"usda_sr"},
		goldenFoodOf("usda_sr", "1", "Bananas, raw", food.Profile{"energy_kcal": 150}))

	r := evalGolden(p, entries)
	if r.Pass {
		t.Error("evalGolden passed a value far outside tolerance")
	}
	if !strings.Contains(r.Detail, "energy_kcal") {
		t.Errorf("detail should name the failing nutrient, got: %s", r.Detail)
	}
}

// TestEvalGoldenSkipsAbsentSource is the mechanism that lets the table grow
// across sources this branch does not implement yet: an entry whose source
// never appears in the pack must be skipped, not failed.
func TestEvalGoldenSkipsAbsentSource(t *testing.T) {
	entries := []goldenEntry{
		{Source: "cofid", NameRegex: regexp.MustCompile(`(?i)banana`), NutrientKey: "energy_kcal", Expected: 89, TolerancePct: 5},
	}
	// A pack that only ever produced usda_sr rows: cofid never appears in
	// Sources, so this entry must be skipped rather than failed for lack
	// of a match.
	p := goldenPackOf([]string{"usda_sr"},
		goldenFoodOf("usda_sr", "1", "Bananas, raw", food.Profile{"energy_kcal": 89}))

	r := evalGolden(p, entries)
	if r.Pass {
		t.Fatal("evalGolden passed, but every entry was skipped; the check went vacuous")
	}
	if !strings.Contains(r.Detail, "vacuous") {
		t.Errorf("a golden check with every entry skipped must say so, got: %s", r.Detail)
	}
}

// TestEvalGoldenFailsWhenSourcePresentButNoMatch is the core anti-vacuity
// guarantee: an entry whose source IS present but whose regex matches no
// food is a build-breaking FAIL, never a silent skip — otherwise a regex
// that drifts from the real data (a renamed food, a typo) would quietly
// stop checking anything at all.
func TestEvalGoldenFailsWhenSourcePresentButNoMatch(t *testing.T) {
	entries := []goldenEntry{
		{Source: "usda_sr", NameRegex: regexp.MustCompile(`(?i)banana`), NutrientKey: "energy_kcal", Expected: 89, TolerancePct: 5},
	}
	p := goldenPackOf([]string{"usda_sr"},
		goldenFoodOf("usda_sr", "1", "Spinach, raw", food.Profile{"energy_kcal": 23}))

	r := evalGolden(p, entries)
	if r.Pass {
		t.Fatal("evalGolden passed even though its source is present and no food matched its regex")
	}
	if !strings.Contains(r.Detail, "no food name matched") {
		t.Errorf("detail should explain the no-match failure, got: %s", r.Detail)
	}
}

// TestEvalGoldenPicksLowestSourceIDOnMultipleMatches proves the documented
// deterministic tie-break: when a regex matches more than one food, the
// food with the lexicographically lowest SourceID is used.
func TestEvalGoldenPicksLowestSourceIDOnMultipleMatches(t *testing.T) {
	entries := []goldenEntry{
		{Source: "usda_sr", NameRegex: regexp.MustCompile(`(?i)banana`), NutrientKey: "energy_kcal", Expected: 89, TolerancePct: 5},
	}
	p := goldenPackOf([]string{"usda_sr"},
		goldenFoodOf("usda_sr", "2", "Bananas, dehydrated", food.Profile{"energy_kcal": 346}), // would fail tolerance
		goldenFoodOf("usda_sr", "1", "Bananas, raw", food.Profile{"energy_kcal": 89}),         // lower SourceID, matches
	)

	r := evalGolden(p, entries)
	if !r.Pass {
		t.Errorf("evalGolden should have picked SourceID \"1\" (within tolerance), not \"2\"; detail: %s", r.Detail)
	}
}

// TestEvalGoldenFailsWhenMatchedFoodLacksNutrient covers a food that
// matches the name pattern but, for whatever reason, has no value at all
// for the golden nutrient key — absent-is-not-zero means this must be
// reported as a failure, not silently treated as a pass or a zero.
func TestEvalGoldenFailsWhenMatchedFoodLacksNutrient(t *testing.T) {
	entries := []goldenEntry{
		{Source: "usda_sr", NameRegex: regexp.MustCompile(`(?i)banana`), NutrientKey: "iron", Expected: 0.26, TolerancePct: 20},
	}
	p := goldenPackOf([]string{"usda_sr"},
		goldenFoodOf("usda_sr", "1", "Bananas, raw", food.Profile{"energy_kcal": 89})) // no iron value

	r := evalGolden(p, entries)
	if r.Pass {
		t.Fatal("evalGolden passed for a matched food carrying no value for the golden nutrient")
	}
}

package source

import (
	"errors"
	"strings"
	"testing"

	"github.com/boanntech/saolrian/backend/internal/food"
	"github.com/boanntech/saolrian/backend/internal/foodpack/format"
)

func sampleInput(id, name string, prof food.Profile) FoodInput {
	return FoodInput{
		Source: "cnf", SourceID: id, Region: "ca", Licence: "ogl-canada",
		Name: name, Profile: prof,
	}
}

func TestBuilderAssemblesRefFood(t *testing.T) {
	b := NewBuilder()
	b.Add(FoodInput{
		Source: "cnf", SourceID: "12", Region: "ca", Licence: "ogl-canada",
		Name: "Banana, raw", SearchExtra: "banane crue",
		Profile:  food.Profile{"energy_kcal": 89, "protein": 1.09},
		Portions: []format.Portion{{Label: "1 medium", Grams: 118}, {Label: "1 cup", Grams: 150}},
	})

	foods := b.Foods()
	if len(foods) != 1 {
		t.Fatalf("got %d foods, want 1", len(foods))
	}
	f := foods[0]
	if f.Source != "cnf" || f.SourceID != "12" || f.Region != "ca" || f.Licence != "ogl-canada" {
		t.Errorf("provenance not carried through: %+v", f)
	}
	// The default serving is the first portion: sources list their most
	// representative measure first, and the pack has nowhere else to
	// record which one that is.
	if f.DefaultServingG != 118 {
		t.Errorf("DefaultServingG = %v, want 118", f.DefaultServingG)
	}
	if got := food.Decode(f.Nutrients)["energy_kcal"]; got != 89 {
		t.Errorf("energy_kcal = %v, want 89", got)
	}
	// SearchExtra exists so a CIQUAL food stays findable under its French
	// name even though it is stored under its English one.
	if !strings.Contains(f.SearchText, "banane") {
		t.Errorf("SearchText %q does not include the extra terms", f.SearchText)
	}
	if b.Rows()["cnf"] != 1 {
		t.Errorf("Rows()[cnf] = %d, want 1", b.Rows()["cnf"])
	}
}

// A food with no nutrient data at all is not worth shipping: it adds a row
// to every search result and answers no question.
func TestBuilderSkipsEmptyProfiles(t *testing.T) {
	b := NewBuilder()
	b.Add(sampleInput("1", "Nothing known", nil))
	b.Add(sampleInput("2", "Also nothing", food.Profile{}))
	if len(b.Foods()) != 0 {
		t.Fatalf("got %d foods, want 0", len(b.Foods()))
	}
}

// (source, source_id) is the unique index the seed migration relies on.
// Two rows sharing it would make the seed fail at 3am, not here.
func TestBuilderDedupesBySourceID(t *testing.T) {
	b := NewBuilder()
	b.Add(sampleInput("7", "First wins", food.Profile{"energy_kcal": 10}))
	b.Add(sampleInput("7", "Second loses", food.Profile{"energy_kcal": 20}))
	foods := b.Foods()
	if len(foods) != 1 {
		t.Fatalf("got %d foods, want 1", len(foods))
	}
	if foods[0].Name != "First wins" {
		t.Errorf("kept %q, want the first row", foods[0].Name)
	}
}

// Range violations are collected, not fatal on the first offender: fixing a
// mapping table one rebuild per defect is a wasted afternoon.
func TestBuilderCollectsRangeViolations(t *testing.T) {
	b := NewBuilder()
	b.Add(sampleInput("1", "Fine", food.Profile{"energy_kcal": 89}))
	b.Add(sampleInput("2", "Iron in ug not mg", food.Profile{"iron": 2710}))
	b.Add(sampleInput("3", "Also broken", food.Profile{"calcium": 999999}))

	if len(b.Foods()) != 1 {
		t.Errorf("got %d foods, want only the valid one", len(b.Foods()))
	}
	err := b.Err("cnf")
	if !errors.Is(err, food.ErrOutOfRange) {
		t.Fatalf("Err() = %v, want ErrOutOfRange", err)
	}
	for _, want := range []string{"cnf", "Iron in ug not mg", "Also broken"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %q", err.Error(), want)
		}
	}
}

func TestBuilderErrIsNilWhenClean(t *testing.T) {
	b := NewBuilder()
	b.Add(sampleInput("1", "Fine", food.Profile{"energy_kcal": 89}))
	if err := b.Err("cnf"); err != nil {
		t.Errorf("Err() = %v, want nil", err)
	}
}

func TestUnmappedCollectorReportsEachCodeOnce(t *testing.T) {
	c := NewUnmappedCollector()
	c.Note("9999", "Some new nutrient")
	c.Note("9999", "Some new nutrient")
	c.Note("8888", "Another")
	rep := c.Report()
	if strings.Count(rep, "9999") != 1 {
		t.Errorf("code reported %d times, want 1:\n%s", strings.Count(rep, "9999"), rep)
	}
	if !strings.Contains(rep, "8888") || !strings.Contains(rep, "Another") {
		t.Errorf("report is missing a code or its label:\n%s", rep)
	}
}

// A nil sink is the normal case; adapters must not have to check.
func TestNoteUnmappedToleratesNilSink(t *testing.T) {
	noteUnmapped(nil, "1", "x")
}

// A food named in the exclusion table is dropped silently as far as the
// range check is concerned: it must not appear in Foods(), must not turn
// up in Err(), and must be counted in Excluded() so the drop is visible
// somewhere.
func TestBuilderExcludesListedFoodWithoutFailingBuild(t *testing.T) {
	ex, err := ParseExclusions(strings.NewReader(
		"source,source_id,reason\ncnf,2,confirmed source error see report\n"))
	if err != nil {
		t.Fatalf("ParseExclusions: %v", err)
	}
	b := NewBuilder()
	b.SetExclusions(ex)
	b.Add(sampleInput("1", "Fine", food.Profile{"energy_kcal": 89}))
	b.Add(sampleInput("2", "Excluded despite the bad value", food.Profile{"iron": 2710}))

	foods := b.Foods()
	if len(foods) != 1 || foods[0].SourceID != "1" {
		t.Fatalf("Foods() = %v, want only source_id 1", foods)
	}
	if err := b.Err("cnf"); err != nil {
		t.Fatalf("Err() = %v, want nil: the excluded food must not count as a range violation", err)
	}
	if got := b.Excluded()["cnf"]; got != 1 {
		t.Errorf("Excluded()[cnf] = %d, want 1", got)
	}
}

// A food that violates a range check and is NOT on the exclusion table
// must still fail the build exactly as it did before exclusions existed.
func TestBuilderStillFailsOnRangeViolationNotExcluded(t *testing.T) {
	ex, err := ParseExclusions(strings.NewReader(
		"source,source_id,reason\ncnf,999,not the food this test adds\n"))
	if err != nil {
		t.Fatalf("ParseExclusions: %v", err)
	}
	b := NewBuilder()
	b.SetExclusions(ex)
	b.Add(sampleInput("2", "Iron in ug not mg", food.Profile{"iron": 2710}))

	if len(b.Foods()) != 0 {
		t.Errorf("got %d foods, want 0: an unlisted violation must still be dropped from Foods()", len(b.Foods()))
	}
	err = b.Err("cnf")
	if !errors.Is(err, food.ErrOutOfRange) {
		t.Fatalf("Err() = %v, want ErrOutOfRange: exclusions must not blunt the range guard for foods not on the list", err)
	}
	if got := b.Excluded()["cnf"]; got != 0 {
		t.Errorf("Excluded()[cnf] = %d, want 0", got)
	}
}

func TestFlushRoundingArtifactsZeroesSmallNegatives(t *testing.T) {
	in := food.Profile{"carbohydrate": -0.47505}
	out := flushRoundingArtifacts(in)
	if got := out["carbohydrate"]; got != 0 {
		t.Errorf("carbohydrate = %v, want 0", got)
	}
	// The input must be untouched: Add must not mutate a Profile map an
	// adapter still holds a reference to.
	if got := in["carbohydrate"]; got != -0.47505 {
		t.Errorf("input profile was mutated: carbohydrate = %v, want -0.47505 unchanged", got)
	}
}

func TestFlushRoundingArtifactsLeavesPastFloorNegativeForValidateToReject(t *testing.T) {
	out := flushRoundingArtifacts(food.Profile{"carbohydrate": -5})
	if got := out["carbohydrate"]; got != -5 {
		t.Errorf("carbohydrate = %v, want -5 unchanged (past the floor)", got)
	}
	if err := food.Validate(out); err == nil {
		t.Error("Validate must still reject a value past roundingArtifactFloor")
	}
}

func TestFlushRoundingArtifactsLeavesPositiveValuesUntouched(t *testing.T) {
	out := flushRoundingArtifacts(food.Profile{"protein": 12.5})
	if got := out["protein"]; got != 12.5 {
		t.Errorf("protein = %v, want 12.5 unchanged", got)
	}
}

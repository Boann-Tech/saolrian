package source

import (
	"errors"
	"math"
	"strings"
	"testing"

	"github.com/boanntech/saolrian/backend/internal/food"
	"github.com/boanntech/saolrian/backend/internal/foodpack/format"
)

const cnfTestMapping = `source_code,canonical_key,factor,note
208,energy_kcal,1,ENERGY (KILOCALORIES)
203,protein,1,PROTEIN
204,fat,1,FAT
205,carbohydrate,1,CARBOHYDRATE
291,fibre,1,FIBRE
301,calcium,1,CALCIUM
303,iron,1,IRON
317,selenium,1,SELENIUM
268,-,1,ENERGY (KILOJOULES); superseded by 208
`

func loadCNFFixture(t *testing.T, mappingCSV string) ([]format.RefFood, []format.SourceInfo) {
	t.Helper()
	m, err := LoadMapping(strings.NewReader(mappingCSV))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	foods, sources, err := LoadCNF(CNFOptions{Dir: "testdata/cnf", Mapping: m})
	if err != nil {
		t.Fatalf("LoadCNF: %v", err)
	}
	return foods, sources
}

func findByName(t *testing.T, foods []format.RefFood, substr string) format.RefFood {
	t.Helper()
	for _, f := range foods {
		if strings.Contains(f.Name, substr) {
			return f
		}
	}
	t.Fatalf("no food whose name contains %q; got %d foods", substr, len(foods))
	return format.RefFood{}
}

func TestLoadCNFReadsNutrients(t *testing.T) {
	foods, sources := loadCNFFixture(t, cnfTestMapping)

	// The ghost food has no nutrient rows at all and must not ship.
	if len(foods) != 2 {
		t.Fatalf("got %d foods, want 2 (the food with no data is dropped)", len(foods))
	}
	banana := findByName(t, foods, "Banana")
	if banana.Source != SourceCNF || banana.Region != "ca" || banana.Licence == "" {
		t.Errorf("provenance = %+v", banana)
	}
	prof := food.Decode(banana.Nutrients)
	for key, want := range map[string]float64{
		"energy_kcal": 89, "protein": 1.09, "fat": 0.33,
		"carbohydrate": 22.84, "fibre": 2.6, "iron": 0.26, "selenium": 1.0,
	} {
		if got := prof[key]; math.Abs(got-want) > 1e-6 {
			t.Errorf("%s = %v, want %v", key, got, want)
		}
	}

	if len(sources) != 1 || sources[0].Source != SourceCNF || sources[0].Rows != 2 {
		t.Errorf("sources = %+v, want one cnf row with Rows=2", sources)
	}
	if sources[0].URL == "" {
		t.Error("SourceInfo has no attribution URL; CNF is OGL-Canada and requires attribution")
	}
}

// CNF conversion factors multiply the per-100g figures, so grams are
// factor*100. Reading 1.18 as 1.18 g makes every portion a rounding error.
func TestLoadCNFConvertsPortionsToGrams(t *testing.T) {
	foods, _ := loadCNFFixture(t, cnfTestMapping)
	banana := findByName(t, foods, "Banana")

	if len(banana.Portions) != 2 {
		t.Fatalf("got %d portions, want 2", len(banana.Portions))
	}
	if got := banana.Portions[0].Grams; math.Abs(got-118) > 1e-6 {
		t.Errorf("first portion = %v g, want 118", got)
	}
	if !strings.Contains(banana.Portions[0].Label, "1 medium") {
		t.Errorf("portion label = %q", banana.Portions[0].Label)
	}
	if math.Abs(banana.DefaultServingG-118) > 1e-6 {
		t.Errorf("DefaultServingG = %v, want 118", banana.DefaultServingG)
	}
}

// The French name is not displayed but must stay searchable: a bilingual
// dataset that only answers to English throws away half of what it knows.
func TestLoadCNFKeepsFrenchNameSearchable(t *testing.T) {
	foods, _ := loadCNFFixture(t, cnfTestMapping)
	banana := findByName(t, foods, "Banana")
	if !strings.Contains(banana.SearchText, "banane") {
		t.Errorf("SearchText %q does not include the French name", banana.SearchText)
	}
	if strings.Contains(banana.Name, "Banane") {
		t.Errorf("Name %q should be the English description only", banana.Name)
	}
}

// A mapping row for a nutrient CNF does not define is a stale table that
// would silently drop the nutrient.
func TestLoadCNFRejectsStaleMapping(t *testing.T) {
	m, err := LoadMapping(strings.NewReader(cnfTestMapping + "1234,biotin,1,not in CNF\n"))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	_, _, err = LoadCNF(CNFOptions{Dir: "testdata/cnf", Mapping: m})
	if !errors.Is(err, ErrMappingNotInSource) {
		t.Fatalf("err = %v, want ErrMappingNotInSource", err)
	}
}

// A factor of 1 asserts the source already reports the canonical unit. If
// it does not, the factor is wrong and the values are off by 1000x.
func TestLoadCNFRejectsUnitDisagreement(t *testing.T) {
	// 303 IRON is mg in CNF; claiming it as selenium (canonical unit ug)
	// with factor 1 is the classic unit-disagreement bug: a genuine
	// mismatch that cnfCheckMapping must catch before it silently scales
	// every iron reading as if it were a microgram selenium reading.
	const bad = `source_code,canonical_key,factor,note
208,energy_kcal,1,ENERGY (KILOCALORIES)
203,protein,1,PROTEIN
204,fat,1,FAT
205,carbohydrate,1,CARBOHYDRATE
291,fibre,1,FIBRE
301,calcium,1,CALCIUM
303,selenium,1,wrong unit
268,-,1,ENERGY (KILOJOULES); superseded by 208
`
	m, err := LoadMapping(strings.NewReader(bad))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	_, _, err = LoadCNF(CNFOptions{Dir: "testdata/cnf", Mapping: m})
	if err == nil || !strings.Contains(err.Error(), "303") {
		t.Fatalf("err = %v, want a unit complaint naming 303", err)
	}
}

// Whoever writes the mapping table needs the list of what they have not
// covered; the dataset is the only authority on that.
func TestLoadCNFReportsUnmappedCodes(t *testing.T) {
	m, err := LoadMapping(strings.NewReader(cnfTestMapping))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	c := NewUnmappedCollector()
	if _, _, err := LoadCNF(CNFOptions{Dir: "testdata/cnf", Mapping: m, Unmapped: c.Note}); err != nil {
		t.Fatalf("LoadCNF: %v", err)
	}
	rep := c.Report()
	if !strings.Contains(rep, "9999") || !strings.Contains(rep, "SOMETHING NEW") {
		t.Errorf("report does not name the unmapped nutrient:\n%s", rep)
	}
	// 268 is explicitly ignored, not unmapped; conflating the two makes the
	// report useless.
	if strings.Contains(rep, "268") {
		t.Errorf("an explicitly ignored code must not be reported as unmapped:\n%s", rep)
	}
}

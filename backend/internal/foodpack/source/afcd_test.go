package source

import (
	"errors"
	"math"
	"strings"
	"testing"

	"github.com/boanntech/saolrian/backend/internal/food"
	"github.com/boanntech/saolrian/backend/internal/foodpack/format"
)

// AFCD reports energy in kilojoules only, so the mapping converts. 0.239006
// is 1/4.184, the thermochemical kJ-per-kcal.
const afcdTestMapping = `source_code,canonical_key,factor,note
"energy with dietary fibre, equated (kj)",energy_kcal,0.239006,kJ to kcal
protein (g),protein,1,Protein
"fat, total (g)",fat,1,Fat
"available carbohydrate, without sugar alcohols (g)",carbohydrate,1,Carbohydrate
total dietary fibre (g),fibre,1,Fibre
sodium (na) (mg),sodium,1,Sodium
iron (fe) (mg),iron,1,Iron
vitamin c (mg),vitamin_c,1,Vitamin C
"energy, without dietary fibre, equated (kj)",-,1,superseded by the with-fibre figure
`

// afcdFixture mirrors the real workbook, including the line breaks AFCD
// puts inside its column headings.
func afcdFixture(t *testing.T) string {
	t.Helper()
	return writeWorkbook(t, map[string][][]string{
		"All solids & liquids per 100g": {
			{
				"Public Food Key", "Classification", "Food Name",
				"Energy with dietary fibre, equated \n(kJ)",
				"Energy, without dietary fibre, equated \n(kJ)",
				"Protein \n(g)", "Fat, total \n(g)",
				"Available carbohydrate, without sugar alcohols \n(g)",
				"Total dietary fibre \n(g)", "Sodium (Na) \n(mg)",
				"Iron (Fe) \n(mg)", "Vitamin C \n(mg)", "Caffeine \n(mg)",
			},
			{"F009784", "24101", "Banana, cavendish, peeled, raw", "395", "372", "1.4", "0.2", "20.3", "2.4", "1", "0.3", "9", "0"},
			{"F000885", "19101", "Milk, cow, fluid, whole", "268", "268", "3.3", "3.4", "4.6", "0", "43", "0.1", "1", "0"},
			{"F999999", "99999", "Food with no data", "", "", "", "", "", "", "", "", "", ""},
		},
	})
}

func loadAFCDFixture(t *testing.T, mappingCSV string) ([]format.RefFood, []format.SourceInfo, error) {
	t.Helper()
	m, err := LoadMapping(strings.NewReader(mappingCSV))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	return LoadAFCD(AFCDOptions{
		File:    afcdFixture(t),
		Sheet:   "All solids & liquids per 100g",
		Mapping: m,
	})
}

func TestLoadAFCDReadsNutrients(t *testing.T) {
	foods, sources, err := loadAFCDFixture(t, afcdTestMapping)
	if err != nil {
		t.Fatalf("LoadAFCD: %v", err)
	}
	if len(foods) != 2 {
		t.Fatalf("got %d foods, want 2 (the empty row is dropped)", len(foods))
	}
	banana := findByName(t, foods, "Banana")
	if banana.Source != SourceAFCD || banana.Region != "au" || banana.SourceID != "F009784" {
		t.Errorf("provenance = %+v", banana)
	}
	prof := food.Decode(banana.Nutrients)
	for key, want := range map[string]float64{
		"protein": 1.4, "fat": 0.2, "carbohydrate": 20.3, "fibre": 2.4,
		"sodium": 1, "iron": 0.3, "vitamin_c": 9,
	} {
		if got := prof[key]; math.Abs(got-want) > 1e-6 {
			t.Errorf("%s = %v, want %v", key, got, want)
		}
	}
	if len(sources) != 1 || sources[0].Rows != 2 || sources[0].URL == "" {
		t.Errorf("sources = %+v; AFCD is CC-BY 3.0 AU and requires attribution", sources)
	}
}

// AFCD publishes no kcal column. Shipping its kilojoules as kilocalories
// would put every Australian food at 4.184x its real energy — the single
// most likely mistake in this whole plan.
func TestLoadAFCDConvertsKilojoulesToKilocalories(t *testing.T) {
	foods, _, err := loadAFCDFixture(t, afcdTestMapping)
	if err != nil {
		t.Fatalf("LoadAFCD: %v", err)
	}
	banana := findByName(t, foods, "Banana")
	got := food.Decode(banana.Nutrients)["energy_kcal"]
	if math.Abs(got-94.4) > 0.5 {
		t.Errorf("energy_kcal = %v, want ~94.4 (395 kJ); a value near 395 means the factor was not applied", got)
	}
}

// The multi-line headings AFCD uses are not a real difference; the mapping
// table must not have to reproduce them.
func TestLoadAFCDMatchesHeadersAcrossLineBreaks(t *testing.T) {
	foods, _, err := loadAFCDFixture(t, afcdTestMapping)
	if err != nil {
		t.Fatalf("LoadAFCD: %v", err)
	}
	banana := findByName(t, foods, "Banana")
	if _, ok := food.Decode(banana.Nutrients)["fibre"]; !ok {
		t.Error("Total dietary fibre did not match its mapping row across the line break in the heading")
	}
}

func TestLoadAFCDRejectsMissingColumn(t *testing.T) {
	_, _, err := loadAFCDFixture(t, afcdTestMapping+"selenium (se) (µg),selenium,1,not in this fixture\n")
	if !errors.Is(err, ErrMappingNotInSource) {
		t.Fatalf("err = %v, want ErrMappingNotInSource", err)
	}
}

func TestLoadAFCDReportsUnmappedColumns(t *testing.T) {
	m, err := LoadMapping(strings.NewReader(afcdTestMapping))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	c := NewUnmappedCollector()
	if _, _, err := LoadAFCD(AFCDOptions{
		File:     afcdFixture(t),
		Sheet:    "All solids & liquids per 100g",
		Mapping:  m,
		Unmapped: c.Note,
	}); err != nil {
		t.Fatalf("LoadAFCD: %v", err)
	}
	if rep := c.Report(); !strings.Contains(rep, "caffeine (mg)") {
		t.Errorf("report does not name the unmapped column:\n%s", rep)
	}
}

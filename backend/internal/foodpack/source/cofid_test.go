package source

import (
	"errors"
	"math"
	"strings"
	"testing"

	"github.com/boanntech/saolrian/backend/internal/food"
	"github.com/boanntech/saolrian/backend/internal/foodpack/format"
)

const cofidTestMapping = `source_code,canonical_key,factor,note
energy (kcal),energy_kcal,1,Energy kcal
protein (g),protein,1,Protein
fat (g),fat,1,Fat
carbohydrate (g),carbohydrate,1,Available carbohydrate
sodium (mg),sodium,1,Sodium
iron (mg),iron,1,Iron
selenium (µg),selenium,1,Selenium
vitamin c (mg),vitamin_c,1,Vitamin C
energy (kj),-,1,Energy kJ; superseded by kcal
`

// cofidFixture is the shape of the real workbook: a title block above the
// header row, nutrients split across sheets and joined on food code, and
// every sentinel CoFID uses.
func cofidFixture(t *testing.T) string {
	t.Helper()
	return writeWorkbook(t, map[string][][]string{
		"1.3 Proximates": {
			{"McCance and Widdowson's Composition of Foods Integrated Dataset"},
			{"Values per 100 g edible portion"},
			{"Food Code", "Food Name", "Energy (kcal)", "Energy (kJ)", "Protein (g)", "Fat (g)", "Carbohydrate (g)"},
			{"13-100", "Bananas, raw, flesh only", "95", "403", "1.2", "0.3", "23.2"},
			{"12-200", "Milk, whole, pasteurised", "66", "275", "3.4", "3.9", "4.5"},
			{"99-999", "Food with no data", "N", "N", "N", "N", "N"},
		},
		"1.4 Inorganics": {
			{"McCance and Widdowson's Composition of Foods Integrated Dataset"},
			{"Values per 100 g edible portion"},
			{"Food Code", "Food Name", "Sodium (mg)", "Iron (mg)", "Selenium (µg)", "Chloride (mg)"},
			{"13-100", "Bananas, raw, flesh only", "Tr", "0.3", "N", "79"},
			{"12-200", "Milk, whole, pasteurised", "42", "[0.1]", "1", "95"},
		},
		"1.5 Vitamins": {
			{"McCance and Widdowson's Composition of Foods Integrated Dataset"},
			{"Values per 100 g edible portion"},
			{"Food Code", "Food Name", "Vitamin C (mg)"},
			{"13-100", "Bananas, raw, flesh only", "11"},
			{"12-200", "Milk, whole, pasteurised", "<1"},
		},
	})
}

func loadCoFIDFixture(t *testing.T, mappingCSV string) ([]format.RefFood, []format.SourceInfo, error) {
	t.Helper()
	m, err := LoadMapping(strings.NewReader(mappingCSV))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	return LoadCoFID(CoFIDOptions{
		File:    cofidFixture(t),
		Sheets:  []string{"1.3 Proximates", "1.4 Inorganics", "1.5 Vitamins"},
		Mapping: m,
	})
}

func TestLoadCoFIDJoinsSheetsOnFoodCode(t *testing.T) {
	foods, sources, err := loadCoFIDFixture(t, cofidTestMapping)
	if err != nil {
		t.Fatalf("LoadCoFID: %v", err)
	}
	if len(foods) != 2 {
		t.Fatalf("got %d foods, want 2 (the all-N row is dropped)", len(foods))
	}

	banana := findByName(t, foods, "Bananas")
	prof := food.Decode(banana.Nutrients)
	// One food's profile is assembled from three sheets.
	for key, want := range map[string]float64{
		"energy_kcal": 95, "protein": 1.2, "fat": 0.3, "carbohydrate": 23.2,
		"iron": 0.3, "vitamin_c": 11,
	} {
		if got := prof[key]; math.Abs(got-want) > 1e-6 {
			t.Errorf("%s = %v, want %v", key, got, want)
		}
	}
	if banana.Source != SourceCoFID || banana.Region != "uk" {
		t.Errorf("provenance = %+v", banana)
	}
	if banana.SourceID != "13-100" {
		t.Errorf("SourceID = %q, want the food code", banana.SourceID)
	}
	if len(sources) != 1 || sources[0].Rows != 2 || sources[0].URL == "" {
		t.Errorf("sources = %+v; CoFID is OGL-UK and requires attribution", sources)
	}
}

func TestLoadCoFIDSentinels(t *testing.T) {
	foods, _, err := loadCoFIDFixture(t, cofidTestMapping)
	if err != nil {
		t.Fatalf("LoadCoFID: %v", err)
	}
	banana := findByName(t, foods, "Bananas")
	bp := food.Decode(banana.Nutrients)
	milk := findByName(t, foods, "Milk")
	mp := food.Decode(milk.Nutrients)

	// Tr: measured, negligible -> a real zero.
	if v, ok := bp["sodium"]; !ok || v != 0 {
		t.Errorf("banana sodium = %v, ok=%v; want a real 0 from Tr", v, ok)
	}
	// N: never measured -> absent.
	if _, ok := bp["selenium"]; ok {
		t.Error("banana selenium is present, but N means not measured")
	}
	// [0.1]: estimated, but the source vouches for it.
	//
	// float32Eq, not a raw math.Abs threshold: the value has made a
	// float64->float32->float64 round trip through food.Encode/Decode by
	// the time it reaches this test (0.1 comes back as
	// 0.10000000149011612), which a 1e-9 tolerance is too tight to absorb.
	if v := mp["iron"]; !float32Eq(v, 0.1) {
		t.Errorf("milk iron = %v, want 0.1 from [0.1]", v)
	}
	// <1: the bound is the most informative number available.
	if v := mp["vitamin_c"]; !float32Eq(v, 1) {
		t.Errorf("milk vitamin C = %v, want 1 from <1", v)
	}
}

// The mapping keys on header text, so a renamed column is a stale mapping
// and must fail exactly as a missing nutrient code does.
func TestLoadCoFIDRejectsMissingColumn(t *testing.T) {
	_, _, err := loadCoFIDFixture(t, cofidTestMapping+"biotin (µg),biotin,1,not in this release\n")
	if !errors.Is(err, ErrMappingNotInSource) {
		t.Fatalf("err = %v, want ErrMappingNotInSource", err)
	}
}

// The unit is in the header, so the same kJ-as-kcal guard applies.
func TestLoadCoFIDRejectsUnitDisagreement(t *testing.T) {
	bad := strings.Replace(cofidTestMapping, "energy (kcal),energy_kcal,1,Energy kcal", "energy (kcal),-,1,ignored", 1)
	bad = strings.Replace(bad, "energy (kj),-,1,Energy kJ; superseded by kcal", "energy (kj),energy_kcal,1,WRONG", 1)
	_, _, err := loadCoFIDFixture(t, bad)
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "kj") {
		t.Fatalf("err = %v, want a unit complaint naming the kJ column", err)
	}
}

// A configured sheet that is not in the workbook is silent data loss: a
// third of the nutrients would simply stop appearing.
func TestLoadCoFIDRejectsMissingSheet(t *testing.T) {
	m, err := LoadMapping(strings.NewReader(cofidTestMapping))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	_, _, err = LoadCoFID(CoFIDOptions{
		File:    cofidFixture(t),
		Sheets:  []string{"1.3 Proximates", "1.9 Not There"},
		Mapping: m,
	})
	if err == nil || !strings.Contains(err.Error(), "1.9 Not There") {
		t.Fatalf("err = %v, want an error naming the missing sheet", err)
	}
}

func TestLoadCoFIDReportsUnmappedColumns(t *testing.T) {
	m, err := LoadMapping(strings.NewReader(cofidTestMapping))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	c := NewUnmappedCollector()
	if _, _, err := LoadCoFID(CoFIDOptions{
		File:     cofidFixture(t),
		Sheets:   []string{"1.3 Proximates", "1.4 Inorganics", "1.5 Vitamins"},
		Mapping:  m,
		Unmapped: c.Note,
	}); err != nil {
		t.Fatalf("LoadCoFID: %v", err)
	}
	if rep := c.Report(); !strings.Contains(rep, "chloride (mg)") {
		t.Errorf("report does not name the unmapped column:\n%s", rep)
	}
}

func TestLoadCoFIDRejectsUnknownToken(t *testing.T) {
	path := writeWorkbook(t, map[string][][]string{
		"1.3 Proximates": {
			{"Food Code", "Food Name", "Energy (kcal)"},
			{"1", "Thing", "see footnote"},
		},
	})
	m, err := LoadMapping(strings.NewReader("source_code,canonical_key,factor,note\nenergy (kcal),energy_kcal,1,Energy\n"))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	_, _, err = LoadCoFID(CoFIDOptions{
		File: path, Sheets: []string{"1.3 Proximates"}, HeaderRow: 1, Mapping: m,
	})
	if !errors.Is(err, ErrUnknownToken) {
		t.Fatalf("err = %v, want ErrUnknownToken", err)
	}
}

// A blank name cell on the sheet where a food code first appears must not
// drop that sheet's nutrients: the food code is what identifies the row,
// not the name, and nothing guarantees CoFID carries the name on every
// sheet in every release.
func TestLoadCoFIDKeepsNutrientsWhenFirstSheetHasNoName(t *testing.T) {
	path := writeWorkbook(t, map[string][][]string{
		"1.3 Proximates": {
			{"Food Code", "Food Name", "Energy (kcal)", "Protein (g)"},
			{"20-100", "", "95", "1.2"},
			{"30-100", "", "50", "2.0"},
		},
		"1.4 Inorganics": {
			{"Food Code", "Food Name", "Sodium (mg)"},
			{"20-100", "Test Food One", "42"},
			{"30-100", "", "10"},
		},
	})
	m, err := LoadMapping(strings.NewReader("source_code,canonical_key,factor,note\n" +
		"energy (kcal),energy_kcal,1,Energy\n" +
		"protein (g),protein,1,Protein\n" +
		"sodium (mg),sodium,1,Sodium\n"))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	foods, _, err := LoadCoFID(CoFIDOptions{
		File:      path,
		Sheets:    []string{"1.3 Proximates", "1.4 Inorganics"},
		HeaderRow: 1,
		Mapping:   m,
	})
	if err != nil {
		t.Fatalf("LoadCoFID: %v", err)
	}
	if len(foods) != 1 {
		t.Fatalf("got %d foods, want 1 (30-100 never acquires a name and must be dropped)", len(foods))
	}
	f := foods[0]
	if f.SourceID != "20-100" || f.Name != "Test Food One" {
		t.Fatalf("food = %+v, want 20-100 / Test Food One", f)
	}
	prof := food.Decode(f.Nutrients)
	// energy_kcal and protein come from the FIRST sheet, where the name
	// cell was blank. If a blank name there ever skips the whole row
	// again, these two go missing while sodium (from the sheet that does
	// carry the name) still comes through -- so this checks all three,
	// not just that the food shipped.
	if v, ok := prof["energy_kcal"]; !ok || !float32Eq(v, 95) {
		t.Errorf("energy_kcal = %v, ok=%v; want 95 from the nameless first sheet", v, ok)
	}
	if v, ok := prof["protein"]; !ok || !float32Eq(v, 1.2) {
		t.Errorf("protein = %v, ok=%v; want 1.2 from the nameless first sheet", v, ok)
	}
	if v, ok := prof["sodium"]; !ok || !float32Eq(v, 42) {
		t.Errorf("sodium = %v, ok=%v; want 42 from the sheet that supplies the name", v, ok)
	}
}

// A food code that never acquires a name on any configured sheet is
// dropped, not shipped nameless -- even though it has nutrient data on
// more than one sheet.
func TestLoadCoFIDDropsFoodWithNoNameOnAnySheet(t *testing.T) {
	path := writeWorkbook(t, map[string][][]string{
		"1.3 Proximates": {
			{"Food Code", "Food Name", "Energy (kcal)"},
			{"30-100", "", "50"},
		},
		"1.4 Inorganics": {
			{"Food Code", "Food Name", "Sodium (mg)"},
			{"30-100", "", "10"},
		},
	})
	m, err := LoadMapping(strings.NewReader("source_code,canonical_key,factor,note\n" +
		"energy (kcal),energy_kcal,1,Energy\n" +
		"sodium (mg),sodium,1,Sodium\n"))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	foods, _, err := LoadCoFID(CoFIDOptions{
		File:      path,
		Sheets:    []string{"1.3 Proximates", "1.4 Inorganics"},
		HeaderRow: 1,
		Mapping:   m,
	})
	if err != nil {
		t.Fatalf("LoadCoFID: %v", err)
	}
	if len(foods) != 0 {
		t.Fatalf("got %d foods, want 0: a food with no name on any sheet must be dropped", len(foods))
	}
}

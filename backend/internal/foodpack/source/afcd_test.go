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
//
// The fatty acid rows mirror Release 3's units exactly: saturated, mono- and
// polyunsaturated are reported in grams and pass straight through, while
// trans alone is milligrams and carries a conversion. That asymmetry looks
// like a mistake and is not, so the fixture reproduces it rather than
// tidying it into four matching rows.
const afcdTestMapping = `source_code,canonical_key,factor,note
"energy with dietary fibre, equated (kj)",energy_kcal,0.239006,kJ to kcal
protein (g),protein,1,Protein
"fat, total (g)",fat,1,Fat
"available carbohydrate, without sugar alcohols (g)",carbohydrate,1,Carbohydrate
total dietary fibre (g),fibre,1,Fibre
sodium (na) (mg),sodium,1,Sodium
iron (fe) (mg),iron,1,Iron
vitamin c (mg),vitamin_c,1,Vitamin C
"total saturated fatty acids, equated (g)",fat_saturated,1,already grams
"total monounsaturated fatty acids, equated (g)",fat_monounsaturated,1,already grams
"total polyunsaturated fatty acids, equated (g)",fat_polyunsaturated,1,already grams
"total trans fatty acids, imputed (mg)",fat_trans,0.001,mg to g
"energy, without dietary fibre, equated (kj)",-,1,superseded by the with-fibre figure
`

// afcdTestSheet is the sheet Release 3 carries the per-100g profiles on, and
// the adapter's default. Fixtures use the real name and leave Sheet unset so
// a default that drifts away from the shipped workbook fails here.
const afcdTestSheet = "All solids & liquids per 100 g"

// afcdSheetRows puts the two title rows Release 3 prints above its column
// headings back on a fixture, so the header lands on row 3 where the adapter
// expects it. Without them a fixture would only ever prove the adapter can
// read a tidier file than the one the manifest points at.
func afcdSheetRows(rows ...[]string) [][]string {
	out := [][]string{{"Release 3 - Nutrient profiles (per 100 g)"}, {}}
	return append(out, rows...)
}

// afcdFixture mirrors the real workbook, including the line breaks AFCD
// puts inside its column headings.
func afcdFixture(t *testing.T) string {
	t.Helper()
	return writeWorkbook(t, map[string][][]string{
		afcdTestSheet: afcdSheetRows(
			[]string{
				"Public Food Key", "Classification", "Food Name",
				"Energy with dietary fibre, equated \n(kJ)",
				"Energy, without dietary fibre, equated \n(kJ)",
				"Protein \n(g)", "Fat, total \n(g)",
				"Available carbohydrate, without sugar alcohols \n(g)",
				"Total dietary fibre \n(g)", "Sodium (Na) \n(mg)",
				"Iron (Fe) \n(mg)", "Vitamin C \n(mg)", "Caffeine \n(mg)",
				"Total saturated fatty acids, equated \n(g)",
				"Total monounsaturated fatty acids, equated \n(g)",
				"Total polyunsaturated fatty acids, equated \n(g)",
				"Total trans fatty acids, imputed \n(mg)",
			},
			[]string{"F009784", "24101", "Banana, cavendish, peeled, raw", "395", "372", "1.4", "0.2", "20.3", "2.4", "1", "0.3", "9", "0", "1", "0.5", "0.3", "10"},
			[]string{"F000885", "19101", "Milk, cow, fluid, whole", "268", "268", "3.3", "3.4", "4.6", "0", "43", "0.1", "1", "0", "2.2", "0.9", "0.1", "100"},
			[]string{"F999999", "99999", "Food with no data", "", "", "", "", "", "", "", "", "", "", "", "", "", ""},
		),
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

// AFCD splits its fatty acid totals across two units: Release 3 reports
// saturated, mono- and polyunsaturated in grams, already canonical, but
// trans in milligrams. Only the trans row carries a factor, and
// headerMappingCheck's unit guard cannot verify it (it exempts any row whose
// factor is not 1, because such a row is asserting its own conversion).
//
// That leaves this test standing between a typo in mapping/afcd.csv and
// every Australian food shipping its trans fat at 1000x its real value --
// and, in the other direction, between a factor copied onto the three gram
// rows and all three shipping at 1/1000th. The fixture uses a different
// figure per nutrient so a mapping row pointed at the wrong canonical key is
// caught too, not just a wrong factor.
func TestLoadAFCDConvertsFattyAcidsToGrams(t *testing.T) {
	foods, _, err := loadAFCDFixture(t, afcdTestMapping)
	if err != nil {
		t.Fatalf("LoadAFCD: %v", err)
	}
	banana := findByName(t, foods, "Banana")
	prof := food.Decode(banana.Nutrients)
	for _, tc := range []struct {
		key, source string
		want        float64
	}{
		{"fat_saturated", "1 g", 1.0},
		{"fat_monounsaturated", "0.5 g", 0.5},
		{"fat_polyunsaturated", "0.3 g", 0.3},
		{"fat_trans", "10 mg", 0.01},
	} {
		got, ok := prof[tc.key]
		if !ok {
			t.Errorf("%s is missing; the mapping row did not match its fixture column", tc.key)
			continue
		}
		if !float32Eq(got, tc.want) {
			t.Errorf("%s = %v, want %v (source was %s); a value ~1000x out means a factor was dropped or "+
				"applied to a column that was already in grams, and a value matching a different row "+
				"means the mapping keys were swapped",
				tc.key, got, tc.want, tc.source)
		}
	}
}

// AFCD declares Absent: {"N", "-"} and Trace: {"Tr"}, but until now no
// fixture exercised any of the three: the design's sentinel rule
// (Absent -> no key at all, Trace -> a real, present 0.0) went untested in
// this adapter even though CoFID and CIQUAL both cover it for theirs.
//
// Release 3 turns out to write none of them -- every cell is a number or
// empty -- so this fixture is deliberately ahead of the shipped file. The
// sentinels stay declared because an undeclared one is fatal, and this test
// is what keeps them working for the release that reintroduces them.
func TestLoadAFCDSentinels(t *testing.T) {
	path := writeWorkbook(t, map[string][][]string{
		afcdTestSheet: afcdSheetRows(
			[]string{
				"Public Food Key", "Food Name",
				"Energy with dietary fibre, equated \n(kJ)",
				"Protein \n(g)", "Fat, total \n(g)",
				"Available carbohydrate, without sugar alcohols \n(g)",
				"Sodium (Na) \n(mg)", "Iron (Fe) \n(mg)", "Vitamin C \n(mg)",
			},
			[]string{"F000001", "Sentinel test food", "395", "1.4", "0.2", "20.3", "Tr", "N", "-"},
		),
	})
	m, err := LoadMapping(strings.NewReader("source_code,canonical_key,factor,note\n" +
		"\"energy with dietary fibre, equated (kj)\",energy_kcal,0.239006,kJ to kcal\n" +
		"protein (g),protein,1,Protein\n" +
		"\"fat, total (g)\",fat,1,Fat\n" +
		"\"available carbohydrate, without sugar alcohols (g)\",carbohydrate,1,Carbohydrate\n" +
		"sodium (na) (mg),sodium,1,Sodium\n" +
		"iron (fe) (mg),iron,1,Iron\n" +
		"vitamin c (mg),vitamin_c,1,Vitamin C\n"))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	foods, _, err := LoadAFCD(AFCDOptions{
		File:    path,
		Mapping: m,
	})
	if err != nil {
		t.Fatalf("LoadAFCD: %v", err)
	}
	if len(foods) != 1 {
		t.Fatalf("got %d foods, want 1", len(foods))
	}
	prof := food.Decode(foods[0].Nutrients)

	// Tr: measured, negligible -> a real, present zero.
	if v, ok := prof["sodium"]; !ok || v != 0 {
		t.Errorf("sodium = %v, ok=%v; want a real 0 from Tr", v, ok)
	}
	// N: never measured -> absent entirely.
	if _, ok := prof["iron"]; ok {
		t.Error("iron is present, but N means not measured")
	}
	// -: AFCD's alternative spelling of "not measured" -> also absent.
	if _, ok := prof["vitamin_c"]; ok {
		t.Error("vitamin_c is present, but - means not measured")
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
	_, _, err := loadAFCDFixture(t, afcdTestMapping+"selenium (se) (ug),selenium,1,not in this fixture\n")
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
		Mapping:  m,
		Unmapped: c.Note,
	}); err != nil {
		t.Fatalf("LoadAFCD: %v", err)
	}
	if rep := c.Report(); !strings.Contains(rep, "caffeine (mg)") {
		t.Errorf("report does not name the unmapped column:\n%s", rep)
	}
}

// Real AFCD workbooks carry free-text columns (Description, Group, Main
// data references, Footnote) alongside the numeric ones. If the mapping
// is consulted only after Parse, a value like "Cereals and cereal
// products" raises ErrUnknownToken and the build dies on the first data
// row; a column absent from the mapping table must never reach Parse.
func TestLoadAFCDIgnoresUnmappedFreeTextColumn(t *testing.T) {
	path := writeWorkbook(t, map[string][][]string{
		afcdTestSheet: afcdSheetRows(
			[]string{"Public Food Key", "Food Name", "Energy with dietary fibre, equated \n(kJ)", "Classification description"},
			[]string{"F009784", "Banana, cavendish, peeled, raw", "395", "Cereals and cereal products"},
		),
	})
	m, err := LoadMapping(strings.NewReader("source_code,canonical_key,factor,note\n" +
		"\"energy with dietary fibre, equated (kj)\",energy_kcal,0.239006,kJ to kcal\n"))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	foods, _, err := LoadAFCD(AFCDOptions{
		File:    path,
		Mapping: m,
	})
	if err != nil {
		t.Fatalf("LoadAFCD: %v (a free-text column not in the mapping must never reach Parse)", err)
	}
	if len(foods) != 1 {
		t.Fatalf("got %d foods, want 1", len(foods))
	}
	if _, ok := food.Decode(foods[0].Nutrients)["energy_kcal"]; !ok {
		t.Error("energy_kcal missing: the mapped column must still be read")
	}
}

// A column explicitly marked "-" in the mapping must also be skipped
// before Parse, not just after: the whole point of "-" is that its cells
// are never inspected.
func TestLoadAFCDNeverParsesAnExplicitlyIgnoredColumn(t *testing.T) {
	path := writeWorkbook(t, map[string][][]string{
		afcdTestSheet: afcdSheetRows(
			[]string{"Public Food Key", "Food Name", "Energy with dietary fibre, equated \n(kJ)", "Footnote"},
			[]string{"F009784", "Banana, cavendish, peeled, raw", "395", "not a number, not a sentinel either"},
		),
	})
	m, err := LoadMapping(strings.NewReader("source_code,canonical_key,factor,note\n" +
		"\"energy with dietary fibre, equated (kj)\",energy_kcal,0.239006,kJ to kcal\n" +
		"footnote,-,1,Free-text annotation; not a nutrient\n"))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	if _, _, err := LoadAFCD(AFCDOptions{
		File:    path,
		Mapping: m,
	}); err != nil {
		t.Fatalf("LoadAFCD: %v (an explicitly ignored column must never reach Parse)", err)
	}
}

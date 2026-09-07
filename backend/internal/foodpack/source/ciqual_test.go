package source

import (
	"errors"
	"math"
	"strings"
	"testing"

	"github.com/boanntech/saolrian/backend/internal/food"
	"github.com/boanntech/saolrian/backend/internal/foodpack/format"
)

const ciqualTestMapping = `source_code,canonical_key,factor,note
328,energy_kcal,1,Energy kcal
25001,protein,1,Protein
40000,fat,1,Fat
31000,carbohydrate,1,Carbohydrate
25000,water,1,Water
10120,calcium,1,Calcium
10200,iron,1,Iron
10400,sodium,1,Sodium
327,-,1,Energy kJ; superseded by 328
`

func loadCIQUALFixture(t *testing.T, mappingCSV string) ([]format.RefFood, []format.SourceInfo) {
	t.Helper()
	m, err := LoadMapping(strings.NewReader(mappingCSV))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	foods, sources, err := LoadCIQUAL(CIQUALOptions{Dir: "testdata/ciqual", Mapping: m})
	if err != nil {
		t.Fatalf("LoadCIQUAL: %v", err)
	}
	return foods, sources
}

func TestLoadCIQUALReadsNutrients(t *testing.T) {
	foods, sources := loadCIQUALFixture(t, ciqualTestMapping)
	if len(foods) != 2 {
		t.Fatalf("got %d foods, want 2 (the food with no COMPO rows is dropped)", len(foods))
	}
	banana := findByName(t, foods, "Banana")
	prof := food.Decode(banana.Nutrients)

	for key, want := range map[string]float64{
		"energy_kcal":  89, // decimal comma
		"protein":      1.09,
		"water":        74.9,
		"fat":          0.5,  // "< 0,5" takes the bound
		"carbohydrate": 20.0, // "[20,0]" estimated, taken at face value
	} {
		// float32Eq (usda_test.go): food.Encode/Decode round-trips every
		// value through float32, and 74.9 lands 1.53e-6 off its float64
		// value after that round trip -- just past a naive 1e-6 tolerance.
		if got := prof[key]; !float32Eq(got, want) {
			t.Errorf("%s = %v, want %v", key, got, want)
		}
	}

	// "traces" is a measurement of negligible, so a real zero...
	iron, ok := prof["iron"]
	if !ok || iron != 0 {
		t.Errorf("iron = %v, present=%v; want a real 0 from \"traces\"", iron, ok)
	}
	// ...while "-" was never measured and must not appear at all.
	if _, ok := prof["sodium"]; ok {
		t.Error(`sodium is present, but "-" means not measured`)
	}

	if len(sources) != 1 || sources[0].Source != SourceCIQUAL || sources[0].Region != "fr" {
		t.Errorf("sources = %+v", sources)
	}
	if sources[0].Rows != 2 || sources[0].URL == "" {
		t.Errorf("sources = %+v; CIQUAL is Licence Ouverte and requires attribution", sources)
	}
}

// The English name is what a user reads; the French one still has to find
// the food. When CIQUAL ships no English name, French is the name and the
// locale must say so.
func TestLoadCIQUALPrefersEnglishName(t *testing.T) {
	foods, _ := loadCIQUALFixture(t, ciqualTestMapping)

	banana := findByName(t, foods, "Banana")
	if banana.Name != "Banana, pulp, raw" {
		t.Errorf("Name = %q, want the English name", banana.Name)
	}
	if banana.NameLocale != "" {
		t.Errorf("NameLocale = %q, want empty for an English name", banana.NameLocale)
	}
	if !strings.Contains(banana.SearchText, "banane") {
		t.Errorf("SearchText %q does not include the French name", banana.SearchText)
	}

	milk := findByName(t, foods, "Lait")
	if milk.NameLocale != "fr" {
		t.Errorf("NameLocale = %q, want \"fr\" when only the French name exists", milk.NameLocale)
	}
}

func TestLoadCIQUALRejectsStaleMapping(t *testing.T) {
	m, err := LoadMapping(strings.NewReader(ciqualTestMapping + "77777,biotin,1,not in CIQUAL\n"))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	_, _, err = LoadCIQUAL(CIQUALOptions{Dir: "testdata/ciqual", Mapping: m})
	if !errors.Is(err, ErrMappingNotInSource) {
		t.Fatalf("err = %v, want ErrMappingNotInSource", err)
	}
}

// CIQUAL records a constituent's unit only inside its name. Reading it
// there is the difference between catching a kJ-as-kcal mapping and
// shipping every French food at 4.184x its real energy.
func TestLoadCIQUALRejectsUnitDisagreement(t *testing.T) {
	// 327 is kJ. Mapping it to energy_kcal with factor 1 is the exact bug
	// the cross-source check exists to catch; catch it here first.
	bad := strings.Replace(ciqualTestMapping, "328,energy_kcal,1,Energy kcal", "328,-,1,ignored", 1)
	bad = strings.Replace(bad, "327,-,1,Energy kJ; superseded by 328", "327,energy_kcal,1,WRONG", 1)
	m, err := LoadMapping(strings.NewReader(bad))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	_, _, err = LoadCIQUAL(CIQUALOptions{Dir: "testdata/ciqual", Mapping: m})
	if err == nil || !strings.Contains(err.Error(), "327") {
		t.Fatalf("err = %v, want a unit complaint naming 327", err)
	}
}

// A kJ column mapped with the right factor is legitimate and must not be
// blocked by the unit guard.
func TestLoadCIQUALAllowsDeliberateConversion(t *testing.T) {
	ok := strings.Replace(ciqualTestMapping, "328,energy_kcal,1,Energy kcal", "328,-,1,ignored", 1)
	ok = strings.Replace(ok, "327,-,1,Energy kJ; superseded by 328", "327,energy_kcal,0.239006,kJ to kcal", 1)
	m, err := LoadMapping(strings.NewReader(ok))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	foods, _, err := LoadCIQUAL(CIQUALOptions{Dir: "testdata/ciqual", Mapping: m})
	if err != nil {
		t.Fatalf("LoadCIQUAL: %v", err)
	}
	banana := findByName(t, foods, "Banana")
	if got := food.Decode(banana.Nutrients)["energy_kcal"]; math.Abs(got-88.7) > 0.5 {
		t.Errorf("energy_kcal = %v, want ~88.7 from 371 kJ", got)
	}
}

func TestLoadCIQUALReportsUnmappedCodes(t *testing.T) {
	m, err := LoadMapping(strings.NewReader(ciqualTestMapping))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	c := NewUnmappedCollector()
	if _, _, err := LoadCIQUAL(CIQUALOptions{Dir: "testdata/ciqual", Mapping: m, Unmapped: c.Note}); err != nil {
		t.Fatalf("LoadCIQUAL: %v", err)
	}
	if rep := c.Report(); !strings.Contains(rep, "60000") {
		t.Errorf("report does not name the unmapped constituent:\n%s", rep)
	}
}

// CIQUAL has shipped both as one file with COMPO nested inside ALIM and as
// three sibling files. The adapter must produce the same profiles either
// way: this loads both fixtures and pins the nested layout's output to the
// sibling layout's rather than to a second, separately maintained list of
// expected values that could quietly drift from the first.
//
// The nested fixture's water COMPO also omits its own alim_code, as real
// nested releases do because the parent ALIM already carries it, so this
// is the only test that exercises ciqualAlim's AlimCode backfill.
func TestLoadCIQUALNestedLayoutMatchesSiblingLayout(t *testing.T) {
	siblingFoods, _ := loadCIQUALFixture(t, ciqualTestMapping)

	m, err := LoadMapping(strings.NewReader(ciqualTestMapping))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	nestedFoods, nestedSources, err := LoadCIQUAL(CIQUALOptions{Dir: "testdata/ciqual-nested", Mapping: m})
	if err != nil {
		t.Fatalf("LoadCIQUAL (nested): %v", err)
	}
	if len(nestedFoods) != len(siblingFoods) {
		t.Fatalf("nested layout produced %d foods, sibling layout produced %d", len(nestedFoods), len(siblingFoods))
	}
	if len(nestedSources) != 1 || nestedSources[0].Rows != len(siblingFoods) {
		t.Errorf("nested sources = %+v", nestedSources)
	}

	for _, name := range []string{"Banana", "Lait"} {
		sibling := findByName(t, siblingFoods, name)
		nested := findByName(t, nestedFoods, name)
		siblingProf := food.Decode(sibling.Nutrients)
		nestedProf := food.Decode(nested.Nutrients)
		if len(nestedProf) != len(siblingProf) {
			t.Errorf("%s: nested profile has %d keys, sibling has %d: nested=%v sibling=%v",
				name, len(nestedProf), len(siblingProf), nestedProf, siblingProf)
			continue
		}
		for key, want := range siblingProf {
			got, ok := nestedProf[key]
			if !ok {
				t.Errorf("%s: nested profile is missing %q (sibling has %v)", name, key, want)
				continue
			}
			if !float32Eq(got, want) {
				t.Errorf("%s: nested %s = %v, sibling %s = %v", name, key, got, key, want)
			}
		}
	}
}

// An unrecognised token must stop the build rather than become a zero.
func TestLoadCIQUALRejectsUnknownToken(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "x.xml", []byte(`<TABLE>
  <ALIM><alim_code>1</alim_code><alim_nom_eng>Thing</alim_nom_eng></ALIM>
  <COMPO><alim_code>1</alim_code><const_code>328</const_code><teneur>voir note</teneur></COMPO>
  <CONST><const_code>328</const_code><const_nom_eng>Energy (kcal/100 g)</const_nom_eng></CONST>
</TABLE>`))

	m, err := LoadMapping(strings.NewReader("source_code,canonical_key,factor,note\n328,energy_kcal,1,Energy\n"))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	_, _, err = LoadCIQUAL(CIQUALOptions{Dir: dir, Mapping: m})
	if !errors.Is(err, ErrUnknownToken) {
		t.Fatalf("err = %v, want ErrUnknownToken", err)
	}
}

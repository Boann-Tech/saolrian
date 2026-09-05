package source

import (
	"encoding/csv"
	"errors"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/boanntech/saolrian/backend/internal/food"
)

// float32Eq compares against a value that made a float64->float32->float64
// round trip through food.Encode/Decode, as the codebase's own tests do
// (see internal/food/profile_test.go) rather than exact equality.
func float32Eq(got, want float64) bool {
	return math.Abs(got-want) < 1e-4
}

func TestLoadUSDAFiltersByDataType(t *testing.T) {
	m, _ := LoadNamedMapping("usda")
	foods, _, err := LoadUSDA(USDAOptions{
		Dir:       filepath.Join("testdata", "usda"),
		DataTypes: []string{"sr_legacy_food"},
		Mapping:   m,
	})
	if err != nil {
		t.Fatalf("LoadUSDA: %v", err)
	}
	if len(foods) != 2 {
		t.Fatalf("got %d foods, want 2 (branded must be excluded)", len(foods))
	}
	for _, f := range foods {
		if f.SourceID == "9999999" {
			t.Error("branded_food row was not filtered out")
		}
	}
}

func TestLoadUSDAMapsNutrientsAndKeepsAbsenceAbsent(t *testing.T) {
	m, _ := LoadNamedMapping("usda")
	foods, _, _ := LoadUSDA(USDAOptions{
		Dir: filepath.Join("testdata", "usda"), DataTypes: []string{"sr_legacy_food"}, Mapping: m,
	})

	for _, f := range foods {
		if f.SourceID != "1105314" {
			continue
		}
		if f.Name != "Bananas, raw" {
			t.Errorf("Name = %q", f.Name)
		}
		if f.Source != "usda_sr" || f.Region != "us" {
			t.Errorf("Source/Region = %q/%q, want usda_sr/us", f.Source, f.Region)
		}
		p := food.Decode(f.Nutrients)
		if !float32Eq(p["energy_kcal"], 89) {
			t.Errorf("energy_kcal = %v, want 89", p["energy_kcal"])
		}
		if !float32Eq(p["vitamin_c"], 8.7) {
			t.Errorf("vitamin_c = %v, want 8.7", p["vitamin_c"])
		}
		if _, ok := p["iron"]; ok {
			t.Error("banana has no iron row in the fixture; it must be absent, not zero")
		}
		return
	}
	t.Fatal("banana not found in output")
}

func TestLoadUSDASkipsIgnoredCodes(t *testing.T) {
	m, _ := LoadNamedMapping("usda")
	foods, _, _ := LoadUSDA(USDAOptions{
		Dir: filepath.Join("testdata", "usda"), DataTypes: []string{"sr_legacy_food"}, Mapping: m,
	})
	for _, f := range foods {
		if f.SourceID != "1103648" {
			continue
		}
		p := food.Decode(f.Nutrients)
		// nutrient_nbr 318 (Vitamin A IU) is mapped to "-" and must be dropped.
		if _, ok := p["vitamin_a_rae"]; ok {
			t.Error("ignored code 318 leaked into the profile")
		}
		if !float32Eq(p["iron"], 2.71) {
			t.Errorf("iron = %v, want 2.71", p["iron"])
		}
		return
	}
	t.Fatal("spinach not found in output")
}

func TestLoadUSDAExtractsPortions(t *testing.T) {
	m, _ := LoadNamedMapping("usda")
	foods, _, _ := LoadUSDA(USDAOptions{
		Dir: filepath.Join("testdata", "usda"), DataTypes: []string{"sr_legacy_food"}, Mapping: m,
	})
	for _, f := range foods {
		if f.SourceID != "1105314" {
			continue
		}
		if len(f.Portions) != 2 {
			t.Fatalf("got %d portions, want 2: %+v", len(f.Portions), f.Portions)
		}
		if f.Portions[0].Grams != 118 {
			t.Errorf("first portion grams = %v, want 118", f.Portions[0].Grams)
		}
		if f.Portions[0].Label == "" {
			t.Error("portion label must not be empty")
		}
		if f.DefaultServingG != 118 {
			t.Errorf("DefaultServingG = %v, want 118 (first portion)", f.DefaultServingG)
		}
		return
	}
	t.Fatal("banana not found in output")
}

// copyFixtures copies every file of the full "usda" fixture set into dir,
// so a negative test can mutate exactly one file and leave the rest of the
// dataset intact.
func copyFixtures(t *testing.T, dir string) {
	t.Helper()
	for _, name := range []string{"food.csv", "nutrient.csv", "food_nutrient.csv", "food_portion.csv", "measure_unit.csv"} {
		b, err := os.ReadFile(filepath.Join("testdata", "usda", name))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, name), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// readCSVRows parses a fixture CSV into header + data rows, for tests that
// need to rewrite it with one row removed or changed.
func readCSVRows(t *testing.T, path string) [][]string {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	rows, err := csv.NewReader(f).ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	return rows
}

func writeCSVRows(t *testing.T, path string, rows [][]string) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	w := csv.NewWriter(f)
	if err := w.WriteAll(rows); err != nil {
		t.Fatal(err)
	}
}

func TestLoadUSDARejectsMappedCodeMissingFromSource(t *testing.T) {
	// A mapping referencing a nutrient_nbr the dataset does not define is a
	// stale mapping; the build must fail loudly rather than drop data.
	dir := t.TempDir()
	copyFixtures(t, dir)

	// Remove the row whose nutrient_nbr is 208 (energy) from nutrient.csv,
	// leaving the rest of the full fixture untouched.
	nutrientPath := filepath.Join(dir, "nutrient.csv")
	rows := readCSVRows(t, nutrientPath)
	var kept [][]string
	for i, row := range rows {
		if i == 0 {
			kept = append(kept, row)
			continue
		}
		// columns: id, name, unit_name, nutrient_nbr, rank
		if len(row) > 3 && strings.TrimSpace(row[3]) == "208" {
			continue
		}
		kept = append(kept, row)
	}
	writeCSVRows(t, nutrientPath, kept)

	m, _ := LoadNamedMapping("usda")
	_, _, err := LoadUSDA(USDAOptions{Dir: dir, DataTypes: []string{"sr_legacy_food"}, Mapping: m})
	if !errors.Is(err, ErrMappingNotInSource) {
		t.Fatalf("error = %v, want ErrMappingNotInSource", err)
	}
}

func TestLoadUSDARejectsUnitMismatch(t *testing.T) {
	dir := t.TempDir()
	copyFixtures(t, dir)

	// Claim iron (nutrient_nbr 303) is in grams while the canonical unit is
	// mg and the factor is 1, leaving the rest of the full fixture intact.
	nutrientPath := filepath.Join(dir, "nutrient.csv")
	rows := readCSVRows(t, nutrientPath)
	for i, row := range rows {
		if i == 0 {
			continue
		}
		if len(row) > 3 && strings.TrimSpace(row[3]) == "303" {
			rows[i][2] = "G"
		}
	}
	writeCSVRows(t, nutrientPath, rows)

	m, _ := LoadNamedMapping("usda")
	_, _, err := LoadUSDA(USDAOptions{Dir: dir, DataTypes: []string{"sr_legacy_food"}, Mapping: m})
	if err == nil {
		t.Fatal("expected a unit mismatch error")
	}
	if errors.Is(err, ErrMappingNotInSource) {
		t.Fatalf("error = %v, want a unit mismatch error, not ErrMappingNotInSource", err)
	}
	if !strings.Contains(err.Error(), "unit") {
		t.Fatalf("error = %v, want message to mention the unit problem", err)
	}
}

// TestLoadUSDAAllowsDeliberateUnitConversion proves the flip side of
// TestLoadUSDARejectsUnitMismatch: when a mapping's factor is not 1, it is
// deliberately converting units (Task 4's documented case: "999,calcium,
// 0.001,source reports ug; canonical is mg"), so the unit guard must stand
// down instead of rejecting the mismatch, and the converted value must
// come through correctly.
func TestLoadUSDAAllowsDeliberateUnitConversion(t *testing.T) {
	dir := t.TempDir()
	copyFixtures(t, dir)

	// Add a nutrient row for a synthetic code that reports calcium in
	// micrograms (canonical unit is mg), and a food_nutrient row supplying
	// an amount for it on the banana (1105314). The rest of the full
	// fixture is untouched.
	nutrientPath := filepath.Join(dir, "nutrient.csv")
	rows := readCSVRows(t, nutrientPath)
	rows = append(rows, []string{"9099", "Calcium, Ca (test)", "UG", "999", "9999"})
	writeCSVRows(t, nutrientPath, rows)

	foodNutrientPath := filepath.Join(dir, "food_nutrient.csv")
	fnRows := readCSVRows(t, foodNutrientPath)
	fnRows = append(fnRows, []string{"8", "1105314", "9099", "5000.0"}) // 5000 ug
	writeCSVRows(t, foodNutrientPath, fnRows)

	// A minimal, in-memory mapping (not the checked-in mapping/usda.csv,
	// which stays factor-1 throughout) documenting exactly Task 4's
	// converting case.
	m, err := LoadMapping(strings.NewReader(
		"source_code,canonical_key,factor,note\n" +
			"999,calcium,0.001,source reports ug; canonical is mg\n"))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}

	foods, _, err := LoadUSDA(USDAOptions{Dir: dir, DataTypes: []string{"sr_legacy_food"}, Mapping: m})
	if err != nil {
		t.Fatalf("LoadUSDA: %v, want success (factor != 1 must stand down the unit guard)", err)
	}
	for _, f := range foods {
		if f.SourceID != "1105314" {
			continue
		}
		p := food.Decode(f.Nutrients)
		if !float32Eq(p["calcium"], 5) { // 5000 ug * 0.001 = 5 mg
			t.Errorf("calcium = %v, want 5 (converted from 5000 ug via factor 0.001)", p["calcium"])
		}
		return
	}
	t.Fatal("banana not found in output")
}

// TestLoadUSDARejectsDuplicateNutrientNumber covers the failure mode that
// made the build non-deterministic: the adapter keys everything on
// nutrient_nbr, so two ids claiming one nbr means Go map ordering decides
// which unit and which values survive. A dataset with genuine duplicates
// must fail loudly.
func TestLoadUSDARejectsDuplicateNutrientNumber(t *testing.T) {
	dir := t.TempDir()
	copyFixtures(t, dir)

	nutrientPath := filepath.Join(dir, "nutrient.csv")
	rows := readCSVRows(t, nutrientPath)
	// A second id claiming nutrient_nbr 303 (iron), in a different unit.
	rows = append(rows, []string{"9303", "Iron, Fe (duplicate)", "UG", "303", "9999"})
	writeCSVRows(t, nutrientPath, rows)

	m, _ := LoadNamedMapping("usda")
	_, _, err := LoadUSDA(USDAOptions{Dir: dir, DataTypes: []string{"sr_legacy_food"}, Mapping: m})
	if !errors.Is(err, ErrDuplicateNutrientNumber) {
		t.Fatalf("error = %v, want ErrDuplicateNutrientNumber", err)
	}
	// Naming only one of the two ids leaves the operator hunting.
	for _, want := range []string{"303", "1089", "9303"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error = %v, want it to mention %q", err, want)
		}
	}
}

// TestLoadUSDASkipsDuplicateFdcID: a repeated fdc_id would emit two
// RefFoods sharing one (source, source_id), breaking the unique index the
// seed migration depends on.
func TestLoadUSDASkipsDuplicateFdcID(t *testing.T) {
	dir := t.TempDir()
	copyFixtures(t, dir)

	foodPath := filepath.Join(dir, "food.csv")
	rows := readCSVRows(t, foodPath)
	rows = append(rows, []string{"1105314", "sr_legacy_food", "Bananas, raw (duplicate row)", "0900", "2019-04-01"})
	writeCSVRows(t, foodPath, rows)

	m, _ := LoadNamedMapping("usda")
	foods, _, err := LoadUSDA(USDAOptions{Dir: dir, DataTypes: []string{"sr_legacy_food"}, Mapping: m})
	if err != nil {
		t.Fatalf("LoadUSDA: %v", err)
	}
	seen := map[string]int{}
	for _, f := range foods {
		seen[f.Source+"/"+f.SourceID]++
	}
	for key, n := range seen {
		if n > 1 {
			t.Errorf("%s appears %d times; (source, source_id) must be unique", key, n)
		}
	}
	if seen["usda_sr/1105314"] != 1 {
		t.Errorf("banana appears %d times, want exactly 1", seen["usda_sr/1105314"])
	}
}

// TestLoadUSDACollectsAllRangeViolations: returning on the first offender
// makes a real-data build surface one defect per run. The report must name
// the total and list the offenders.
func TestLoadUSDACollectsAllRangeViolations(t *testing.T) {
	dir := t.TempDir()
	copyFixtures(t, dir)

	// Push iron (1089) far past its plausible maximum on the spinach row,
	// and energy (1008) past its maximum on the banana row, so two
	// different foods are out of range at once.
	fnPath := filepath.Join(dir, "food_nutrient.csv")
	rows := readCSVRows(t, fnPath)
	for i, row := range rows {
		if i == 0 || len(row) < 4 {
			continue
		}
		switch {
		case row[1] == "1103648" && row[2] == "1089":
			rows[i][3] = "900000"
		case row[1] == "1105314" && row[2] == "1008":
			rows[i][3] = "89000"
		}
	}
	writeCSVRows(t, fnPath, rows)

	m, _ := LoadNamedMapping("usda")
	_, _, err := LoadUSDA(USDAOptions{Dir: dir, DataTypes: []string{"sr_legacy_food"}, Mapping: m})
	if err == nil {
		t.Fatal("expected a range violation error")
	}
	if !errors.Is(err, food.ErrOutOfRange) {
		t.Fatalf("error = %v, want food.ErrOutOfRange", err)
	}
	msg := err.Error()
	if !strings.Contains(msg, "2 food(s)") {
		t.Errorf("error = %v, want it to report both offenders, not just the first", err)
	}
	for _, want := range []string{"1105314", "1103648", "energy_kcal", "iron"} {
		if !strings.Contains(msg, want) {
			t.Errorf("error = %v, want it to mention %q", err, want)
		}
	}
}

// TestLoadUSDARangeViolationsAreDeterministic: food.Validate used to
// iterate a Go map, so a food with two problems named a different nutrient
// on every run. A message that changes between runs is useless to whoever
// is fixing the mapping table.
func TestLoadUSDARangeViolationsAreDeterministic(t *testing.T) {
	dir := t.TempDir()
	copyFixtures(t, dir)

	// One food (spinach) with two out-of-range values at once.
	fnPath := filepath.Join(dir, "food_nutrient.csv")
	rows := readCSVRows(t, fnPath)
	for i, row := range rows {
		if i > 0 && len(row) >= 4 && row[1] == "1103648" {
			switch row[2] {
			case "1089":
				rows[i][3] = "900000"
			case "1008":
				rows[i][3] = "89000"
			}
		}
	}
	writeCSVRows(t, fnPath, rows)

	m, _ := LoadNamedMapping("usda")
	var first string
	for i := 0; i < 20; i++ {
		_, _, err := LoadUSDA(USDAOptions{Dir: dir, DataTypes: []string{"sr_legacy_food"}, Mapping: m})
		if err == nil {
			t.Fatal("expected a range violation error")
		}
		if i == 0 {
			first = err.Error()
			continue
		}
		if err.Error() != first {
			t.Fatalf("range report is not deterministic:\nrun 0: %s\nrun %d: %s", first, i, err.Error())
		}
	}
}

// TestLoadUSDAReturnsPerSubtypeSourceInfo: the CLI used to write a single
// SourceInfo with Source "usda", a value spec §2 does not define, while
// every food carried usda_foundation or usda_sr. Nothing could join a food
// to its attribution row.
func TestLoadUSDAReturnsPerSubtypeSourceInfo(t *testing.T) {
	dir := t.TempDir()
	copyFixtures(t, dir)

	// Promote the spinach row to a Foundation food so both subtypes appear.
	foodPath := filepath.Join(dir, "food.csv")
	rows := readCSVRows(t, foodPath)
	for i, row := range rows {
		if i > 0 && len(row) > 1 && row[0] == "1103648" {
			rows[i][1] = "foundation_food"
		}
	}
	writeCSVRows(t, foodPath, rows)

	m, _ := LoadNamedMapping("usda")
	foods, sources, err := LoadUSDA(USDAOptions{
		Dir: dir, DataTypes: []string{"foundation_food", "sr_legacy_food"}, Mapping: m,
	})
	if err != nil {
		t.Fatalf("LoadUSDA: %v", err)
	}
	if len(sources) != 2 {
		t.Fatalf("got %d SourceInfo entries, want 2 (one per subtype): %+v", len(sources), sources)
	}
	if sources[0].Source != SourceUSDAFoundation || sources[1].Source != SourceUSDASR {
		t.Errorf("source order = %q, %q; want a fixed %q, %q",
			sources[0].Source, sources[1].Source, SourceUSDAFoundation, SourceUSDASR)
	}

	rowsBySource := map[string]int{}
	for _, f := range foods {
		rowsBySource[f.Source]++
	}
	for _, s := range sources {
		if s.Rows != rowsBySource[s.Source] {
			t.Errorf("%s: SourceInfo.Rows = %d, but %d foods carry that source",
				s.Source, s.Rows, rowsBySource[s.Source])
		}
		if s.Region != "us" || s.Licence != "public-domain" || s.URL == "" {
			t.Errorf("%s: region/licence/url = %q/%q/%q", s.Source, s.Region, s.Licence, s.URL)
		}
	}
}

// TestLoadUSDAOmitsSubtypesWithNoRows: the fixture is SR Legacy only, so
// the pack must not advertise a Foundation attribution row with 0 rows.
func TestLoadUSDAOmitsSubtypesWithNoRows(t *testing.T) {
	m, _ := LoadNamedMapping("usda")
	_, sources, err := LoadUSDA(USDAOptions{
		Dir: filepath.Join("testdata", "usda"), DataTypes: []string{"sr_legacy_food"}, Mapping: m,
	})
	if err != nil {
		t.Fatalf("LoadUSDA: %v", err)
	}
	if len(sources) != 1 || sources[0].Source != SourceUSDASR {
		t.Fatalf("sources = %+v, want exactly one usda_sr entry", sources)
	}
}

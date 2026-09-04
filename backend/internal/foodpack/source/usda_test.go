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
	foods, err := LoadUSDA(USDAOptions{
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
	foods, _ := LoadUSDA(USDAOptions{
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
	foods, _ := LoadUSDA(USDAOptions{
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
	foods, _ := LoadUSDA(USDAOptions{
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
	_, err := LoadUSDA(USDAOptions{Dir: dir, DataTypes: []string{"sr_legacy_food"}, Mapping: m})
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
	_, err := LoadUSDA(USDAOptions{Dir: dir, DataTypes: []string{"sr_legacy_food"}, Mapping: m})
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

package source

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/xuri/excelize/v2"
)

// writeWorkbook builds a real .xlsx from a table literal. Fixtures are
// built rather than checked in so they stay diffable in review; the file is
// still read back through excelize, so the real path is exercised.
func writeWorkbook(t *testing.T, sheets map[string][][]string) string {
	t.Helper()
	f := excelize.NewFile()
	defer f.Close()

	first := true
	for name, rows := range sheets {
		if first {
			if err := f.SetSheetName(f.GetSheetName(0), name); err != nil {
				t.Fatalf("SetSheetName: %v", err)
			}
			first = false
		} else if _, err := f.NewSheet(name); err != nil {
			t.Fatalf("NewSheet %s: %v", name, err)
		}
		for r, row := range rows {
			for c, val := range row {
				cell, err := excelize.CoordinatesToCellName(c+1, r+1)
				if err != nil {
					t.Fatalf("CoordinatesToCellName: %v", err)
				}
				if err := f.SetCellStr(name, cell, val); err != nil {
					t.Fatalf("SetCellStr: %v", err)
				}
			}
		}
	}
	path := filepath.Join(t.TempDir(), "book.xlsx")
	if err := f.SaveAs(path); err != nil {
		t.Fatalf("SaveAs: %v", err)
	}
	return path
}

func TestNormaliseHeader(t *testing.T) {
	cases := map[string]string{
		"Food Code":           "food code",
		"  Vitamin C  (mg)  ": "vitamin c (mg)",
		"Energy with dietary fibre,\nequated \n(kJ)": "energy with dietary fibre, equated (kj)",
		"Sodium (mg)": "sodium (mg)",
	}
	for in, want := range cases {
		if got := normaliseHeader(in); got != want {
			t.Errorf("normaliseHeader(%q) = %q, want %q", in, got, want)
		}
	}
}

// Real workbooks and mapping tables have both been seen to use either
// spelling of mu ("µg" vs "μg") for micrograms. Two header strings
// differing only in which mu they use must normalise to the same string,
// or a mapping table and a workbook that disagree silently fail to match.
func TestNormaliseHeaderFoldsMuSpellings(t *testing.T) {
	micro := "Selenium (µg)" // MICRO SIGN
	greek := "Selenium (μg)" // GREEK SMALL LETTER MU
	got1, got2 := normaliseHeader(micro), normaliseHeader(greek)
	if got1 != got2 {
		t.Errorf("normaliseHeader(%q) = %q, normaliseHeader(%q) = %q; want equal", micro, got1, greek, got2)
	}
}

func TestReadSheetFindsHeaderRowAndCells(t *testing.T) {
	path := writeWorkbook(t, map[string][][]string{
		"Proximates": {
			{"McCance and Widdowson's Composition of Foods"},
			{"per 100 g edible portion"},
			{"Food Code", "Food Name", "Energy (kcal)", " Protein (g) "},
			{"13-100", "Bananas, raw", "95", "1.2"},
		},
	})
	f, err := excelize.OpenFile(path)
	if err != nil {
		t.Fatalf("OpenFile: %v", err)
	}
	defer f.Close()

	tbl, err := readSheet(f, "Proximates", 3)
	if err != nil {
		t.Fatalf("readSheet: %v", err)
	}
	if len(tbl.Rows) != 1 {
		t.Fatalf("got %d data rows, want 1", len(tbl.Rows))
	}
	if !tbl.Has("food code") || !tbl.Has("energy (kcal)") || !tbl.Has("protein (g)") {
		t.Errorf("headers = %v", tbl.Header)
	}
	if v, ok := tbl.Cell(tbl.Rows[0], "food name"); !ok || v != "Bananas, raw" {
		t.Errorf("food name = %q, ok=%v", v, ok)
	}
	if v, _ := tbl.Cell(tbl.Rows[0], "energy (kcal)"); v != "95" {
		t.Errorf("energy = %q", v)
	}
	if _, ok := tbl.Cell(tbl.Rows[0], "no such column"); ok {
		t.Error("an absent column must report ok=false, not an empty string")
	}
}

// Two columns normalising to the same header would make Cell return
// whichever won a map write. That is a different pack every build.
func TestReadSheetRejectsDuplicateHeaders(t *testing.T) {
	path := writeWorkbook(t, map[string][][]string{
		"S": {
			{"Iron (mg)", "Iron  (mg)"},
			{"1", "2"},
		},
	})
	f, err := excelize.OpenFile(path)
	if err != nil {
		t.Fatalf("OpenFile: %v", err)
	}
	defer f.Close()

	if _, err := readSheet(f, "S", 1); err == nil {
		t.Fatal("want an error for two columns with the same normalised header")
	}
}

func TestReadSheetRejectsMissingSheet(t *testing.T) {
	path := writeWorkbook(t, map[string][][]string{"S": {{"a"}, {"1"}}})
	f, err := excelize.OpenFile(path)
	if err != nil {
		t.Fatalf("OpenFile: %v", err)
	}
	defer f.Close()

	if _, err := readSheet(f, "Not There", 1); err == nil {
		t.Fatal("want an error naming the missing sheet")
	}
}

func TestFindWorkbook(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "cofid.xlsx", []byte("x"))
	got, err := findWorkbook(dir, "")
	if err != nil {
		t.Fatalf("findWorkbook: %v", err)
	}
	if filepath.Base(got) != "cofid.xlsx" {
		t.Errorf("found %q", got)
	}

	// Two workbooks is ambiguous: picking one silently would build a
	// different pack depending on directory order.
	writeFile(t, dir, "other.xlsx", []byte("x"))
	if _, err := findWorkbook(dir, ""); err == nil {
		t.Fatal("want an error when the directory holds two workbooks")
	}

	// An explicit path wins, which is how a caller resolves that.
	if got, err := findWorkbook(dir, filepath.Join(dir, "other.xlsx")); err != nil || filepath.Base(got) != "other.xlsx" {
		t.Errorf("explicit path: got %q, err %v", got, err)
	}
}

// TestHeaderMappingCheckRejectsUnitDisagreement is the plain case: a
// mapping row with a factor of 1 is claiming the source and canonical
// units already agree, so a header that states a different unit is a
// mapping bug, not a conversion, and must be rejected.
func TestHeaderMappingCheckRejectsUnitDisagreement(t *testing.T) {
	m, err := LoadMapping(strings.NewReader(
		"source_code,canonical_key,factor,note\n" +
			"sodium (g),sodium,1,wrong unit on purpose\n"))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	headers := map[string]bool{"sodium (g)": true}
	if err := headerMappingCheck("test", m, headers, "mapping/test.csv"); err == nil {
		t.Fatal("want an error: header states g, canonical unit is mg, and the factor is 1")
	}
}

// TestHeaderMappingCheckAcceptsDeliberateUnitConversion is the load-bearing
// counterpart to the rejection above, and the one the unit guard has no way
// to check for itself: when a mapping row's factor is not 1, the row is
// asserting its own unit conversion, so a header stating a unit that
// disagrees with the canonical one must be ACCEPTED, not flagged as a
// mismatch. This is the AFCD energy row for real: the header says kJ, the
// canonical unit is kcal, and 0.239006 (1/4.184) converts one into the
// other, so the guard has to stand down here rather than reject it.
//
// Read this test's name twice before touching it -- it is proving the
// guard stays quiet, not that it fires.
func TestHeaderMappingCheckAcceptsDeliberateUnitConversion(t *testing.T) {
	m, err := LoadMapping(strings.NewReader(
		"source_code,canonical_key,factor,note\n" +
			"\"energy with dietary fibre, equated (kj)\",energy_kcal,0.239006,kJ to kcal\n"))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	headers := map[string]bool{"energy with dietary fibre, equated (kj)": true}
	if err := headerMappingCheck("afcd", m, headers, "mapping/afcd.csv"); err != nil {
		t.Fatalf("headerMappingCheck = %v, want nil: a factor that is not 1 is a deliberate conversion and must not trip the unit guard", err)
	}
}

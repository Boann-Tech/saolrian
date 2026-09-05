package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/boanntech/saolrian/backend/internal/food"
	"github.com/boanntech/saolrian/backend/internal/foodpack/format"
	"github.com/boanntech/saolrian/backend/internal/foodpack/source"
)

// TestWritePackAtomicallyLeavesDestinationUntouchedOnFailure proves that a
// failed build does not destroy whatever was already at --out. It forces
// the final os.Rename to fail (by making the destination path an existing
// directory rather than a file) and checks that the directory and its
// contents survive the failed attempt, and that no temp file is left
// behind in the working directory.
func TestWritePackAtomicallyLeavesDestinationUntouchedOnFailure(t *testing.T) {
	dir := t.TempDir()
	out := filepath.Join(dir, "pack.bin.zst")

	// Stand in for a pre-existing, good pack: a directory (so the rename
	// into it is guaranteed to fail) holding a marker file we can check
	// survived.
	if err := os.Mkdir(out, 0o755); err != nil {
		t.Fatalf("Mkdir: %v", err)
	}
	marker := filepath.Join(out, "marker.txt")
	if err := os.WriteFile(marker, []byte("sentinel"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	pack := packOf(food.Profile{"energy_kcal": 89, "protein": 1})
	if _, err := writePackAtomically(out, pack); err == nil {
		t.Fatal("writePackAtomically succeeded when the destination was an existing directory")
	}

	got, err := os.ReadFile(marker)
	if err != nil {
		t.Fatalf("marker file did not survive the failed build: %v", err)
	}
	if string(got) != "sentinel" {
		t.Errorf("marker file content changed: got %q", got)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	if len(entries) != 1 || entries[0].Name() != "pack.bin.zst" {
		names := make([]string, len(entries))
		for i, e := range entries {
			names[i] = e.Name()
		}
		t.Errorf("expected only the destination directory to remain, got %v (a temp file was left behind)", names)
	}
}

// TestWritePackAtomicallySucceeds is the happy path: a fresh pack is
// written and renamed into place with no pre-existing file at out.
func TestWritePackAtomicallySucceeds(t *testing.T) {
	dir := t.TempDir()
	out := filepath.Join(dir, "pack.bin.zst")

	pack := packOf(food.Profile{"energy_kcal": 89, "protein": 1})
	size, err := writePackAtomically(out, pack)
	if err != nil {
		t.Fatalf("writePackAtomically: %v", err)
	}
	if size <= 0 {
		t.Errorf("reported size %d, want > 0", size)
	}

	st, err := os.Stat(out)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if st.Size() != size {
		t.Errorf("reported size %d does not match file size %d", size, st.Size())
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	if len(entries) != 1 || entries[0].Name() != "pack.bin.zst" {
		names := make([]string, len(entries))
		for i, e := range entries {
			names[i] = e.Name()
		}
		t.Errorf("expected only the destination file to remain, got %v (a temp file was left behind)", names)
	}
}

// A work directory laid out the way fetch leaves it must build without any
// per-source flags — that is the whole point of the manifest.
func TestBuildFromWorkDirectory(t *testing.T) {
	work := t.TempDir()
	usda := filepath.Join(work, "usda_sr")
	if err := os.MkdirAll(usda, 0o755); err != nil {
		t.Fatal(err)
	}
	copyTestdataUSDA(t, usda)
	if err := source.WriteFetchRecord(usda, source.ManifestEntry{
		Source: "usda_sr", URL: "https://example.test/sr.zip", SHA256: source.Unpinned,
	}); err != nil {
		t.Fatal(err)
	}

	out := filepath.Join(t.TempDir(), "pack.bin.zst")
	if err := buildCmd([]string{"--work", work, "--version", "test", "--out", out}); err != nil {
		t.Fatalf("buildCmd: %v", err)
	}
	f, err := os.Open(out)
	if err != nil {
		t.Fatalf("open pack: %v", err)
	}
	defer f.Close()
	p, err := format.Read(f)
	if err != nil {
		t.Fatalf("format.Read: %v", err)
	}
	if len(p.Foods) == 0 {
		t.Error("built pack has no foods")
	}
}

// A work directory with nothing in it must say what to do, not produce an
// empty pack.
func TestBuildFromEmptyWorkDirectory(t *testing.T) {
	out := filepath.Join(t.TempDir(), "pack.bin.zst")
	err := buildCmd([]string{"--work", t.TempDir(), "--version", "test", "--out", out})
	if err == nil || !strings.Contains(err.Error(), "foodpack fetch") {
		t.Fatalf("err = %v, want a message pointing at foodpack fetch", err)
	}
}

// copyTestdataUSDA copies the Plan 1 USDA fixture CSVs into dir.
func copyTestdataUSDA(t *testing.T, dir string) {
	t.Helper()
	src := filepath.Join("..", "..", "internal", "foodpack", "source", "testdata", "usda")
	names, err := os.ReadDir(src)
	if err != nil {
		t.Fatalf("read fixture dir: %v", err)
	}
	for _, n := range names {
		b, err := os.ReadFile(filepath.Join(src, n.Name()))
		if err != nil {
			t.Fatalf("read %s: %v", n.Name(), err)
		}
		if err := os.WriteFile(filepath.Join(dir, n.Name()), b, 0o644); err != nil {
			t.Fatalf("write %s: %v", n.Name(), err)
		}
	}
}

// Both USDA subtypes route through loadUSDADir with the same DataTypes
// filter, so the same fdc_id extracted into both usda_foundation/ and
// usda_sr/ really would collide -- this is the check that catches an
// archive extracted twice under one work directory.
func TestBuildRejectsDuplicateAcrossWorkDirectories(t *testing.T) {
	work := t.TempDir()
	foundation := filepath.Join(work, "usda_foundation")
	sr := filepath.Join(work, "usda_sr")
	for _, dir := range []string{foundation, sr} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		copyTestdataUSDA(t, dir)
	}

	out := filepath.Join(t.TempDir(), "pack.bin.zst")
	err := buildCmd([]string{"--work", work, "--version", "test", "--out", out})
	if err == nil {
		t.Fatal("want an error for a work directory with the same food extracted twice")
	}
	// The fixture's banana row (fdc_id 1105314) is sr_legacy_food, so both
	// copies load it as source usda_sr; the error must name that
	// (source, id) pair and both directories it was found in.
	if !strings.Contains(err.Error(), "usda_sr/1105314") {
		t.Errorf("err = %v, want it to name usda_sr/1105314", err)
	}
	if !strings.Contains(err.Error(), foundation) || !strings.Contains(err.Error(), sr) {
		t.Errorf("err = %v, want it to name both %s and %s", err, foundation, sr)
	}
}

// The two USDA archives are loaded through separate calls to loadUSDADir,
// one per directory. When both directories contribute rows for the same
// canonical source -- here usda_sr, because every row in both fixtures is
// tagged sr_legacy_food -- the built pack's SourceInfo for that source
// must carry the sum of both directories' row counts, not just the last
// directory's.
func TestBuildMergesSourceInfoAcrossDirectories(t *testing.T) {
	work := t.TempDir()
	foundation := filepath.Join(work, "usda_foundation")
	sr := filepath.Join(work, "usda_sr")

	if err := os.MkdirAll(foundation, 0o755); err != nil {
		t.Fatal(err)
	}
	copyTestdataUSDA(t, foundation) // banana (1105314) + spinach (1103648), 2 usda_sr rows

	if err := os.MkdirAll(sr, 0o755); err != nil {
		t.Fatal(err)
	}
	copyTestdataUSDA(t, sr)
	writeSecondUSDAFood(t, sr) // replaces food.csv/food_nutrient.csv with a disjoint fdc_id

	out := filepath.Join(t.TempDir(), "pack.bin.zst")
	if err := buildCmd([]string{"--work", work, "--version", "test", "--out", out}); err != nil {
		t.Fatalf("buildCmd: %v", err)
	}

	f, err := os.Open(out)
	if err != nil {
		t.Fatalf("open pack: %v", err)
	}
	defer f.Close()
	p, err := format.Read(f)
	if err != nil {
		t.Fatalf("format.Read: %v", err)
	}

	wantIDs := map[string]bool{"1105314": false, "1103648": false, "2000001": false}
	for _, rf := range p.Foods {
		if _, ok := wantIDs[rf.SourceID]; ok {
			wantIDs[rf.SourceID] = true
		}
	}
	for id, seen := range wantIDs {
		if !seen {
			t.Errorf("pack is missing food %s from one of the two directories", id)
		}
	}

	for _, s := range p.Sources {
		if s.Source == "usda_sr" {
			if s.Rows != 3 {
				t.Errorf("usda_sr SourceInfo.Rows = %d, want 3 (2 from usda_foundation/ + 1 from usda_sr/)", s.Rows)
			}
			return
		}
	}
	t.Fatal("no usda_sr SourceInfo in the built pack")
}

// writeSecondUSDAFood replaces dir's food.csv/food_nutrient.csv with a
// single food whose fdc_id does not collide with the shared fixture, so
// build --work has two directories to merge into one source. nutrient.csv
// and measure_unit.csv are left as copied from the fixture: LoadUSDA
// requires every mapped nutrient code to be defined in nutrient.csv,
// whether or not any food actually uses it. food_portion.csv is also left
// alone -- its rows reference fdc_ids absent from this directory's new
// food.csv and are simply skipped.
func writeSecondUSDAFood(t *testing.T, dir string) {
	t.Helper()
	food := `"fdc_id","data_type","description","food_category_id","publication_date"
"2000001","sr_legacy_food","Second Food, raw","0900","2019-04-01"
`
	if err := os.WriteFile(filepath.Join(dir, "food.csv"), []byte(food), 0o644); err != nil {
		t.Fatal(err)
	}
	nutrient := `"id","fdc_id","nutrient_id","amount"
"1","2000001","1008","55.0"
`
	if err := os.WriteFile(filepath.Join(dir, "food_nutrient.csv"), []byte(nutrient), 0o644); err != nil {
		t.Fatal(err)
	}
}

// checkFetchRecord's mismatch branch is unreachable through buildCmd
// today, because every row of the checked-in manifest is unpinned. Test
// it directly instead.
func TestCheckFetchRecordDetectsMismatch(t *testing.T) {
	dir := t.TempDir()
	if err := source.WriteFetchRecord(dir, source.ManifestEntry{
		Source: "cnf", URL: "https://example.test/cnf.zip", SHA256: strings.Repeat("a", 64),
	}); err != nil {
		t.Fatal(err)
	}
	_, err := checkFetchRecord(dir, source.ManifestEntry{
		Source: "cnf", SHA256: strings.Repeat("b", 64),
	})
	if err == nil {
		t.Fatal("want an error for a manifest re-pinned without a re-fetch")
	}
	if !strings.Contains(err.Error(), "foodpack fetch --source cnf") {
		t.Errorf("err = %v, want it to say to re-run foodpack fetch --source cnf", err)
	}
}

// A directory fetch never populated must warn, not error: build must
// still be able to use a directory someone populated by hand.
func TestCheckFetchRecordAbsentWarnsAndReturnsNil(t *testing.T) {
	sha, err := checkFetchRecord(t.TempDir(), source.ManifestEntry{
		Source: "cnf", SHA256: strings.Repeat("a", 64),
	})
	if err != nil {
		t.Fatalf("checkFetchRecord: %v, want nil for a directory fetch never populated", err)
	}
	if sha != "" {
		t.Errorf("sha = %q, want empty for a directory with no fetch record", sha)
	}
}

// A record whose hash matches what the manifest pins must return that
// hash and no error.
func TestCheckFetchRecordMatchReturnsNil(t *testing.T) {
	dir := t.TempDir()
	sha := strings.Repeat("a", 64)
	if err := source.WriteFetchRecord(dir, source.ManifestEntry{
		Source: "cnf", URL: "https://example.test/cnf.zip", SHA256: sha,
	}); err != nil {
		t.Fatal(err)
	}
	got, err := checkFetchRecord(dir, source.ManifestEntry{Source: "cnf", SHA256: sha})
	if err != nil {
		t.Fatalf("checkFetchRecord: %v, want nil when the recorded hash matches the pinned one", err)
	}
	if got != sha {
		t.Errorf("got sha %q, want %q", got, sha)
	}
}

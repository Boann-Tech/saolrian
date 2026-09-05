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

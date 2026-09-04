package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/boanntech/saolrian/backend/internal/food"
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

package source

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeFile(t *testing.T, dir, name string, body []byte) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, body, 0o644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	return p
}

// A UTF-8 BOM on the first header cell renames that column to "\ufeffid",
// which turns a required-column check into a mystery. CNF and CoFID CSV
// exports both ship one.
func TestEachCSVRowStripsBOM(t *testing.T) {
	dir := t.TempDir()
	p := writeFile(t, dir, "bom.csv", []byte("\ufeffid,name\n1,Banana\n"))

	var got []string
	err := eachCSVRow(p, []string{"id", "name"}, func(get func(string) string) error {
		got = append(got, get("id")+"="+get("name"))
		return nil
	})
	if err != nil {
		t.Fatalf("eachCSVRow: %v", err)
	}
	if len(got) != 1 || got[0] != "1=Banana" {
		t.Errorf("rows = %v, want [1=Banana]", got)
	}
}

// CNF's CSV export is Windows-1252, not UTF-8. Read as UTF-8 the accented
// French names become invalid bytes that survive all the way into
// search_text.
func TestEachCSVRowDecodesWindows1252(t *testing.T) {
	dir := t.TempDir()
	// 0xE9 is é in Windows-1252 and an invalid lone byte in UTF-8.
	p := writeFile(t, dir, "latin.csv", []byte("id,name\n1,Cr\xe8me fra\xeeche\n"))

	var name string
	err := eachCSVRow(p, []string{"id", "name"}, func(get func(string) string) error {
		name = get("name")
		return nil
	})
	if err != nil {
		t.Fatalf("eachCSVRow: %v", err)
	}
	if name != "Crème fraîche" {
		t.Errorf("name = %q, want %q", name, "Crème fraîche")
	}
}

// A renamed column must fail the build, not quietly produce empty values
// for every row.
func TestEachCSVRowRejectsMissingColumn(t *testing.T) {
	dir := t.TempDir()
	p := writeFile(t, dir, "short.csv", []byte("id\n1\n"))

	err := eachCSVRow(p, []string{"id", "name"}, func(func(string) string) error { return nil })
	if err == nil {
		t.Fatal("want an error naming the missing column")
	}
	if !strings.Contains(err.Error(), `"name"`) {
		t.Errorf("error %q does not name the missing column", err)
	}
}

// Column names in these exports carry stray spaces often enough that
// matching on the raw header text is a trap.
func TestEachCSVRowTrimsHeaderNames(t *testing.T) {
	dir := t.TempDir()
	p := writeFile(t, dir, "spacey.csv", []byte(" id , name \n1,Banana\n"))

	err := eachCSVRow(p, []string{"id", "name"}, func(get func(string) string) error {
		if get("name") != "Banana" {
			t.Errorf("name = %q", get("name"))
		}
		return nil
	})
	if err != nil {
		t.Fatalf("eachCSVRow: %v", err)
	}
}

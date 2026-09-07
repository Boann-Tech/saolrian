package source

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const goodManifest = `source,url,sha256,archive_kind,extract_to
usda_sr,https://example.test/sr.zip,unpinned,zip,usda_sr
cnf,https://example.test/cnf.zip,0000000000000000000000000000000000000000000000000000000000000000,zip,cnf
cofid,https://example.test/cofid.xlsx,unpinned,xlsx,cofid
ciqual,https://example.test/ciqual.7z,unpinned,7z,ciqual
`

func TestParseManifest(t *testing.T) {
	entries, err := ParseManifest(strings.NewReader(goodManifest))
	if err != nil {
		t.Fatalf("ParseManifest: %v", err)
	}
	if len(entries) != 4 {
		t.Fatalf("got %d entries, want 4", len(entries))
	}
	if entries[0].Source != "usda_sr" || entries[0].SHA256 != Unpinned || entries[0].ArchiveKind != "zip" {
		t.Errorf("first entry = %+v", entries[0])
	}
	// 7z is CIQUAL's only published XML archive; a manifest that cannot
	// name it cannot pin the French dataset at all.
	if entries[3].Source != "ciqual" || entries[3].ArchiveKind != "7z" {
		t.Errorf("entries[3] = %+v; 7z must be an accepted archive kind", entries[3])
	}
	if entries[2].ExtractTo != "cofid" || entries[2].ArchiveKind != "xlsx" {
		t.Errorf("third entry = %+v", entries[2])
	}
}

func TestParseManifestRejectsBadRows(t *testing.T) {
	cases := map[string]string{
		"unknown archive kind": "source,url,sha256,archive_kind,extract_to\na,https://e.test/a,unpinned,rar,a\n",
		"short sha":            "source,url,sha256,archive_kind,extract_to\na,https://e.test/a,abc123,zip,a\n",
		"non-hex sha":          "source,url,sha256,archive_kind,extract_to\na,https://e.test/a,zzzz000000000000000000000000000000000000000000000000000000000000,zip,a\n",
		"duplicate source":     "source,url,sha256,archive_kind,extract_to\na,https://e.test/a,unpinned,zip,a\na,https://e.test/b,unpinned,zip,b\n",
		"empty url":            "source,url,sha256,archive_kind,extract_to\na,,unpinned,zip,a\n",
		// extract_to is joined onto a caller-supplied work directory, so a
		// path separator or a .. in it writes outside that directory.
		"extract_to escapes": "source,url,sha256,archive_kind,extract_to\na,https://e.test/a,unpinned,zip,../a\n",
		"extract_to nests":   "source,url,sha256,archive_kind,extract_to\na,https://e.test/a,unpinned,zip,a/b\n",
		"non-https url":      "source,url,sha256,archive_kind,extract_to\na,http://e.test/a,unpinned,zip,a\n",
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseManifest(strings.NewReader(body)); err == nil {
				t.Fatal("want an error")
			}
		})
	}
}

// The checked-in manifest is what a human edits when a dataset moves. It
// must always parse, and must cover every source the pack ships.
func TestCheckedInManifestParses(t *testing.T) {
	entries, err := LoadManifest()
	if err != nil {
		t.Fatalf("LoadManifest: %v", err)
	}
	want := map[string]bool{
		"usda_foundation": false, "usda_sr": false,
		"cnf": false, "ciqual": false, "cofid": false, "afcd": false,
	}
	for _, e := range entries {
		if _, ok := want[e.Source]; !ok {
			t.Errorf("manifest has unexpected source %q", e.Source)
			continue
		}
		want[e.Source] = true
	}
	for s, seen := range want {
		if !seen {
			t.Errorf("manifest is missing source %q", s)
		}
	}
}

func TestFetchRecordRoundTrips(t *testing.T) {
	dir := t.TempDir()
	e := ManifestEntry{
		Source: "cnf", URL: "https://example.test/cnf.zip",
		SHA256: "abc", ArchiveKind: "zip", ExtractTo: "cnf",
	}
	if err := WriteFetchRecord(dir, e); err != nil {
		t.Fatalf("WriteFetchRecord: %v", err)
	}
	got, ok, err := ReadFetchRecord(dir)
	if err != nil || !ok {
		t.Fatalf("ReadFetchRecord: %v, ok=%v", err, ok)
	}
	if got.Source != e.Source || got.URL != e.URL || got.SHA256 != e.SHA256 {
		t.Errorf("record = %+v, want %+v", got, e)
	}
}

func TestReadFetchRecordAbsent(t *testing.T) {
	_, ok, err := ReadFetchRecord(t.TempDir())
	if err != nil {
		t.Fatalf("ReadFetchRecord: %v", err)
	}
	if ok {
		t.Error("want ok=false for a directory with no record")
	}
}

func TestReadFetchRecordRejectsGarbage(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, fetchRecordName), []byte("nonsense"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := ReadFetchRecord(dir); err == nil {
		t.Fatal("want an error for a malformed record")
	}
}

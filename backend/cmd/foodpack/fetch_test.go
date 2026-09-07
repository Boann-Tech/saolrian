package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/boanntech/saolrian/backend/internal/foodpack/source"
)

// zipBytes builds an in-memory zip. Nested paths are deliberate: every
// real dataset zip puts its files under a release-named directory.
func zipBytes(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, body := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("zip create %s: %v", name, err)
		}
		if _, err := w.Write([]byte(body)); err != nil {
			t.Fatalf("zip write %s: %v", name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("zip close: %v", err)
	}
	return buf.Bytes()
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func TestFetchOneDownloadsAndExtractsZip(t *testing.T) {
	body := zipBytes(t, map[string]string{
		"CNF_2015/FOOD NAME.csv":     "FoodID,FoodDescription\n1,Banana\n",
		"CNF_2015/NUTRIENT NAME.csv": "NutrientID,NutrientName\n208,ENERGY\n",
	})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(body)
	}))
	defer srv.Close()

	work := t.TempDir()
	e := source.ManifestEntry{
		Source: "cnf", URL: srv.URL + "/cnf.zip", SHA256: sha256Hex(body),
		ArchiveKind: "zip", ExtractTo: "cnf",
	}
	var out bytes.Buffer
	if err := fetchOne(context.Background(), srv.Client(), e, work, false, &out); err != nil {
		t.Fatalf("fetchOne: %v", err)
	}

	// Archive directory structure is flattened: adapters take a flat
	// directory of files, and the release-named wrapper directory changes
	// with every release.
	for _, name := range []string{"FOOD NAME.csv", "NUTRIENT NAME.csv"} {
		if _, err := os.Stat(filepath.Join(work, "cnf", name)); err != nil {
			t.Errorf("extracted file %s: %v", name, err)
		}
	}
	rec, ok, err := source.ReadFetchRecord(filepath.Join(work, "cnf"))
	if err != nil || !ok {
		t.Fatalf("ReadFetchRecord: %v, ok=%v", err, ok)
	}
	if rec.SHA256 != e.SHA256 {
		t.Errorf("record sha = %s, want %s", rec.SHA256, e.SHA256)
	}
}

// A pinned hash that does not match is the whole point of pinning: an
// upstream file changed under us and the numbers may have moved.
func TestFetchOneRejectsHashMismatch(t *testing.T) {
	body := zipBytes(t, map[string]string{"a/x.csv": "id\n1\n"})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(body)
	}))
	defer srv.Close()

	work := t.TempDir()
	e := source.ManifestEntry{
		Source: "cnf", URL: srv.URL + "/cnf.zip",
		SHA256:      "1111111111111111111111111111111111111111111111111111111111111111",
		ArchiveKind: "zip", ExtractTo: "cnf",
	}
	err := fetchOne(context.Background(), srv.Client(), e, work, false, &bytes.Buffer{})
	if err == nil {
		t.Fatal("want an error")
	}
	if !strings.Contains(err.Error(), sha256Hex(body)) {
		t.Errorf("error %q does not report the hash actually received", err)
	}
	if _, statErr := os.Stat(filepath.Join(work, "cnf", "x.csv")); statErr == nil {
		t.Error("a mismatched archive must not be extracted")
	}
}

// An unpinned row still downloads, but must print the hash to paste in.
func TestFetchOneReportsHashForUnpinned(t *testing.T) {
	body := zipBytes(t, map[string]string{"a/x.csv": "id\n1\n"})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(body)
	}))
	defer srv.Close()

	var out bytes.Buffer
	e := source.ManifestEntry{
		Source: "cnf", URL: srv.URL + "/cnf.zip", SHA256: source.Unpinned,
		ArchiveKind: "zip", ExtractTo: "cnf",
	}
	if err := fetchOne(context.Background(), srv.Client(), e, t.TempDir(), false, &out); err != nil {
		t.Fatalf("fetchOne: %v", err)
	}
	if !strings.Contains(out.String(), sha256Hex(body)) {
		t.Errorf("output does not offer the hash to pin:\n%s", out.String())
	}
}

// A 404 is the expected failure for these datasets, whose download URLs
// move. It must say where to put the file by hand.
func TestFetchOneOn404NamesTheManualPath(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	defer srv.Close()

	work := t.TempDir()
	e := source.ManifestEntry{
		Source: "cofid", URL: srv.URL + "/cofid.xlsx", SHA256: source.Unpinned,
		ArchiveKind: "xlsx", ExtractTo: "cofid",
	}
	err := fetchOne(context.Background(), srv.Client(), e, work, false, &bytes.Buffer{})
	if err == nil {
		t.Fatal("want an error")
	}
	if !strings.Contains(err.Error(), filepath.Join(work, "cofid")) {
		t.Errorf("error %q does not name the manual drop directory", err)
	}
}

// Zip slip: an entry named ../../etc/x must not escape the target
// directory. These archives come from the network.
func TestExtractZipRejectsPathEscape(t *testing.T) {
	body := zipBytes(t, map[string]string{"../escaped.csv": "id\n1\n"})
	dir := t.TempDir()
	archive := filepath.Join(dir, "a.zip")
	if err := os.WriteFile(archive, body, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := extractZip(archive, filepath.Join(dir, "out")); err == nil {
		t.Fatal("want an error for an entry that escapes the target directory")
	}
}

// Flattening two entries onto one name would silently keep whichever came
// last, which for a dataset is a different pack every run.
func TestExtractZipRejectsFlattenCollision(t *testing.T) {
	body := zipBytes(t, map[string]string{
		"a/food.csv": "id\n1\n",
		"b/food.csv": "id\n2\n",
	})
	dir := t.TempDir()
	archive := filepath.Join(dir, "a.zip")
	if err := os.WriteFile(archive, body, 0o644); err != nil {
		t.Fatal(err)
	}
	err := extractZip(archive, filepath.Join(dir, "out"))
	if err == nil || !strings.Contains(err.Error(), "food.csv") {
		t.Fatalf("err = %v, want a collision naming food.csv", err)
	}
}

func TestFetchOneCopiesBareFile(t *testing.T) {
	body := []byte("not really a spreadsheet")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(body)
	}))
	defer srv.Close()

	work := t.TempDir()
	e := source.ManifestEntry{
		Source: "afcd", URL: srv.URL + "/release2.xlsx", SHA256: sha256Hex(body),
		ArchiveKind: "xlsx", ExtractTo: "afcd",
	}
	if err := fetchOne(context.Background(), srv.Client(), e, work, false, &bytes.Buffer{}); err != nil {
		t.Fatalf("fetchOne: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(work, "afcd", "release2.xlsx"))
	if err != nil {
		t.Fatalf("read extracted file: %v", err)
	}
	if !bytes.Equal(got, body) {
		t.Error("copied file does not match what was served")
	}
}

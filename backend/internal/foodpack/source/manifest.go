package source

import (
	"encoding/csv"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Unpinned marks a manifest row whose archive hash is not yet recorded.
// fetch will download it and print the hash to paste in; once a real hash
// is there, a mismatch is fatal.
const Unpinned = "unpinned"

// fetchRecordName is the breadcrumb fetch leaves in an extracted source
// directory so build can tell which archive produced it.
const fetchRecordName = ".foodpack-fetch"

// ManifestEntry is one downloadable archive.
type ManifestEntry struct {
	Source      string // matches the pack's source value, e.g. "cnf"
	URL         string
	SHA256      string // 64 lowercase hex chars, or Unpinned
	ArchiveKind string // zip | xlsx | xml | csv
	ExtractTo   string // single directory name under the work dir
}

var archiveKinds = map[string]bool{"zip": true, "xlsx": true, "xml": true, "csv": true}

// LoadManifest reads the checked-in manifest.
func LoadManifest() ([]ManifestEntry, error) {
	f, err := MappingFS.Open("manifest/sources.csv")
	if err != nil {
		return nil, fmt.Errorf("open manifest: %w", err)
	}
	defer f.Close()
	return ParseManifest(f)
}

// ParseManifest reads a manifest CSV with header
// source,url,sha256,archive_kind,extract_to.
func ParseManifest(r io.Reader) ([]ManifestEntry, error) {
	cr := csv.NewReader(r)
	cr.FieldsPerRecord = -1
	rows, err := cr.ReadAll()
	if err != nil {
		return nil, fmt.Errorf("read manifest csv: %w", err)
	}
	if len(rows) < 2 {
		return nil, fmt.Errorf("manifest csv has no rows")
	}

	var out []ManifestEntry
	seen := map[string]bool{}
	for i, row := range rows[1:] { // skip header
		line := i + 2
		if len(row) < 5 {
			return nil, fmt.Errorf("line %d: want 5 columns, got %d", line, len(row))
		}
		e := ManifestEntry{
			Source:      strings.TrimSpace(row[0]),
			URL:         strings.TrimSpace(row[1]),
			SHA256:      strings.ToLower(strings.TrimSpace(row[2])),
			ArchiveKind: strings.ToLower(strings.TrimSpace(row[3])),
			ExtractTo:   strings.TrimSpace(row[4]),
		}
		if e.Source == "" {
			return nil, fmt.Errorf("line %d: empty source", line)
		}
		if seen[e.Source] {
			return nil, fmt.Errorf("line %d: duplicate source %q", line, e.Source)
		}
		seen[e.Source] = true
		// Plain http would let anyone on the path swap a dataset for one
		// with different numbers; an unpinned row has no hash to catch it.
		if !strings.HasPrefix(e.URL, "https://") {
			return nil, fmt.Errorf("line %d: url must be https, got %q", line, e.URL)
		}
		if !archiveKinds[e.ArchiveKind] {
			return nil, fmt.Errorf("line %d: unknown archive_kind %q", line, e.ArchiveKind)
		}
		if e.SHA256 != Unpinned {
			if len(e.SHA256) != 64 || strings.Trim(e.SHA256, "0123456789abcdef") != "" {
				return nil, fmt.Errorf("line %d: sha256 must be 64 hex chars or %q", line, Unpinned)
			}
		}
		// extract_to is joined onto a work directory the caller supplies,
		// so it must be one ordinary directory name and nothing else.
		if e.ExtractTo == "" || e.ExtractTo != filepath.Base(e.ExtractTo) ||
			e.ExtractTo == "." || e.ExtractTo == ".." || strings.ContainsRune(e.ExtractTo, filepath.Separator) {
			return nil, fmt.Errorf("line %d: extract_to %q must be a single directory name", line, e.ExtractTo)
		}
		out = append(out, e)
	}
	return out, nil
}

// WriteFetchRecord records which archive was extracted into dir.
func WriteFetchRecord(dir string, e ManifestEntry) error {
	body := fmt.Sprintf("source=%s\nurl=%s\nsha256=%s\n", e.Source, e.URL, e.SHA256)
	return os.WriteFile(filepath.Join(dir, fetchRecordName), []byte(body), 0o644)
}

// ReadFetchRecord reads the breadcrumb fetch left in dir. ok is false when
// the directory was populated some other way — by hand, say.
func ReadFetchRecord(dir string) (ManifestEntry, bool, error) {
	b, err := os.ReadFile(filepath.Join(dir, fetchRecordName))
	if os.IsNotExist(err) {
		return ManifestEntry{}, false, nil
	}
	if err != nil {
		return ManifestEntry{}, false, err
	}
	var e ManifestEntry
	for _, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			return ManifestEntry{}, false, fmt.Errorf("%s: malformed line %q", fetchRecordName, line)
		}
		switch k {
		case "source":
			e.Source = v
		case "url":
			e.URL = v
		case "sha256":
			e.SHA256 = v
		default:
			return ManifestEntry{}, false, fmt.Errorf("%s: unknown key %q", fetchRecordName, k)
		}
	}
	if e.Source == "" || e.URL == "" {
		return ManifestEntry{}, false, fmt.Errorf("%s: incomplete record", fetchRecordName)
	}
	return e, true, nil
}

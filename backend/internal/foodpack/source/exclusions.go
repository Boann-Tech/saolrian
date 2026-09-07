package source

import (
	"encoding/csv"
	"fmt"
	"io"
	"strings"
)

// Exclusions is the checked-in table of individual foods a source
// publishes with a value confirmed to be the source's own error rather
// than a defect in our mapping (see internal/food.Nutrient.Max's doc
// comment on what the range guard is and is not for). Builder drops a
// listed food instead of failing the whole build over it or raising a
// plausible maximum to admit it.
//
// A row here is not a back door around the range guard: every row must
// carry a human-readable reason, and the evidence bar is the same one
// that applies to raising a Max -- confirmed against the source's own
// published documentation, not merely "the check complained".
type Exclusions struct {
	reasons map[string]string // "source\x00source_id" -> reason
}

// Reason reports whether (source, sourceID) is on the exclusion table, and
// why. A nil *Exclusions (no table installed) excludes nothing.
func (e *Exclusions) Reason(source, sourceID string) (string, bool) {
	if e == nil {
		return "", false
	}
	r, ok := e.reasons[source+"\x00"+sourceID]
	return r, ok
}

// LoadExclusions loads the checked-in exclusion table.
func LoadExclusions() (*Exclusions, error) {
	f, err := MappingFS.Open("exclusions.csv")
	if err != nil {
		return nil, fmt.Errorf("open exclusions: %w", err)
	}
	defer f.Close()
	return ParseExclusions(f)
}

// ParseExclusions reads an exclusions CSV with header
// source,source_id,reason. Every row must carry a non-empty reason, and no
// (source, source_id) pair may repeat.
func ParseExclusions(r io.Reader) (*Exclusions, error) {
	cr := csv.NewReader(r)
	cr.FieldsPerRecord = -1
	rows, err := cr.ReadAll()
	if err != nil {
		return nil, fmt.Errorf("read exclusions csv: %w", err)
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("exclusions csv is empty")
	}

	e := &Exclusions{reasons: map[string]string{}}
	for i, row := range rows[1:] { // skip header
		line := i + 2
		if len(row) < 3 {
			return nil, fmt.Errorf("line %d: want at least 3 columns, got %d", line, len(row))
		}
		src := strings.TrimSpace(row[0])
		id := strings.TrimSpace(row[1])
		reason := strings.TrimSpace(row[2])
		if src == "" || id == "" {
			return nil, fmt.Errorf("line %d: source and source_id are required", line)
		}
		if reason == "" {
			return nil, fmt.Errorf("line %d: reason is required", line)
		}
		key := src + "\x00" + id
		if _, dup := e.reasons[key]; dup {
			return nil, fmt.Errorf("line %d: duplicate exclusion for %s/%s", line, src, id)
		}
		e.reasons[key] = reason
	}
	return e, nil
}

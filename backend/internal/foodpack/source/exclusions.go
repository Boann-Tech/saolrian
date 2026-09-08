package source

import (
	"encoding/csv"
	"fmt"
	"io"
	"strings"
)

// Exclusions is the checked-in table of individual foods Builder drops
// instead of failing the whole build over them or raising a plausible
// maximum to admit them (see internal/food.Nutrient.Max's doc comment on
// what the range guard is and is not for).
//
// There are exactly two reasons a food may be listed, and a row must say
// which it is:
//
//  1. The source publishes a value confirmed to be its own error rather
//     than a defect in our mapping. Almost every row is this.
//  2. The canonical vocabulary cannot represent the food, so a check reads
//     a correct food as broken. Such a row must name what is missing and
//     say plainly that the source is not at fault, so that it reads as the
//     limitation it is rather than as a check being quietly silenced. At
//     the time of writing there is one: cnf/5522, a sugar-alcohol syrup
//     the pack has no polyol key for.
//
// A row here is not a back door around the range guard: every row must
// carry a human-readable reason, and the evidence bar for category 1 is
// the same one that applies to raising a Max -- confirmed against the
// source's own published documentation, not merely "the check complained".
// Category 2 carries its own bar, which is harder to meet, not easier: the
// gap has to be in the vocabulary, demonstrably, and the row has to say
// what would close it.
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

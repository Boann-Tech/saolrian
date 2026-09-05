package main

import (
	"embed"
	"encoding/csv"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"

	"github.com/boanntech/saolrian/backend/internal/food"
	"github.com/boanntech/saolrian/backend/internal/foodpack/format"
)

// goldenFS holds the checked-in golden nutrient table, embedded the same
// way the per-source mapping tables under internal/foodpack/source/mapping
// are: a human edits this CSV, not a Go literal, when a number looks wrong.
//
//go:embed all:golden
var goldenFS embed.FS

// goldenEntry is one row of the golden table: a known-good value for one
// nutrient of one real food, keyed by a name regular expression rather
// than a raw source_id. FDC (and every other source's) ids shift between
// dataset releases; a name pattern does not.
type goldenEntry struct {
	Source       string
	NameRegex    *regexp.Regexp
	NutrientKey  string
	Expected     float64
	TolerancePct float64
	Note         string
}

// loadGoldenTable parses the checked-in golden CSV with header
// source,name_regex,nutrient_key,expected,tolerance_pct,note.
func loadGoldenTable() ([]goldenEntry, error) {
	f, err := goldenFS.Open("golden/nutrients.csv")
	if err != nil {
		return nil, fmt.Errorf("open golden table: %w", err)
	}
	defer f.Close()
	return parseGoldenTable(f)
}

func parseGoldenTable(r io.Reader) ([]goldenEntry, error) {
	cr := csv.NewReader(r)
	cr.FieldsPerRecord = -1
	rows, err := cr.ReadAll()
	if err != nil {
		return nil, fmt.Errorf("read golden csv: %w", err)
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("golden csv is empty")
	}

	var out []goldenEntry
	for i, row := range rows[1:] { // skip header
		line := i + 2
		if len(row) < 5 {
			return nil, fmt.Errorf("line %d: want at least 5 columns, got %d", line, len(row))
		}
		source := strings.TrimSpace(row[0])
		if source == "" {
			return nil, fmt.Errorf("line %d: empty source", line)
		}
		pattern := strings.TrimSpace(row[1])
		re, err := regexp.Compile(pattern)
		if err != nil {
			return nil, fmt.Errorf("line %d: bad name_regex %q: %w", line, pattern, err)
		}
		key := strings.TrimSpace(row[2])
		if _, ok := food.Lookup(key); !ok {
			return nil, fmt.Errorf("line %d: unknown canonical key %q", line, key)
		}
		expected, err := strconv.ParseFloat(strings.TrimSpace(row[3]), 64)
		if err != nil {
			return nil, fmt.Errorf("line %d: bad expected value: %w", line, err)
		}
		tol, err := strconv.ParseFloat(strings.TrimSpace(row[4]), 64)
		if err != nil {
			return nil, fmt.Errorf("line %d: bad tolerance_pct: %w", line, err)
		}
		if tol <= 0 {
			return nil, fmt.Errorf("line %d: tolerance_pct must be positive", line)
		}
		note := ""
		if len(row) > 5 {
			note = strings.TrimSpace(row[5])
		}
		out = append(out, goldenEntry{
			Source: source, NameRegex: re, NutrientKey: key,
			Expected: expected, TolerancePct: tol, Note: note,
		})
	}
	return out, nil
}

// checkGolden loads the checked-in golden table and evaluates it against
// the built pack.
func checkGolden(p format.Pack) CheckResult {
	entries, err := loadGoldenTable()
	if err != nil {
		return CheckResult{"golden", false, fmt.Sprintf("load golden table: %v", err)}
	}
	return evalGolden(p, entries)
}

// evalGolden is the pure comparison logic, split out from checkGolden so it
// can be exercised against hand-built entries in tests without touching the
// embedded file.
//
// An entry applies only when its Source appears in p.Sources — that is how
// the table grows across sources this branch does not yet implement (cnf,
// ciqual, cofid, afcd): their entries are silently skipped rather than
// failing a pack that could never contain them. But an applicable entry
// (its source IS present) that matches no food is a FAIL, not a skip: a
// golden entry whose regex has drifted from the real data must be loud,
// not silent, and the check must never be able to pass by matching
// nothing. When a regex matches more than one food, the food with the
// lexicographically lowest SourceID is picked, so the result is
// deterministic across runs of the same pack.
func evalGolden(p format.Pack, entries []goldenEntry) CheckResult {
	present := map[string]bool{}
	for _, s := range p.Sources {
		present[s.Source] = true
	}

	attempted := 0
	var failures []string
	for _, e := range entries {
		if !present[e.Source] {
			continue // this pack has no rows from e.Source at all
		}
		attempted++

		var match *format.RefFood
		for i := range p.Foods {
			f := &p.Foods[i]
			if f.Source != e.Source || !e.NameRegex.MatchString(f.Name) {
				continue
			}
			if match == nil || f.SourceID < match.SourceID {
				match = f
			}
		}
		if match == nil {
			failures = append(failures, fmt.Sprintf(
				"%s/%s: source is present but no food name matched %q",
				e.Source, e.NutrientKey, e.NameRegex.String()))
			continue
		}

		got, ok := food.Decode(match.Nutrients)[e.NutrientKey]
		if !ok {
			failures = append(failures, fmt.Sprintf(
				"%s/%s (%s/%s %q): matched food carries no %s value",
				e.Source, e.NutrientKey, match.Source, match.SourceID, match.Name, e.NutrientKey))
			continue
		}

		tol := e.Expected * e.TolerancePct / 100
		if tol < 0 {
			tol = -tol
		}
		if diff := got - e.Expected; diff > tol || diff < -tol {
			failures = append(failures, fmt.Sprintf(
				"%s/%s (%s/%s %q): expected %g ±%g%%, got %g",
				e.Source, e.NutrientKey, match.Source, match.SourceID, match.Name,
				e.Expected, e.TolerancePct, got))
		}
	}

	if attempted == 0 {
		return CheckResult{"golden", false,
			"no golden entry's source is present in this pack; the check would be vacuous"}
	}
	if len(failures) > 0 {
		return CheckResult{"golden", false,
			fmt.Sprintf("%d/%d golden checks failed: %s", len(failures), attempted, strings.Join(failures, "; "))}
	}
	return CheckResult{"golden", true, fmt.Sprintf("%d golden checks passed", attempted)}
}

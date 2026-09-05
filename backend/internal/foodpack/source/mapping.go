// Package source holds the per-dataset adapters that turn raw downloads
// into canonical reference foods.
//
// Nothing here is imported by the server binary.
package source

import (
	"encoding/csv"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/boanntech/saolrian/backend/internal/food"
)

type mapped struct {
	key    string
	factor float64
}

// Mapping translates one dataset's nutrient codes into canonical keys.
type Mapping struct {
	byCode  map[string]mapped
	ignored map[string]bool
	order   []string
}

// LoadMapping parses a mapping CSV with header
// source_code,canonical_key,factor,note.
//
// A canonical_key of "-" marks the code as deliberately ignored, so an
// unmapped code and a dropped one are distinguishable.
func LoadMapping(r io.Reader) (*Mapping, error) {
	cr := csv.NewReader(r)
	cr.FieldsPerRecord = -1
	rows, err := cr.ReadAll()
	if err != nil {
		return nil, fmt.Errorf("read mapping csv: %w", err)
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("mapping csv is empty")
	}

	m := &Mapping{byCode: map[string]mapped{}, ignored: map[string]bool{}}

	// Which line first claimed each canonical key. Two source codes mapping
	// to one canonical key is not a merge: the second silently overwrites
	// the first on the data path, and which one wins depends on row order.
	// CNF and CIQUAL both publish computed-plus-measured variants of the
	// same nutrient, so this is a mistake waiting to be made.
	keyLine := map[string]int{}

	for i, row := range rows[1:] { // skip header
		line := i + 2
		if len(row) < 3 {
			return nil, fmt.Errorf("line %d: want at least 3 columns, got %d", line, len(row))
		}
		code := strings.TrimSpace(row[0])
		key := strings.TrimSpace(row[1])
		if code == "" {
			return nil, fmt.Errorf("line %d: empty source_code", line)
		}
		if _, dup := m.byCode[code]; dup || m.ignored[code] {
			return nil, fmt.Errorf("line %d: duplicate source_code %q", line, code)
		}

		if key == "-" {
			m.ignored[code] = true
			m.order = append(m.order, code)
			continue
		}
		if _, ok := food.Lookup(key); !ok {
			return nil, fmt.Errorf("line %d: unknown canonical key %q", line, key)
		}
		if prev, dup := keyLine[key]; dup {
			return nil, fmt.Errorf("line %d: canonical key %q is already mapped on line %d; pick one source_code and mark the other \"-\"",
				line, key, prev)
		}
		keyLine[key] = line
		factor, err := strconv.ParseFloat(strings.TrimSpace(row[2]), 64)
		if err != nil {
			return nil, fmt.Errorf("line %d: bad factor: %w", line, err)
		}
		if factor == 0 {
			return nil, fmt.Errorf("line %d: factor must not be zero", line)
		}
		m.byCode[code] = mapped{key: key, factor: factor}
		m.order = append(m.order, code)
	}
	return m, nil
}

// Apply converts a raw source value into a canonical key and value.
// ok is false for ignored and unmapped codes.
func (m *Mapping) Apply(code string, value float64) (string, float64, bool) {
	e, ok := m.byCode[code]
	if !ok {
		return "", 0, false
	}
	return e.key, value * e.factor, true
}

// Known reports whether the code appears in the mapping at all, mapped or
// explicitly ignored.
func (m *Mapping) Known(code string) bool {
	if _, ok := m.byCode[code]; ok {
		return true
	}
	return m.ignored[code]
}

// Codes returns every code in the mapping, in file order.
func (m *Mapping) Codes() []string { return m.order }

// UnitFor returns the canonical unit a mapped code produces.
func (m *Mapping) UnitFor(code string) (food.Unit, bool) {
	e, ok := m.byCode[code]
	if !ok {
		return "", false
	}
	n, ok := food.Lookup(e.key)
	if !ok {
		return "", false
	}
	return n.Unit, true
}

// FactorFor returns the conversion factor a mapped code applies. ok is
// false for ignored and unmapped codes.
func (m *Mapping) FactorFor(code string) (float64, bool) {
	e, ok := m.byCode[code]
	if !ok {
		return 0, false
	}
	return e.factor, true
}

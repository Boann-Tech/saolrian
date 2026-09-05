package food

import (
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
)

// Profile is a sparse per-100g nutrient profile keyed by canonical key.
//
// Sparseness is semantic, not an optimisation: a key that is absent means
// "this source has no figure for this nutrient". A key present with value
// 0 means "measured, and it is zero". Collapsing the two makes every
// downstream total under-report.
type Profile map[string]float64

// Encode flattens p into a positional slice in canonical order, writing
// NaN into the slots of absent nutrients.
func Encode(p Profile) []float32 {
	out := make([]float32, len(Nutrients))
	nan := float32(math.NaN())
	for i, n := range Nutrients {
		if v, ok := p[n.Key]; ok {
			out[i] = float32(v)
		} else {
			out[i] = nan
		}
	}
	return out
}

// Decode rebuilds a sparse Profile from a positional slice, dropping NaN
// slots. Slots beyond the current vocabulary are ignored so a pack built
// with a longer vocabulary degrades instead of panicking.
func Decode(vals []float32) Profile {
	p := make(Profile)
	for i, v := range vals {
		if i >= len(Nutrients) {
			break
		}
		if math.IsNaN(float64(v)) {
			continue
		}
		p[Nutrients[i].Key] = float64(v)
	}
	return p
}

// Scale returns p multiplied by factor (typically grams/100). Absent
// nutrients stay absent.
func Scale(p Profile, factor float64) Profile {
	out := make(Profile, len(p))
	for k, v := range p {
		out[k] = v * factor
	}
	return out
}

// Validate reports the first value that is not a plausible per-100g figure:
// an unknown key, a negative or non-finite value, or one above the
// nutrient's generous maximum (which almost always means a unit error).
//
// Keys are examined in sorted order rather than Go map order so that a
// profile with two problems names the same one on every run. A validation
// message that changes between runs is worse than useless to whoever is
// fixing the mapping table.
func Validate(p Profile) error {
	keys := make([]string, 0, len(p))
	for k := range p {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	for _, k := range keys {
		v := p[k]
		n, ok := Lookup(k)
		if !ok {
			return fmt.Errorf("unknown nutrient key %q", k)
		}
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return fmt.Errorf("%s: value is not finite (%v)", k, v)
		}
		if v < 0 {
			return fmt.Errorf("%s: negative value %v", k, v)
		}
		if v > n.Max {
			return fmt.Errorf("%s: %v %s exceeds plausible maximum %v (unit error?)",
				k, v, n.Unit, n.Max)
		}
	}
	return nil
}

// ErrOutOfRange marks a batch range-validation failure: at least one food
// in the batch carries a value outside its nutrient's plausible range.
var ErrOutOfRange = errors.New("nutrient values outside plausible range")

// MaxReportedRangeViolations bounds how many individual offenders a batch
// report lists. Failing on the first offender turns a real-data build into
// one defect per run; dumping eight thousand lines is no better.
const MaxReportedRangeViolations = 20

// FormatRangeViolations renders a collected list of range violations as one
// message: the total count followed by the first
// MaxReportedRangeViolations entries. Callers are expected to have built
// the list in a deterministic order (pack order, or source file order), so
// repeated runs report the same offenders.
func FormatRangeViolations(violations []string) string {
	if len(violations) == 0 {
		return ""
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%d food(s) carry values outside the plausible range", len(violations))
	shown := violations
	if len(shown) > MaxReportedRangeViolations {
		shown = shown[:MaxReportedRangeViolations]
	}
	for _, v := range shown {
		b.WriteString("\n  " + v)
	}
	if n := len(violations) - len(shown); n > 0 {
		fmt.Fprintf(&b, "\n  ... and %d more", n)
	}
	return b.String()
}

// RangeViolationsError wraps FormatRangeViolations in an ErrOutOfRange
// error, or returns nil when there are no violations.
func RangeViolationsError(violations []string) error {
	if len(violations) == 0 {
		return nil
	}
	return fmt.Errorf("%w: %s", ErrOutOfRange, FormatRangeViolations(violations))
}

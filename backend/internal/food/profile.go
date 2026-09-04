package food

import (
	"fmt"
	"math"
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
func Validate(p Profile) error {
	for k, v := range p {
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

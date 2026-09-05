package source

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// ErrUnknownToken means a cell held something that is neither a number nor
// one of the dataset's declared sentinels. Reading such a cell as zero is
// how "not analysed" silently becomes "contains none", so it is fatal.
var ErrUnknownToken = errors.New("unrecognised non-numeric value")

// ValueSyntax describes how one dataset writes numbers and missing data.
// Only USDA leaves a gap blank; the others encode it in band, and the
// spellings differ per source, so each adapter declares its own.
type ValueSyntax struct {
	// Absent lists tokens meaning "not measured". Matched case-insensitively.
	Absent []string
	// Trace lists tokens meaning "measured, below the limit of
	// quantification". These parse to a real 0.0: the lab looked, so the
	// honest value is zero, and dropping the key would understate coverage.
	Trace []string
	// DecimalComma marks a dataset that writes 12,3 for 12.3 and groups
	// thousands with spaces.
	DecimalComma bool
}

// spaceChars are every space a spreadsheet or CSV export has been seen to
// emit: ordinary, tab, non-breaking, narrow no-break (French thousands
// grouping) and figure space.
//
// Written as escape sequences rather than literal bytes on purpose. Typed
// literally they are indistinguishable from a plain space on screen, and
// anything that reformats or copies this file can flatten them without a
// trace -- which silently turns the whole constant into five ordinary
// spaces and disables the thousands-stripping it exists for.
const spaceChars = "\u0020\u0009\u00a0\u202f\u2007"

func trimSpaces(s string) string { return strings.Trim(s, spaceChars) }

// Parse turns one raw cell into a value. present is false when the cell
// means "no data"; callers must then omit the key entirely.
func (s ValueSyntax) Parse(raw string) (float64, bool, error) {
	t := trimSpaces(raw)
	if t == "" {
		return 0, false, nil
	}
	for _, a := range s.Absent {
		if strings.EqualFold(t, a) {
			return 0, false, nil
		}
	}
	for _, tr := range s.Trace {
		if strings.EqualFold(t, tr) {
			return 0, true, nil
		}
	}

	// [12] marks a figure estimated or borrowed from a similar food. The
	// source vouches for it, so it is taken at face value.
	if strings.HasPrefix(t, "[") && strings.HasSuffix(t, "]") {
		t = trimSpaces(t[1 : len(t)-1])
	}
	// "<0.1" is a real upper bound; the bound is the most informative
	// number available.
	for _, p := range []string{"<=", "≤", "<"} {
		if strings.HasPrefix(t, p) {
			t = trimSpaces(strings.TrimPrefix(t, p))
			break
		}
	}

	num := t
	if s.DecimalComma {
		for _, c := range spaceChars {
			num = strings.ReplaceAll(num, string(c), "")
		}
		if strings.Count(num, ",") > 1 {
			return 0, false, fmt.Errorf("%w: %q", ErrUnknownToken, raw)
		}
		num = strings.Replace(num, ",", ".", 1)
	}

	v, err := strconv.ParseFloat(num, 64)
	if err != nil {
		return 0, false, fmt.Errorf("%w: %q", ErrUnknownToken, raw)
	}
	return v, true, nil
}

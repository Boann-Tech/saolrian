package source

import (
	"errors"
	"math"
	"testing"
)

// cofidLike is the grammar CoFID and AFCD share: Tr for trace, N for not
// measured, square brackets around estimated figures.
var cofidLike = ValueSyntax{
	Absent: []string{"N", "-", "n/a"},
	Trace:  []string{"Tr"},
}

// ciqualLike adds French decimal commas and "traces".
var ciqualLike = ValueSyntax{
	Absent:       []string{"-", "ND"},
	Trace:        []string{"traces"},
	DecimalComma: true,
}

func TestValueSyntaxParse(t *testing.T) {
	tests := []struct {
		name    string
		syntax  ValueSyntax
		raw     string
		want    float64
		present bool
	}{
		{"plain number", cofidLike, "12.3", 12.3, true},
		{"zero is a real value", cofidLike, "0", 0, true},
		{"blank is absent", cofidLike, "", 0, false},
		{"blank with spaces is absent", cofidLike, "   ", 0, false},
		{"not measured is absent", cofidLike, "N", 0, false},
		{"absent token is case-insensitive", cofidLike, "n", 0, false},
		{"dash is absent", cofidLike, "-", 0, false},
		{"trace is a real zero", cofidLike, "Tr", 0, true},
		{"trace is case-insensitive", cofidLike, "TR", 0, true},
		{"bracketed estimate is taken at face value", cofidLike, "[12]", 12, true},
		{"bracketed estimate with spaces", cofidLike, " [ 12.5 ] ", 12.5, true},
		{"less-than becomes the bound", cofidLike, "<0.1", 0.1, true},
		{"less-than with a space", cofidLike, "< 0.1", 0.1, true},
		{"decimal comma", ciqualLike, "12,3", 12.3, true},
		{"grouped thousands, nbsp", ciqualLike, "1\u00a0234,5", 1234.5, true},
		{"grouped thousands, narrow nbsp", ciqualLike, "1\u202f234,5", 1234.5, true},
		{"nbsp padding is trimmed", cofidLike, "\u00a012.3\u00a0", 12.3, true},
		{"french traces", ciqualLike, "traces", 0, true},
		{"less-than with decimal comma", ciqualLike, "< 0,1", 0.1, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, present, err := tc.syntax.Parse(tc.raw)
			if err != nil {
				t.Fatalf("Parse(%q): unexpected error %v", tc.raw, err)
			}
			if present != tc.present {
				t.Fatalf("Parse(%q) present = %v, want %v", tc.raw, present, tc.present)
			}
			if present && math.Abs(got-tc.want) > 1e-9 {
				t.Errorf("Parse(%q) = %v, want %v", tc.raw, got, tc.want)
			}
		})
	}
}

// An unlisted non-numeric token must stop the build. Reading it as zero is
// how a dataset refresh silently turns "not analysed" into "contains none".
func TestValueSyntaxRejectsUnknownToken(t *testing.T) {
	for _, raw := range []string{"n/d", "*", "see note", "12.3.4", "1,2,3"} {
		if _, _, err := cofidLike.Parse(raw); !errors.Is(err, ErrUnknownToken) {
			t.Errorf("Parse(%q) error = %v, want ErrUnknownToken", raw, err)
		}
	}
}

// A trace must be distinguishable from a gap by the caller: both look
// harmless until they reach a daily total, where one is honest and the
// other under-reports.
func TestTraceAndAbsentAreDifferent(t *testing.T) {
	trV, trOK, _ := cofidLike.Parse("Tr")
	_, nOK, _ := cofidLike.Parse("N")
	if !trOK || trV != 0 {
		t.Errorf("trace = %v, %v; want 0, true", trV, trOK)
	}
	if nOK {
		t.Error("not-measured must not be present")
	}
}

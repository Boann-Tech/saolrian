package trend

import (
	"math"
	"testing"
)

func closeTo(t *testing.T, got, want, tol float64, label string) {
	t.Helper()
	if math.Abs(got-want) > tol {
		t.Fatalf("%s = %v, want %v (tol %v)", label, got, want, tol)
	}
}

func TestOLSRecoversAPlantedSlope(t *testing.T) {
	// Perfect line: 80 kg falling 0.05 kg/day.
	pts := make([]Point, 0, 15)
	for d := 0; d < 15; d++ {
		pts = append(pts, Point{Day: float64(d), KG: 80 - 0.05*float64(d)})
	}

	fit, ok := OLS(pts)
	if !ok {
		t.Fatal("OLS returned ok=false on a well-formed series")
	}
	closeTo(t, fit.Slope, -0.05, 1e-9, "slope")
	closeTo(t, fit.Intercept, 80, 1e-9, "intercept")
	closeTo(t, fit.StdErr, 0, 1e-9, "stderr on a perfect fit")
	if fit.N != 15 {
		t.Fatalf("N = %d, want 15", fit.N)
	}
}

func TestOLSStdErrGrowsWithScatter(t *testing.T) {
	clean := make([]Point, 0, 15)
	noisy := make([]Point, 0, 15)
	for d := 0; d < 15; d++ {
		base := 80 - 0.05*float64(d)
		clean = append(clean, Point{Day: float64(d), KG: base})
		// alternating ±0.4 kg water-weight swing
		swing := 0.4
		if d%2 == 1 {
			swing = -0.4
		}
		noisy = append(noisy, Point{Day: float64(d), KG: base + swing})
	}

	cf, _ := OLS(clean)
	nf, _ := OLS(noisy)
	if !(nf.StdErr > cf.StdErr) {
		t.Fatalf("noisy stderr %v should exceed clean stderr %v", nf.StdErr, cf.StdErr)
	}
	// The slope itself should survive symmetric noise.
	closeTo(t, nf.Slope, -0.05, 0.02, "noisy slope")
}

func TestOLSRejectsTooFewPoints(t *testing.T) {
	if _, ok := OLS([]Point{{Day: 0, KG: 80}, {Day: 1, KG: 79}}); ok {
		t.Fatal("OLS accepted n=2; needs n>=3 for a residual variance")
	}
}

func TestOLSRejectsZeroDayVariance(t *testing.T) {
	// Three weigh-ins all on the same day: Σ(t-t̄)² is 0, would divide by zero.
	pts := []Point{{Day: 3, KG: 80}, {Day: 3, KG: 80.4}, {Day: 3, KG: 79.6}}
	if _, ok := OLS(pts); ok {
		t.Fatal("OLS accepted a zero-variance day axis")
	}
}

func TestEMASeedsCarriesForwardAndUpdates(t *testing.T) {
	days := []string{"2026-01-01", "2026-01-02", "2026-01-03"}
	samples := []Sample{{Date: "2026-01-01", KG: 80}, {Date: "2026-01-03", KG: 84}}

	got := EMA(days, samples, 0.5)

	if len(got) != 3 {
		t.Fatalf("len = %d, want 3", len(got))
	}
	// Day 1 seeds with the first sample, not zero.
	closeTo(t, got[0].KG, 80, 1e-9, "seed")
	if got[0].Interpolated {
		t.Fatal("seed day should not be marked interpolated")
	}
	// Day 2 has no sample: carry forward, flagged.
	closeTo(t, got[1].KG, 80, 1e-9, "carried")
	if !got[1].Interpolated {
		t.Fatal("day without a sample must be marked interpolated")
	}
	// Day 3: 80 + 0.5*(84-80) = 82
	closeTo(t, got[2].KG, 82, 1e-9, "updated")
	if got[2].Interpolated {
		t.Fatal("day with a sample must not be marked interpolated")
	}
}

func TestEMASkipsDaysBeforeTheFirstSample(t *testing.T) {
	days := []string{"2026-01-01", "2026-01-02", "2026-01-03"}
	samples := []Sample{{Date: "2026-01-03", KG: 84}}

	got := EMA(days, samples, 0.5)

	if len(got) != 1 || got[0].Date != "2026-01-03" {
		t.Fatalf("got %+v, want a single point on 2026-01-03", got)
	}
}

func TestEMAWithNoSamplesIsEmpty(t *testing.T) {
	if got := EMA([]string{"2026-01-01"}, nil, 0.5); len(got) != 0 {
		t.Fatalf("got %+v, want empty", got)
	}
}

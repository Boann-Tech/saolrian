package trend

import (
	"fmt"
	"testing"
)

// window builds `n` consecutive days from 2026-01-01 at a fixed intake.
func window(n int, kcal float64) []Day {
	days := make([]Day, 0, n)
	for i := 0; i < n; i++ {
		days = append(days, Day{Date: fmt.Sprintf("2026-01-%02d", i+1), Kcal: kcal})
	}
	return days
}

// weighIns places `n` weigh-ins evenly across `span` days, on a planted slope.
func weighIns(n, span int, startKG, kgPerDay float64) []Sample {
	out := make([]Sample, 0, n)
	for i := 0; i < n; i++ {
		day := i * span / (n - 1)
		out = append(out, Sample{
			Date: fmt.Sprintf("2026-01-%02d", day+1),
			KG:   startKG + kgPerDay*float64(day),
		})
	}
	return out
}

func TestComputeRecoversPlantedTDEELosing(t *testing.T) {
	// Eat 2000/day, lose 0.5 kg/week = -0.0714286 kg/day.
	// Deficit = 0.0714286 * 7700 = 550 kcal/day, so TDEE = 2550.
	days := window(28, 2000)
	samples := weighIns(14, 27, 80, -0.5/7)

	est := Compute(days, samples)

	if !est.Sufficient {
		t.Fatalf("expected sufficient, got reason %q", est.Reason)
	}
	closeTo(t, est.ObservedTDEE, 2550, 5, "observed TDEE")
	closeTo(t, est.MeanIntake, 2000, 1e-9, "mean intake")
	closeTo(t, est.SlopePerWeek, -0.5, 1e-6, "slope per week")
	if est.QualifyingDays != 28 {
		t.Fatalf("qualifying days = %d, want 28", est.QualifyingDays)
	}
}

func TestComputeRecoversPlantedTDEEGaining(t *testing.T) {
	// Sign check in the other direction: gaining 0.25 kg/week on 3000 kcal
	// is a surplus of 275 kcal/day, so TDEE = 2725.
	days := window(28, 3000)
	samples := weighIns(14, 27, 70, 0.25/7)

	est := Compute(days, samples)

	if !est.Sufficient {
		t.Fatalf("expected sufficient, got reason %q", est.Reason)
	}
	closeTo(t, est.ObservedTDEE, 2725, 5, "observed TDEE")
}

func TestComputeMarginWidensWithScatter(t *testing.T) {
	days := window(28, 2000)
	clean := weighIns(14, 27, 80, -0.5/7)

	noisy := make([]Sample, len(clean))
	copy(noisy, clean)
	for i := range noisy {
		if i%2 == 1 {
			noisy[i].KG += 0.6
		} else {
			noisy[i].KG -= 0.6
		}
	}

	cm := Compute(days, clean).Margin
	nm := Compute(days, noisy).Margin
	if !(nm > cm) {
		t.Fatalf("noisy margin %v should exceed clean margin %v", nm, cm)
	}
}

func TestComputeExcludesNonQualifyingDaysFromTheMean(t *testing.T) {
	// 24 days at 2000, 4 days at 120 kcal (someone logged one apple).
	// Those 4 must not drag the mean down — but 24/28 is 85.7%, above the
	// 80% floor, so the estimate still stands.
	days := window(28, 2000)
	for i := 0; i < 4; i++ {
		days[i].Kcal = 120
	}
	samples := weighIns(14, 27, 80, -0.5/7)

	est := Compute(days, samples)

	if !est.Sufficient {
		t.Fatalf("expected sufficient, got reason %q", est.Reason)
	}
	closeTo(t, est.MeanIntake, 2000, 1e-9, "mean must ignore the 120 kcal days")
	if est.QualifyingDays != 24 {
		t.Fatalf("qualifying days = %d, want 24", est.QualifyingDays)
	}
}

func TestComputeGateRejections(t *testing.T) {
	good := weighIns(14, 27, 80, -0.5/7)

	cases := []struct {
		name    string
		days    []Day
		samples []Sample
		want    Reason
	}{
		{"no days at all", nil, good, ReasonNoData},
		{"no weigh-ins", window(28, 2000), nil, ReasonFewWeighIns},
		{
			// 20 of 28 qualifying = 71%, below the 80% floor.
			name: "sparse logging",
			days: func() []Day {
				d := window(28, 2000)
				for i := 0; i < 8; i++ {
					d[i].Kcal = 0
				}
				return d
			}(),
			samples: good,
			want:    ReasonSparseLogging,
		},
		{"too few weigh-ins", window(28, 2000), weighIns(4, 27, 80, -0.5/7), ReasonFewWeighIns},
		{
			// 10 weigh-ins, plenty by count, but crammed into 5 days: the
			// slope is fitted to water-weight noise and extrapolated.
			name:    "clustered weigh-ins",
			days:    window(28, 2000),
			samples: weighIns(10, 4, 80, -0.5/7),
			want:    ReasonShortSpan,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			est := Compute(tc.days, tc.samples)
			if est.Sufficient {
				t.Fatal("expected insufficient")
			}
			if est.Reason != tc.want {
				t.Fatalf("reason = %q, want %q", est.Reason, tc.want)
			}
			if est.ObservedTDEE != 0 {
				t.Fatalf("an insufficient estimate must not report a number, got %v", est.ObservedTDEE)
			}
		})
	}
}

func TestComputeReportsCountsEvenWhenInsufficient(t *testing.T) {
	// The UI says "you have 6 of 8 weigh-ins", so the counts must survive
	// a rejection.
	est := Compute(window(28, 2000), weighIns(6, 27, 80, -0.5/7))

	if est.Sufficient {
		t.Fatal("expected insufficient")
	}
	if est.WeighIns != 6 {
		t.Fatalf("weigh-ins = %d, want 6", est.WeighIns)
	}
	if est.QualifyingDays != 28 {
		t.Fatalf("qualifying days = %d, want 28", est.QualifyingDays)
	}
}

func TestTCriticalTable(t *testing.T) {
	closeTo(t, tCritical(1), 12.706, 1e-3, "df=1")
	closeTo(t, tCritical(10), 2.228, 1e-3, "df=10")
	closeTo(t, tCritical(30), 2.042, 1e-3, "df=30")
	closeTo(t, tCritical(500), 1.96, 1e-3, "df beyond the table")
	closeTo(t, tCritical(0), 12.706, 1e-3, "df<1 clamps to the widest entry")
}

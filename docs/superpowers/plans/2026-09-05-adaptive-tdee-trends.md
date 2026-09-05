# Adaptive TDEE and Trend Charts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derive an observed TDEE from the user's own energy balance, offer it as a suggestion they explicitly accept, and add a Trends screen of user-selectable charts over their logged history.

**Architecture:** A pure Go package (`internal/trend`) does all the maths with no database imports. One new endpoint (`/api/saolrian/trends`) runs four aggregate queries and returns a single payload. Every frontend card is a pure transform of that one payload, so toggling cards costs no requests. Accepting a suggestion writes `calorie_target`, which is already the manual-override branch in `userBudget`, so the budget resolver is not touched.

**Tech Stack:** Go 1.27, PocketBase 0.40.2 (`github.com/boanntech/saolrian/backend`), React 19 + TypeScript + Vite 6, Tailwind v4 design tokens, vitest + @testing-library/react, hand-rolled SVG (no charting dependency).

**Spec:** `docs/superpowers/specs/2026-09-05-adaptive-tdee-trends-design.md`

## Global Constraints

- **No new frontend dependencies.** Charts are hand-rolled SVG. Do not add Recharts, uPlot, Chart.js, or d3.
- **No new backend dependencies.** Everything needed is in the standard library plus what `go.mod` already has.
- **Day bucketing is UTC**, matching `/summary`. Use `substr(logged_at, 1, 10)` — **not** SQLite `date()`, which does not reliably parse PocketBase's `"YYYY-MM-DD HH:MM:SS.SSSZ"` (space separator plus trailing `Z` is not one of SQLite's accepted time formats).
- **`exercise_entries` must NOT feed the estimator.** The collection exists (written by the LoseIt import) but is read by nothing. Observed TDEE derived from energy balance *already includes* all exercise by construction — adding logged exercise kcal would double-count it and inflate the estimate. Do not "improve" the estimator by including it.
- **Unlogged days are excluded from the mean, never counted as zero.**
- **`calorie_target` semantics are unchanged.** Do not modify `userBudget` in `backend/internal/routes/summary.go`.
- **7700 kcal/kg** is the conversion constant, matching `tdee.Budget`'s existing goal-rate arithmetic.
- **Estimate window is 28 days and is independent of the chart display range.**
- `gofmt -w` every Go file you create. The repo is **not** globally gofmt-clean; do not reformat files this plan does not touch.
- User-scoped collections use `ownerRule = "user = @request.auth.id"`.

### Two vocabulary points that cause bugs if missed

1. **`logged` in the payload** means *the user recorded anything at all that day* (`entries > 0`). Charts use it to render a day as blank rather than as a zero.
2. **`qualifying` in the estimate** means *that day's kcal total is ≥ 500*. Only qualifying days enter the mean intake. The spec calls these "logged days"; this plan renames the estimate's JSON field to `qualifying_days` so the two notions cannot be confused. Same semantics as the spec, clearer name.

---

## File Structure

| File | Responsibility |
|---|---|
| `backend/internal/trend/trend.go` | Pure maths: `OLS`, `EMA`, `Compute`, completeness gate, t-table |
| `backend/internal/trend/trend_test.go` | Table tests against planted answers |
| `backend/internal/routes/trends.go` | Endpoint: four aggregate queries, payload assembly |
| `backend/internal/routes/trends_test.go` | Integration tests on a `tests.TestApp` |
| `backend/internal/migrations/trend_cards.go` | Three additive `profiles` fields |
| `frontend/src/lib/types.ts` | *(modify)* `TrendsPayload`, `TrendDay`, `TrendEstimate`, `CardId` |
| `frontend/src/lib/trends.ts` | Payload → per-card series; card registry and defaults |
| `frontend/src/lib/trends.test.ts` | Transform unit tests |
| `frontend/src/components/ui/charts/scale.ts` | Scale/path helpers shared by all charts |
| `frontend/src/components/ui/charts/LineChart.tsx` | `weight`, `balance` |
| `frontend/src/components/ui/charts/BarChart.tsx` | `intake`, `macros`, `weekday`, `water`, `steps` |
| `frontend/src/components/ui/charts/Heatmap.tsx` | `consistency` |
| `frontend/src/components/ui/charts/StackedBar.tsx` | `meals` |
| `frontend/src/screens/Trends.tsx` | Shell: range selector, enabled-card list, customise sheet |
| `frontend/src/screens/trends/cards/*.tsx` | One file per card |
| `frontend/src/screens/__tests__/Trends.test.tsx` | Screen tests |
| `frontend/src/components/AppShell.tsx` | *(modify)* fourth tab |
| `frontend/src/main.tsx` | *(modify)* `/trends` route |

One card per file is deliberate: `AddFood.tsx` at 649 lines is the warning. `Trends.tsx` stays a shell that maps over enabled ids.

---

### Task 1: Regression and smoothing primitives

**Files:**
- Create: `backend/internal/trend/trend.go`
- Test: `backend/internal/trend/trend_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `trend.Point{Day float64; KG float64}`, `trend.Fit{Slope, Intercept, StdErr float64; N int}`, `trend.OLS([]Point) (Fit, bool)`, `trend.Sample{Date string; KG float64}`, `trend.EMAPoint{Date string; KG float64; Interpolated bool}`, `trend.EMA(days []string, samples []Sample, alpha float64) []EMAPoint`, `trend.EMAAlpha = 0.10`.

- [ ] **Step 1: Write the failing tests**

Create `backend/internal/trend/trend_test.go`:

```go
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
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd backend && go test ./internal/trend/ -run 'TestOLS|TestEMA' -v
```

Expected: FAIL — the package does not compile, `undefined: Point`, `undefined: OLS`.

- [ ] **Step 3: Write the implementation**

Create `backend/internal/trend/trend.go`:

```go
// Package trend derives trend lines and an observed TDEE from a user's own
// logged history.
//
// Everything here is a function of its arguments: no database, no clock, no
// PocketBase imports. That keeps the whole estimator table-testable and lets
// the endpoint stay a thin adapter over it.
package trend

import "math"

// EMAAlpha is the smoothing factor for the displayed weight trend line.
// 0.10 is the long-standing Hacker's Diet value: slow enough to ignore a
// single salty dinner, fast enough to turn within a couple of weeks.
const EMAAlpha = 0.10

// Point is one weigh-in expressed against the window's day axis.
type Point struct {
	Day float64 // days since the window start
	KG  float64
}

// Fit is an ordinary-least-squares line through the weigh-ins.
type Fit struct {
	Slope     float64 // kg/day; negative means losing
	Intercept float64 // kg at Day 0
	StdErr    float64 // standard error of Slope
	N         int
}

// OLS fits weight against time.
//
// Regression rather than a first-to-last delta because weigh-ins arrive at
// irregular intervals, every measurement should count, and the standard error
// is what lets the caller report an honest interval instead of a bare number.
//
// Returns ok=false when there are fewer than three points (no residual
// variance to estimate) or when every point falls on the same day (the day
// axis has zero variance and the slope is undefined).
func OLS(pts []Point) (Fit, bool) {
	n := len(pts)
	if n < 3 {
		return Fit{}, false
	}

	var sumT, sumW float64
	for _, p := range pts {
		sumT += p.Day
		sumW += p.KG
	}
	meanT := sumT / float64(n)
	meanW := sumW / float64(n)

	var sxx, sxy float64
	for _, p := range pts {
		dt := p.Day - meanT
		sxx += dt * dt
		sxy += dt * (p.KG - meanW)
	}
	if sxx == 0 {
		return Fit{}, false
	}

	slope := sxy / sxx
	intercept := meanW - slope*meanT

	// Residual variance, then the standard error of the slope.
	var ssr float64
	for _, p := range pts {
		resid := p.KG - (intercept + slope*p.Day)
		ssr += resid * resid
	}
	s2 := ssr / float64(n-2)

	return Fit{
		Slope:     slope,
		Intercept: intercept,
		StdErr:    math.Sqrt(s2 / sxx),
		N:         n,
	}, true
}

// Sample is one weigh-in on a calendar day (YYYY-MM-DD, UTC).
type Sample struct {
	Date string
	KG   float64
}

// EMAPoint is one day of the smoothed trend line. Interpolated marks a day
// that carried the previous value forward because nothing was weighed, so the
// renderer can draw a continuing line without implying a measurement.
type EMAPoint struct {
	Date         string
	KG           float64
	Interpolated bool
}

// EMA walks days in order, updating on days that have a sample and carrying
// the last value forward on days that don't. It is seeded with the first
// sample rather than zero, and emits nothing before that day — a line that
// starts at 0 kg and rockets to 80 is worse than no line.
//
// The EMA is for the eye. The number comes from OLS.
func EMA(days []string, samples []Sample, alpha float64) []EMAPoint {
	if len(samples) == 0 {
		return nil
	}

	byDate := make(map[string]float64, len(samples))
	for _, s := range samples {
		byDate[s.Date] = s.KG // a later weigh-in on the same day wins
	}

	out := make([]EMAPoint, 0, len(days))
	var ema float64
	started := false

	for _, d := range days {
		kg, ok := byDate[d]
		if !ok {
			if !started {
				continue // nothing to carry forward yet
			}
			out = append(out, EMAPoint{Date: d, KG: ema, Interpolated: true})
			continue
		}
		if !started {
			ema = kg
			started = true
		} else {
			ema += alpha * (kg - ema)
		}
		out = append(out, EMAPoint{Date: d, KG: ema})
	}

	return out
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd backend && gofmt -w internal/trend/ && go test ./internal/trend/ -v
```

Expected: PASS, all seven tests.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/trend/
git commit -m "feat(trend): OLS weight-rate fit and EMA smoothing"
```

---

### Task 2: Observed TDEE and the completeness gate

**Files:**
- Modify: `backend/internal/trend/trend.go` (append)
- Test: `backend/internal/trend/estimate_test.go`

**Interfaces:**
- Consumes: `Point`, `Fit`, `OLS`, `Sample` from Task 1.
- Produces: constants `WindowDays = 28`, `MinLoggedKcal = 500`, `MinQualifyingFrac = 0.80`, `MinWeighIns = 8`, `MinSpanDays = 21`, `KcalPerKG = 7700.0`; `type Reason string` with `ReasonNone`, `ReasonNoData`, `ReasonSparseLogging`, `ReasonFewWeighIns`, `ReasonShortSpan`; `type Day struct{ Date string; Kcal float64 }`; `type Estimate struct{...}`; `func Compute(days []Day, samples []Sample) Estimate`.

- [ ] **Step 1: Write the failing tests**

Create `backend/internal/trend/estimate_test.go`:

```go
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
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd backend && go test ./internal/trend/ -run 'TestCompute|TestTCritical' -v
```

Expected: FAIL — `undefined: Compute`, `undefined: Day`, `undefined: tCritical`.

- [ ] **Step 3: Write the implementation**

Append to `backend/internal/trend/trend.go`:

```go
// Gate thresholds. An estimate built on thin data is worse than no estimate,
// because it looks just as confident.
const (
	// WindowDays is the estimation window. Long enough for a real signal to
	// clear water-weight noise, short enough to track a changing body.
	// Independent of whatever range the charts happen to be displaying.
	WindowDays = 28

	// MinLoggedKcal is the floor for a day to count toward mean intake. A day
	// where someone logged a single apple is not a logged day, and admitting
	// it drags the mean down and the estimated TDEE with it.
	MinLoggedKcal = 500

	// MinQualifyingFrac is the share of window days that must qualify.
	MinQualifyingFrac = 0.80

	// MinWeighIns is the number of weigh-ins needed for a credible slope.
	MinWeighIns = 8

	// MinSpanDays is the minimum first-to-last weigh-in span. Eight weigh-ins
	// clustered into four days produce a confident-looking slope fitted to
	// water-weight noise and then extrapolated across a month.
	MinSpanDays = 21

	// KcalPerKG is the conventional Wishnofsky figure, matching the goal-rate
	// arithmetic already in tdee.Budget.
	KcalPerKG = 7700.0
)

// Reason explains why an estimate was withheld, as a stable constant the UI
// turns into specific copy rather than a generic shrug.
type Reason string

const (
	ReasonNone          Reason = ""
	ReasonNoData        Reason = "no_data"
	ReasonSparseLogging Reason = "sparse_logging"
	ReasonFewWeighIns   Reason = "few_weigh_ins"
	ReasonShortSpan     Reason = "short_span"
)

// Day is one calendar day's intake. Kcal is the day's total; a day with no
// entries is Kcal 0 and simply fails the qualifying floor.
type Day struct {
	Date string
	Kcal float64
}

// Estimate is the observed-TDEE result. When Sufficient is false, Reason says
// why and ObservedTDEE/Margin are zero — but the counts are still populated so
// the UI can say how far off the user is.
type Estimate struct {
	Sufficient     bool
	Reason         Reason
	WindowDays     int
	ObservedTDEE   float64
	Margin         float64
	SlopePerWeek   float64
	MeanIntake     float64
	QualifyingDays int
	WeighIns       int
	SpanDays       int
}

// tCritical returns the two-tailed 95% critical value for the given degrees of
// freedom. A flat 1.96 would understate the interval at the sample sizes this
// actually runs on (8-28 weigh-ins), and the entire point of the interval is
// to be honest about how little a month of noisy weigh-ins can tell you.
func tCritical(df int) float64 {
	table := [...]float64{
		12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
		2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
		2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042,
	}
	if df < 1 {
		return table[0]
	}
	if df > len(table) {
		return 1.96
	}
	return table[df-1]
}

// Compute derives observed TDEE from energy balance over the window.
//
// The caller passes exactly the window's days, in ascending date order, and
// every weigh-in falling inside it.
//
//	mean_intake = mean kcal over qualifying days
//	observed    = mean_intake - slope_kg_per_day * KcalPerKG
//
// Sign check: gaining 0.1 kg/day is a 770 kcal/day surplus, so intake exceeds
// expenditure by 770 and observed = mean_intake - 770. Correct.
//
// Two limitations are deliberately documented rather than modelled:
//
// The result is TDEE at the window's *average* weight. Someone losing weight
// has a falling TDEE and a 28-day window returns its midpoint; at realistic
// rates that is tens of kcal, well inside the reported margin, and modelling
// it would mean fitting a moving target for no visible gain.
//
// Chronic under-logging biases the estimate low, and that is fine — in fact it
// is why the technique works. People under-report by 10-20%. The estimate
// absorbs that bias, which means it is expressed in the user's own logging
// units, and a budget derived from it is then applied to that same
// under-reporting. The two errors cancel where it matters. Do not "fix" this.
//
// Exercise is likewise NOT added in from exercise_entries: an estimate built
// from energy balance already includes every calorie the user burned, however
// they burned it. Adding logged exercise on top double-counts it.
func Compute(days []Day, samples []Sample) Estimate {
	est := Estimate{WindowDays: WindowDays, Reason: ReasonNone}

	if len(days) == 0 {
		est.Reason = ReasonNoData
		return est
	}

	// Mean intake over qualifying days only. Days below the floor are
	// excluded from both numerator and denominator — never counted as zero.
	var sum float64
	qualifying := make([]float64, 0, len(days))
	for _, d := range days {
		if d.Kcal >= MinLoggedKcal {
			sum += d.Kcal
			qualifying = append(qualifying, d.Kcal)
		}
	}
	est.QualifyingDays = len(qualifying)
	est.WeighIns = len(samples)

	if len(samples) > 0 {
		est.SpanDays = daySpan(samples)
	}

	if float64(est.QualifyingDays) < MinQualifyingFrac*float64(len(days)) {
		est.Reason = ReasonSparseLogging
		return est
	}
	if est.WeighIns < MinWeighIns {
		est.Reason = ReasonFewWeighIns
		return est
	}
	if est.SpanDays < MinSpanDays {
		est.Reason = ReasonShortSpan
		return est
	}

	// Weigh-ins onto the window's day axis, indexed from the first day.
	index := make(map[string]int, len(days))
	for i, d := range days {
		index[d.Date] = i
	}
	pts := make([]Point, 0, len(samples))
	for _, s := range samples {
		if i, ok := index[s.Date]; ok {
			pts = append(pts, Point{Day: float64(i), KG: s.KG})
		}
	}

	fit, ok := OLS(pts)
	if !ok {
		est.Reason = ReasonFewWeighIns
		return est
	}

	mean := sum / float64(est.QualifyingDays)
	est.MeanIntake = mean
	est.SlopePerWeek = fit.Slope * 7
	est.ObservedTDEE = mean - fit.Slope*KcalPerKG

	// Both terms carry uncertainty and both belong in the interval: the
	// sampling error of the mean intake, and the regression's slope error
	// scaled into kcal.
	//
	// The two standard errors carry different degrees of freedom, so combining
	// them under the slope's df is an approximation. Welch-Satterthwaite
	// machinery would be more correct, for a number displayed rounded to the
	// nearest 10 kcal.
	seMean := stdDev(qualifying, mean) / math.Sqrt(float64(est.QualifyingDays))
	seSlopeKcal := fit.StdErr * KcalPerKG
	est.Margin = tCritical(fit.N-2) * math.Sqrt(seMean*seMean+seSlopeKcal*seSlopeKcal)

	est.Sufficient = true
	return est
}

// stdDev is the sample standard deviation about a known mean.
func stdDev(xs []float64, mean float64) float64 {
	if len(xs) < 2 {
		return 0
	}
	var ss float64
	for _, x := range xs {
		d := x - mean
		ss += d * d
	}
	return math.Sqrt(ss / float64(len(xs)-1))
}

// daySpan returns the number of days between the earliest and latest sample.
// Dates are YYYY-MM-DD and lexicographic order is chronological order, so this
// needs no time parsing.
func daySpan(samples []Sample) int {
	lo, hi := samples[0].Date, samples[0].Date
	for _, s := range samples[1:] {
		if s.Date < lo {
			lo = s.Date
		}
		if s.Date > hi {
			hi = s.Date
		}
	}
	return daysBetween(lo, hi)
}
```

Add `daysBetween` and the `time` import — dates are UTC calendar days:

```go
// daysBetween returns hi - lo in whole days for two YYYY-MM-DD dates.
func daysBetween(lo, hi string) int {
	l, err1 := time.Parse("2006-01-02", lo)
	h, err2 := time.Parse("2006-01-02", hi)
	if err1 != nil || err2 != nil {
		return 0
	}
	return int(h.Sub(l).Hours() / 24)
}
```

Update the import block at the top of the file to `import (\n\t"math"\n\t"time"\n)`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd backend && gofmt -w internal/trend/ && go test ./internal/trend/ -v
```

Expected: PASS, all tests including Task 1's.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/trend/
git commit -m "feat(trend): observed TDEE with completeness gate and t-based margin"
```

---

### Task 3: Profile fields migration

**Files:**
- Create: `backend/internal/migrations/trend_cards.go`
- Test: `backend/internal/migrations/trend_cards_test.go`

**Interfaces:**
- Consumes: existing `ownerRule` constant in package `migrations`.
- Produces: `profiles.trend_cards` (JSON), `profiles.calorie_target_source` (select `manual`|`observed`), `profiles.calorie_target_set_at` (date).

- [ ] **Step 1: Write the failing test**

Create `backend/internal/migrations/trend_cards_test.go`:

```go
package migrations_test

import (
	"testing"

	_ "github.com/boanntech/saolrian/backend/internal/migrations"
	"github.com/pocketbase/pocketbase/tests"
)

func TestTrendFieldsExistOnProfiles(t *testing.T) {
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	defer app.Cleanup()

	if err := app.RunAppMigrations(); err != nil {
		t.Fatalf("failed to run migrations: %v", err)
	}

	profiles, err := app.FindCollectionByNameOrId("profiles")
	if err != nil {
		t.Fatalf("profiles collection missing: %v", err)
	}

	for _, name := range []string{"trend_cards", "calorie_target_source", "calorie_target_set_at"} {
		if profiles.Fields.GetByName(name) == nil {
			t.Errorf("profiles.%s field missing", name)
		}
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend && go test ./internal/migrations/ -run TestTrendFields -v
```

Expected: FAIL — "profiles.trend_cards field missing" and the other two.

- [ ] **Step 3: Write the migration**

Create `backend/internal/migrations/trend_cards.go`:

```go
// Trends: three additive fields on profiles — which trend cards the user has
// enabled, and the provenance of the current calorie target.
//
// The provenance pair is what turns the observed-TDEE suggestion from a
// one-shot calculation into a loop: without it, an accepted target is
// indistinguishable from a number the user typed in once and forgot.
package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(func(app core.App) error {
		profiles, err := app.FindCollectionByNameOrId("profiles")
		if err != nil {
			return err
		}

		profiles.Fields.Add(
			// Ordered array of enabled card ids. Presence means enabled and
			// position means display order, so one field covers visibility now
			// and drag-reorder later. Null or absent means "use the defaults",
			// which makes every existing profile correct with no backfill.
			&core.JSONField{Name: "trend_cards", MaxSize: 2000},
			// Where the current calorie_target came from. Empty means the user
			// typed it or it was never set.
			&core.SelectField{
				Name:      "calorie_target_source",
				Values:    []string{"manual", "observed"},
				MaxSelect: 1,
			},
			&core.DateField{Name: "calorie_target_set_at"},
		)

		return app.Save(profiles)
	}, func(app core.App) error {
		profiles, err := app.FindCollectionByNameOrId("profiles")
		if err != nil {
			return nil
		}
		profiles.Fields.RemoveByName("trend_cards")
		profiles.Fields.RemoveByName("calorie_target_source")
		profiles.Fields.RemoveByName("calorie_target_set_at")
		return app.Save(profiles)
	}, "saolrian_trend_cards.go")
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd backend && gofmt -w internal/migrations/trend_cards.go && go test ./internal/migrations/ -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/migrations/
git commit -m "feat(trends): add trend_cards and calorie-target provenance to profiles"
```

---

### Task 4: The `/trends` endpoint

**Files:**
- Create: `backend/internal/routes/trends.go`
- Test: `backend/internal/routes/trends_test.go`
- Modify: `backend/internal/routes/summary.go` (the `Register` function only — add one route line)

**Interfaces:**
- Consumes: `trend.Compute`, `trend.EMA`, `trend.Day`, `trend.Sample`, `trend.WindowDays`, `trend.EMAAlpha`, `trend.KcalPerKG`.
- Produces: `GET /api/saolrian/trends?days=N` returning the payload in the spec's §2, and helper `buildTrends(app core.App, uid string, days int, today time.Time) (map[string]any, error)` — exported to the package so the test can call it without an HTTP round trip.

**Payload contract** (the frontend in Task 5 depends on these exact key names):

```jsonc
{
  "range": { "from": "2026-06-08", "to": "2026-09-05", "days": 90 },
  "days": [ { "date": "2026-06-08", "kcal": 2103, "protein": 142, "carbs": 180,
              "fat": 78, "entries": 11, "logged": true,
              "water_ml": 2000, "steps": 8412, "by_slot": { "slot_id": 620 } } ],
  "weights": [ { "date": "2026-06-08", "kg": 83.4 } ],
  "ema": [ { "date": "2026-06-08", "kg": 83.4, "interpolated": false } ],
  "budget": 1690,
  "formula_tdee": 2240,
  "goal": "lose",
  "goal_rate": -0.5,
  // Provenance of the current calorie_target. "" means never set or typed by
  // hand; "observed" means accepted from a previous suggestion, and the date
  // is what lets the card offer a recheck once it has drifted.
  "target_source": "observed",
  "target_set_at": "2026-08-12 09:14:00.000Z",
  "targets": { "protein_g": 168, "carbs_g": 224, "fat_g": 75,
               "water_ml": 2000, "steps": 10000 },
  "slots": [ { "id": "s1", "name": "Breakfast", "sort_order": 0, "pct_allocation": 25 } ],
  "estimate": { "sufficient": true, "reason": "", "window_days": 28,
                "observed_tdee": 2512, "margin": 180, "slope_kg_per_week": -0.42,
                "mean_intake": 2050, "qualifying_days": 26, "weigh_ins": 14,
                "span_days": 27, "suggested_target": 1962 }
}
```

- [ ] **Step 1: Write the failing tests**

Create `backend/internal/routes/trends_test.go`:

```go
package routes

import (
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

// seedDiary writes one diary entry of `kcal` on the given UTC date.
func seedDiary(t *testing.T, app core.App, uid, slotID, date string, kcal float64) {
	t.Helper()
	col, err := app.FindCollectionByNameOrId("diary_entries")
	if err != nil {
		t.Fatalf("diary_entries missing: %v", err)
	}
	rec := core.NewRecord(col)
	rec.Set("user", uid)
	rec.Set("meal_slot", slotID)
	rec.Set("name_snapshot", "Test food")
	rec.Set("grams", 100)
	rec.Set("kcal", kcal)
	rec.Set("protein", 10)
	rec.Set("carbs", 20)
	rec.Set("fat", 5)
	rec.Set("logged_at", date+" 12:00:00.000Z")
	rec.Set("source", "manual")
	if err := app.Save(rec); err != nil {
		t.Fatalf("failed to seed diary entry: %v", err)
	}
}

func seedWeight(t *testing.T, app core.App, uid, date string, kg float64) {
	t.Helper()
	col, err := app.FindCollectionByNameOrId("weights")
	if err != nil {
		t.Fatalf("weights missing: %v", err)
	}
	rec := core.NewRecord(col)
	rec.Set("user", uid)
	rec.Set("kg", kg)
	rec.Set("measured_at", date+" 07:00:00.000Z")
	if err := app.Save(rec); err != nil {
		t.Fatalf("failed to seed weight: %v", err)
	}
}

func seedSlot(t *testing.T, app core.App, uid string) string {
	t.Helper()
	col, err := app.FindCollectionByNameOrId("meal_slots")
	if err != nil {
		t.Fatalf("meal_slots missing: %v", err)
	}
	rec := core.NewRecord(col)
	rec.Set("user", uid)
	rec.Set("name", "Lunch")
	rec.Set("sort_order", 0)
	if err := app.Save(rec); err != nil {
		t.Fatalf("failed to seed slot: %v", err)
	}
	return rec.Id
}

func TestBuildTrendsZeroFillsAndMarksUnloggedDays(t *testing.T) {
	app, user := newTestAppWithUser(t)
	slot := seedSlot(t, app, user.Id)
	today := time.Date(2026, 3, 10, 0, 0, 0, 0, time.UTC)

	// Two logged days with a three-day gap between them.
	seedDiary(t, app, user.Id, slot, "2026-03-05", 2000)
	seedDiary(t, app, user.Id, slot, "2026-03-09", 1800)

	out, err := buildTrends(app, user.Id, 7, today)
	if err != nil {
		t.Fatalf("buildTrends: %v", err)
	}

	days := out["days"].([]dayJSON)
	if len(days) != 7 {
		t.Fatalf("len(days) = %d, want 7 (one row per calendar day)", len(days))
	}
	if days[0].Date != "2026-03-04" || days[6].Date != "2026-03-10" {
		t.Fatalf("range = %s..%s, want 2026-03-04..2026-03-10", days[0].Date, days[6].Date)
	}

	byDate := map[string]dayJSON{}
	for _, d := range days {
		byDate[d.Date] = d
	}
	if got := byDate["2026-03-05"]; !got.Logged || got.Kcal != 2000 {
		t.Fatalf("2026-03-05 = %+v, want logged with 2000 kcal", got)
	}
	if got := byDate["2026-03-06"]; got.Logged || got.Kcal != 0 {
		t.Fatalf("2026-03-06 = %+v, want unlogged and zero-filled", got)
	}
}

func TestBuildTrendsBucketsByUTCDateNotLocal(t *testing.T) {
	app, user := newTestAppWithUser(t)
	slot := seedSlot(t, app, user.Id)
	today := time.Date(2026, 3, 10, 0, 0, 0, 0, time.UTC)

	// 23:30Z on the 7th belongs to the 7th, matching /summary's bucketing.
	col, _ := app.FindCollectionByNameOrId("diary_entries")
	rec := core.NewRecord(col)
	rec.Set("user", user.Id)
	rec.Set("meal_slot", slot)
	rec.Set("name_snapshot", "Late snack")
	rec.Set("kcal", 500)
	rec.Set("logged_at", "2026-03-07 23:30:00.000Z")
	rec.Set("source", "manual")
	if err := app.Save(rec); err != nil {
		t.Fatalf("save: %v", err)
	}

	out, err := buildTrends(app, user.Id, 7, today)
	if err != nil {
		t.Fatalf("buildTrends: %v", err)
	}

	for _, d := range out["days"].([]dayJSON) {
		if d.Date == "2026-03-07" && d.Kcal != 500 {
			t.Fatalf("2026-03-07 kcal = %v, want 500", d.Kcal)
		}
		if d.Date == "2026-03-08" && d.Kcal != 0 {
			t.Fatalf("2026-03-08 kcal = %v, want 0 — entry leaked across the UTC boundary", d.Kcal)
		}
	}
}

func TestBuildTrendsReturnsInsufficientForANewUser(t *testing.T) {
	app, user := newTestAppWithUser(t)
	today := time.Date(2026, 3, 10, 0, 0, 0, 0, time.UTC)

	out, err := buildTrends(app, user.Id, 90, today)
	if err != nil {
		t.Fatalf("a new user with no data must not error: %v", err)
	}

	est := out["estimate"].(estimateJSON)
	if est.Sufficient {
		t.Fatal("a user with no data cannot have a sufficient estimate")
	}
	if est.Reason == "" {
		t.Fatal("an insufficient estimate must carry a reason")
	}
}

func TestBuildTrendsScopesToTheRequestingUser(t *testing.T) {
	app, user := newTestAppWithUser(t)
	slot := seedSlot(t, app, user.Id)
	today := time.Date(2026, 3, 10, 0, 0, 0, 0, time.UTC)

	seedDiary(t, app, user.Id, slot, "2026-03-09", 1800)

	// A second user's data must never appear in the first user's payload.
	usersCol, _ := app.FindCollectionByNameOrId("users")
	other := core.NewRecord(usersCol)
	other.SetEmail("other-trends@example.com")
	other.SetPassword("test-password-123")
	if err := app.Save(other); err != nil {
		t.Fatalf("save other user: %v", err)
	}
	otherSlot := seedSlot(t, app, other.Id)
	seedDiary(t, app, other.Id, otherSlot, "2026-03-09", 9999)

	out, err := buildTrends(app, user.Id, 7, today)
	if err != nil {
		t.Fatalf("buildTrends: %v", err)
	}

	for _, d := range out["days"].([]dayJSON) {
		if d.Date == "2026-03-09" && d.Kcal != 1800 {
			t.Fatalf("2026-03-09 kcal = %v, want 1800 — another user's rows leaked in", d.Kcal)
		}
	}
}

func TestBuildTrendsComputesEMAOverWeighIns(t *testing.T) {
	app, user := newTestAppWithUser(t)
	today := time.Date(2026, 3, 10, 0, 0, 0, 0, time.UTC)

	seedWeight(t, app, user.Id, "2026-03-08", 80)
	seedWeight(t, app, user.Id, "2026-03-10", 82)

	out, err := buildTrends(app, user.Id, 7, today)
	if err != nil {
		t.Fatalf("buildTrends: %v", err)
	}

	weights := out["weights"].([]weightJSON)
	if len(weights) != 2 {
		t.Fatalf("len(weights) = %d, want 2", len(weights))
	}
	ema := out["ema"].([]emaJSON)
	if len(ema) != 3 {
		t.Fatalf("len(ema) = %d, want 3 (08th seed, 09th carried, 10th updated)", len(ema))
	}
	if !ema[1].Interpolated {
		t.Fatal("the 09th has no weigh-in and must be marked interpolated")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd backend && go test ./internal/routes/ -run TestBuildTrends -v
```

Expected: FAIL — `undefined: buildTrends`, `undefined: dayJSON`.

- [ ] **Step 3: Write the implementation**

Create `backend/internal/routes/trends.go`:

```go
package routes

import (
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"

	"github.com/boanntech/saolrian/backend/internal/tdee"
	"github.com/boanntech/saolrian/backend/internal/trend"
)

// ---------------------------------------------------------------------
// GET /api/saolrian/trends?days=90
// ---------------------------------------------------------------------

const (
	defaultTrendDays = 90
	minTrendDays     = 7
	maxTrendDays     = 730
)

type dayJSON struct {
	Date    string             `json:"date"`
	Kcal    float64            `json:"kcal"`
	Protein float64            `json:"protein"`
	Carbs   float64            `json:"carbs"`
	Fat     float64            `json:"fat"`
	Entries int                `json:"entries"`
	Logged  bool               `json:"logged"`
	WaterML float64            `json:"water_ml"`
	Steps   float64            `json:"steps"`
	BySlot  map[string]float64 `json:"by_slot"`
}

type weightJSON struct {
	Date string  `json:"date"`
	KG   float64 `json:"kg"`
}

type emaJSON struct {
	Date         string  `json:"date"`
	KG           float64 `json:"kg"`
	Interpolated bool    `json:"interpolated"`
}

type estimateJSON struct {
	Sufficient      bool    `json:"sufficient"`
	Reason          string  `json:"reason"`
	WindowDays      int     `json:"window_days"`
	ObservedTDEE    float64 `json:"observed_tdee"`
	Margin          float64 `json:"margin"`
	SlopePerWeek    float64 `json:"slope_kg_per_week"`
	MeanIntake      float64 `json:"mean_intake"`
	QualifyingDays  int     `json:"qualifying_days"`
	WeighIns        int     `json:"weigh_ins"`
	SpanDays        int     `json:"span_days"`
	SuggestedTarget float64 `json:"suggested_target"`
}

type trendSlotJSON struct {
	ID            string  `json:"id"`
	Name          string  `json:"name"`
	SortOrder     float64 `json:"sort_order"`
	PctAllocation float64 `json:"pct_allocation"`
}

func trendsHandler(e *core.RequestEvent) error {
	uid := e.Auth.Id

	days := defaultTrendDays
	if raw := e.Request.URL.Query().Get("days"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			days = n
		}
	}
	if days < minTrendDays {
		days = minTrendDays
	}
	if days > maxTrendDays {
		days = maxTrendDays
	}

	out, err := buildTrends(e.App, uid, days, time.Now().UTC())
	if err != nil {
		return e.InternalServerError("failed to build trends", err)
	}
	return e.JSON(http.StatusOK, out)
}

// buildTrends assembles the whole payload.
//
// `today` is injected rather than read from the clock so the tests can pin a
// date. Day bucketing is UTC throughout, matching /summary — see dayKeyExpr.
func buildTrends(app core.App, uid string, days int, today time.Time) (map[string]any, error) {
	to := today.UTC().Format("2006-01-02")
	from := today.UTC().AddDate(0, 0, -(days - 1)).Format("2006-01-02")

	// The half-open range [from 00:00Z, nextDay(to) 00:00Z), exactly the
	// string-comparison bucketing /summary uses.
	start := from + " 00:00:00.000Z"
	end := nextDay(to) + " 00:00:00.000Z"

	calendar := calendarDays(from, days)

	dayRows, err := queryDayTotals(app, uid, start, end)
	if err != nil {
		return nil, err
	}
	slotRows, err := querySlotTotals(app, uid, start, end)
	if err != nil {
		return nil, err
	}
	metricRows, err := queryMetrics(app, uid, start, end)
	if err != nil {
		return nil, err
	}
	weights, err := queryWeights(app, uid, start, end)
	if err != nil {
		return nil, err
	}

	// Zero-fill: one row per calendar day, so no card has to reconstruct the
	// calendar and "recorded nothing" stays distinct from "ate zero calories".
	out := make([]dayJSON, 0, len(calendar))
	for _, d := range calendar {
		row := dayJSON{Date: d, BySlot: map[string]float64{}}
		if agg, ok := dayRows[d]; ok {
			row.Kcal = agg.Kcal
			row.Protein = agg.Protein
			row.Carbs = agg.Carbs
			row.Fat = agg.Fat
			row.Entries = agg.Entries
			row.Logged = agg.Entries > 0
		}
		if m, ok := metricRows[d]; ok {
			row.WaterML = m.WaterML
			row.Steps = m.Steps
		}
		for _, s := range slotRows[d] {
			row.BySlot[s.SlotID] = s.Kcal
		}
		out = append(out, row)
	}

	// Estimate over the trailing window, independent of the display range.
	window := out
	if len(window) > trend.WindowDays {
		window = window[len(window)-trend.WindowDays:]
	}
	windowDays := make([]trend.Day, 0, len(window))
	for _, d := range window {
		windowDays = append(windowDays, trend.Day{Date: d.Date, Kcal: d.Kcal})
	}
	windowStart := window[0].Date
	windowSamples := make([]trend.Sample, 0, len(weights))
	for _, w := range weights {
		if w.Date >= windowStart {
			windowSamples = append(windowSamples, trend.Sample{Date: w.Date, KG: w.KG})
		}
	}
	est := trend.Compute(windowDays, windowSamples)

	// EMA spans the whole display range, not just the estimate window.
	allSamples := make([]trend.Sample, 0, len(weights))
	for _, w := range weights {
		allSamples = append(allSamples, trend.Sample{Date: w.Date, KG: w.KG})
	}
	emaPts := trend.EMA(calendar, allSamples, trend.EMAAlpha)
	ema := make([]emaJSON, 0, len(emaPts))
	for _, p := range emaPts {
		ema = append(ema, emaJSON{Date: p.Date, KG: p.KG, Interpolated: p.Interpolated})
	}

	profile, err := app.FindFirstRecordByFilter("profiles", "user = {:uid}", dbx.Params{"uid": uid})
	if err != nil {
		return nil, fmt.Errorf("no profile found")
	}

	budget, budgetErr := trendsBudget(app, uid, profile)
	goalRate := profile.GetFloat("goal_rate")

	estOut := estimateJSON{
		Sufficient:     est.Sufficient,
		Reason:         string(est.Reason),
		WindowDays:     est.WindowDays,
		ObservedTDEE:   est.ObservedTDEE,
		Margin:         est.Margin,
		SlopePerWeek:   est.SlopePerWeek,
		MeanIntake:     est.MeanIntake,
		QualifyingDays: est.QualifyingDays,
		WeighIns:       est.WeighIns,
		SpanDays:       est.SpanDays,
	}
	if est.Sufficient {
		// Same convention as tdee.Budget: goal_rate is negative for loss.
		estOut.SuggestedTarget = tdee.Round(est.ObservedTDEE + goalRate*trend.KcalPerKG/7)
	}

	slots, err := app.FindRecordsByFilter("meal_slots", "user = {:uid}", "sort_order", 0, 0, dbx.Params{"uid": uid})
	if err != nil {
		return nil, err
	}
	slotsOut := make([]trendSlotJSON, 0, len(slots))
	for _, s := range slots {
		slotsOut = append(slotsOut, trendSlotJSON{
			ID:            s.Id,
			Name:          s.GetString("name"),
			SortOrder:     s.GetFloat("sort_order"),
			PctAllocation: s.GetFloat("pct_allocation"),
		})
	}

	resp := map[string]any{
		"range":        map[string]any{"from": from, "to": to, "days": days},
		"days":         out,
		"weights":      weights,
		"ema":          ema,
		"budget":        budget,
		"formula_tdee":  formulaTDEE(app, uid, profile),
		"goal":          profile.GetString("goal"),
		"goal_rate":     goalRate,
		"target_source": profile.GetString("calorie_target_source"),
		"target_set_at": profile.GetString("calorie_target_set_at"),
		"targets":       trendTargets(profile, budget),
		"slots":        slotsOut,
		"estimate":     estOut,
	}
	if budgetErr != nil {
		resp["budget_message"] = budgetErr.Error()
	}
	return resp, nil
}

// calendarDays returns `n` consecutive YYYY-MM-DD dates starting at `from`.
func calendarDays(from string, n int) []string {
	t, err := time.Parse("2006-01-02", from)
	if err != nil {
		return nil
	}
	out := make([]string, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, t.AddDate(0, 0, i).Format("2006-01-02"))
	}
	return out
}

// dayKeyExpr buckets a stored datetime into a UTC calendar day.
//
// substr, not SQLite's date(): PocketBase stores "YYYY-MM-DD HH:MM:SS.SSSZ",
// and a space separator combined with a trailing Z is not one of the time
// formats SQLite's date() accepts. Slicing the first ten characters is exactly
// the bucketing /summary gets from its string range comparison.
const dayKeyExpr = "substr(logged_at, 1, 10)"

type dayAgg struct {
	Date    string  `db:"date"`
	Kcal    float64 `db:"kcal"`
	Protein float64 `db:"protein"`
	Carbs   float64 `db:"carbs"`
	Fat     float64 `db:"fat"`
	Entries int     `db:"entries"`
}

func queryDayTotals(app core.App, uid, start, end string) (map[string]dayAgg, error) {
	var rows []dayAgg
	err := app.DB().NewQuery(`
		SELECT ` + dayKeyExpr + ` AS date,
		       COALESCE(SUM(kcal), 0) AS kcal,
		       COALESCE(SUM(protein), 0) AS protein,
		       COALESCE(SUM(carbs), 0) AS carbs,
		       COALESCE(SUM(fat), 0) AS fat,
		       COUNT(*) AS entries
		FROM diary_entries
		WHERE user = {:uid} AND logged_at >= {:start} AND logged_at < {:end}
		GROUP BY ` + dayKeyExpr + `
	`).Bind(dbx.Params{"uid": uid, "start": start, "end": end}).All(&rows)
	if err != nil {
		return nil, err
	}
	out := make(map[string]dayAgg, len(rows))
	for _, r := range rows {
		out[r.Date] = r
	}
	return out, nil
}

type slotAgg struct {
	Date   string  `db:"date"`
	SlotID string  `db:"slot_id"`
	Kcal   float64 `db:"kcal"`
}

func querySlotTotals(app core.App, uid, start, end string) (map[string][]slotAgg, error) {
	var rows []slotAgg
	err := app.DB().NewQuery(`
		SELECT ` + dayKeyExpr + ` AS date,
		       meal_slot AS slot_id,
		       COALESCE(SUM(kcal), 0) AS kcal
		FROM diary_entries
		WHERE user = {:uid} AND logged_at >= {:start} AND logged_at < {:end}
		GROUP BY ` + dayKeyExpr + `, meal_slot
	`).Bind(dbx.Params{"uid": uid, "start": start, "end": end}).All(&rows)
	if err != nil {
		return nil, err
	}
	out := make(map[string][]slotAgg, len(rows))
	for _, r := range rows {
		out[r.Date] = append(out[r.Date], r)
	}
	return out, nil
}

type metricAgg struct {
	Date    string  `db:"date"`
	WaterML float64 `db:"water_ml"`
	Steps   float64 `db:"steps"`
}

func queryMetrics(app core.App, uid, start, end string) (map[string]metricAgg, error) {
	var rows []metricAgg
	err := app.DB().NewQuery(`
		SELECT substr(date, 1, 10) AS date,
		       COALESCE(SUM(water_ml), 0) AS water_ml,
		       COALESCE(SUM(steps), 0) AS steps
		FROM daily_metrics
		WHERE user = {:uid} AND date >= {:start} AND date < {:end}
		GROUP BY substr(date, 1, 10)
	`).Bind(dbx.Params{"uid": uid, "start": start, "end": end}).All(&rows)
	if err != nil {
		return nil, err
	}
	out := make(map[string]metricAgg, len(rows))
	for _, r := range rows {
		out[r.Date] = r
	}
	return out, nil
}

func queryWeights(app core.App, uid, start, end string) ([]weightJSON, error) {
	var rows []struct {
		Date string  `db:"date"`
		KG   float64 `db:"kg"`
	}
	err := app.DB().NewQuery(`
		SELECT substr(measured_at, 1, 10) AS date, kg
		FROM weights
		WHERE user = {:uid} AND kg > 0
		  AND measured_at >= {:start} AND measured_at < {:end}
		ORDER BY measured_at ASC
	`).Bind(dbx.Params{"uid": uid, "start": start, "end": end}).All(&rows)
	if err != nil {
		return nil, err
	}
	out := make([]weightJSON, 0, len(rows))
	for _, r := range rows {
		out = append(out, weightJSON{Date: r.Date, KG: r.KG})
	}
	return out, nil
}

// trendsBudget mirrors userBudget's resolution but takes an already-loaded
// profile. Returns nil when the data needed is missing, matching /summary.
func trendsBudget(app core.App, uid string, profile *core.Record) (any, error) {
	if target := profile.GetFloat("calorie_target"); target > 0 {
		return tdee.Round(target), nil
	}
	in, ok := formulaInput(app, uid, profile)
	if !ok {
		return nil, fmt.Errorf("weight and birth_year required to compute the budget")
	}
	return tdee.Round(tdee.Budget(in)), nil
}

// formulaTDEE is the pre-goal expenditure the suggestion card compares
// against. Returns nil when it cannot be computed.
func formulaTDEE(app core.App, uid string, profile *core.Record) any {
	in, ok := formulaInput(app, uid, profile)
	if !ok {
		return nil
	}
	// Goal "maintain" makes Budget return the unadjusted TDEE.
	in.Goal = "maintain"
	in.GoalRate = 0
	return tdee.Round(tdee.Budget(in))
}

func formulaInput(app core.App, uid string, profile *core.Record) (tdee.Input, bool) {
	recent, err := app.FindRecordsByFilter(
		"weights", "user = {:uid} && kg > 0", "-measured_at", 1, 0, dbx.Params{"uid": uid},
	)
	if err != nil || len(recent) == 0 {
		return tdee.Input{}, false
	}
	age := 0.0
	if by := profile.GetFloat("birth_year"); by > 0 {
		age = float64(time.Now().Year()) - by
	}
	if age <= 0 {
		return tdee.Input{}, false
	}
	return tdee.Input{
		Sex:           profile.GetString("sex"),
		HeightCM:      profile.GetFloat("height_cm"),
		AgeYears:      age,
		WeightKG:      recent[0].GetFloat("kg"),
		BodyFatPct:    profile.GetFloat("body_fat_pct"),
		Formula:       profile.GetString("tdee_formula"),
		ActivityLevel: profile.GetString("activity_level"),
		Goal:          profile.GetString("goal"),
		GoalRate:      profile.GetFloat("goal_rate"),
	}, true
}

// trendTargets derives per-day macro targets from the profile's percentage
// split against the current budget, so they move when the budget does.
func trendTargets(profile *core.Record, budget any) map[string]any {
	kcal, _ := budget.(float64)
	grams := func(pct, kcalPerGram float64) float64 {
		if kcal <= 0 || pct <= 0 {
			return 0
		}
		return tdee.Round(kcal * pct / 100 / kcalPerGram)
	}
	return map[string]any{
		"protein_g": grams(profile.GetFloat("protein_pct"), 4),
		"carbs_g":   grams(profile.GetFloat("carbs_pct"), 4),
		"fat_g":     grams(profile.GetFloat("fat_pct"), 9),
		"water_ml":  2000,
		"steps":     10000,
	}
}
```

- [ ] **Step 4: Register the route**

In `backend/internal/routes/summary.go`, add one line inside `Register`, after the existing `g.GET("/summary", summaryHandler)`:

```go
	g.GET("/trends", trendsHandler)
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd backend && gofmt -w internal/routes/trends.go && go test ./internal/routes/ -v
```

Expected: PASS, including the pre-existing route tests.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/routes/
git commit -m "feat(trends): /api/saolrian/trends aggregation endpoint"
```

---

### Task 5: Frontend types and API client

**Files:**
- Modify: `frontend/src/lib/types.ts` (append)
- Create: `frontend/src/lib/trends.ts`
- Test: `frontend/src/lib/trends.test.ts`

**Interfaces:**
- Consumes: the Task 4 payload contract.
- Produces: types `TrendDay`, `TrendWeight`, `TrendEma`, `TrendEstimate`, `TrendSlot`, `TrendsPayload`, `CardId`; values `ALL_CARDS: CardMeta[]`, `DEFAULT_CARDS: CardId[]`, `resolveCards(raw: unknown): CardId[]`, `fetchTrends(pb, days): Promise<TrendsPayload>`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/trends.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ALL_CARDS, DEFAULT_CARDS, resolveCards } from './trends';

describe('resolveCards', () => {
  it('falls back to defaults when the profile has never been set', () => {
    expect(resolveCards(null)).toEqual(DEFAULT_CARDS);
    expect(resolveCards(undefined)).toEqual(DEFAULT_CARDS);
  });

  it('falls back to defaults for a non-array value', () => {
    expect(resolveCards('weight')).toEqual(DEFAULT_CARDS);
    expect(resolveCards({ weight: true })).toEqual(DEFAULT_CARDS);
  });

  it('treats an explicitly empty array as "all cards off"', () => {
    // Distinct from "never set" — the user turned everything off on purpose.
    expect(resolveCards([])).toEqual([]);
  });

  it('preserves the stored order', () => {
    expect(resolveCards(['intake', 'weight'])).toEqual(['intake', 'weight']);
  });

  it('drops ids it does not recognise', () => {
    // A profile written by a newer build must degrade quietly on an older one.
    expect(resolveCards(['weight', 'nonsense', 'intake'])).toEqual(['weight', 'intake']);
  });

  it('drops duplicates, keeping the first position', () => {
    expect(resolveCards(['weight', 'intake', 'weight'])).toEqual(['weight', 'intake']);
  });
});

describe('ALL_CARDS', () => {
  it('has a unique id for every card', () => {
    const ids = ALL_CARDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('defaults are all real cards', () => {
    const ids = new Set(ALL_CARDS.map((c) => c.id));
    for (const id of DEFAULT_CARDS) expect(ids.has(id)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd frontend && npx vitest run src/lib/trends.test.ts
```

Expected: FAIL — cannot resolve `./trends`.

- [ ] **Step 3: Add the types**

Append to `frontend/src/lib/types.ts`:

```ts
export interface TrendDay {
  date: string;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  entries: number;
  /** The user recorded something this day. Distinct from "ate zero calories". */
  logged: boolean;
  water_ml: number;
  steps: number;
  by_slot: Record<string, number>;
}

export interface TrendWeight {
  date: string;
  kg: number;
}

export interface TrendEma {
  date: string;
  kg: number;
  /** Carried forward from the previous day; not a measurement. */
  interpolated: boolean;
}

export interface TrendEstimate {
  sufficient: boolean;
  reason: string;
  window_days: number;
  observed_tdee: number;
  margin: number;
  slope_kg_per_week: number;
  mean_intake: number;
  /** Days whose kcal cleared the qualifying floor — not the same as `logged`. */
  qualifying_days: number;
  weigh_ins: number;
  span_days: number;
  suggested_target: number;
}

export interface TrendSlot {
  id: string;
  name: string;
  sort_order: number;
  pct_allocation: number;
}

export interface TrendsPayload {
  range: { from: string; to: string; days: number };
  days: TrendDay[];
  weights: TrendWeight[];
  ema: TrendEma[];
  budget: number | null;
  budget_message?: string;
  formula_tdee: number | null;
  goal: string;
  goal_rate: number;
  /** '' | 'manual' | 'observed' — where the current calorie_target came from. */
  target_source: string;
  /** When it was set; '' when never. */
  target_set_at: string;
  targets: { protein_g: number; carbs_g: number; fat_g: number; water_ml: number; steps: number };
  slots: TrendSlot[];
  estimate: TrendEstimate;
}
```

- [ ] **Step 4: Write the card registry**

Create `frontend/src/lib/trends.ts`:

```ts
import type PocketBase from 'pocketbase';
import { saolrianSend } from './pb';
import type { TrendsPayload } from './types';

export type CardId =
  | 'weight'
  | 'tdee'
  | 'intake'
  | 'balance'
  | 'consistency'
  | 'macros'
  | 'weekday'
  | 'meals'
  | 'water'
  | 'steps';

export interface CardMeta {
  id: CardId;
  title: string;
  /** One line describing what the card answers, shown in the customise sheet. */
  blurb: string;
  /** Days of range needed before the card renders instead of a stub. */
  minDays: number;
}

export const ALL_CARDS: CardMeta[] = [
  { id: 'weight', title: 'Weight trend', blurb: 'Weigh-ins, smoothed line, and the fitted rate', minDays: 7 },
  { id: 'tdee', title: 'Observed TDEE', blurb: 'What your own data says you burn', minDays: 14 },
  { id: 'intake', title: 'Intake vs budget', blurb: 'Daily calories against your target', minDays: 7 },
  { id: 'balance', title: 'Energy balance', blurb: 'Cumulative deficit or surplus, and what it predicts', minDays: 14 },
  { id: 'consistency', title: 'Logging consistency', blurb: 'Which days you logged', minDays: 7 },
  { id: 'macros', title: 'Macros', blurb: 'Protein, carbs and fat against your split', minDays: 7 },
  { id: 'weekday', title: 'Weekday pattern', blurb: 'Average intake by day of the week', minDays: 21 },
  { id: 'meals', title: 'Meal distribution', blurb: 'How your calories spread across meals', minDays: 7 },
  { id: 'water', title: 'Water', blurb: 'Daily water against your target', minDays: 7 },
  { id: 'steps', title: 'Steps', blurb: 'Daily steps and a rolling average', minDays: 7 },
];

/** Five on by default. A new user should not land on ten charts. */
export const DEFAULT_CARDS: CardId[] = ['weight', 'tdee', 'intake', 'balance', 'consistency'];

const KNOWN = new Set<string>(ALL_CARDS.map((c) => c.id));

/** Resolve the profile's stored `trend_cards` into an ordered card list.
 *
 * Null or absent means "never set" and yields the defaults, which is what
 * makes every pre-existing profile correct with no backfill. An explicitly
 * empty array is different: the user turned everything off, and we honour it.
 * Unknown ids are dropped rather than throwing, so a profile written by a
 * newer build degrades quietly on an older one. */
export function resolveCards(raw: unknown): CardId[] {
  if (!Array.isArray(raw)) return [...DEFAULT_CARDS];
  const seen = new Set<string>();
  const out: CardId[] = [];
  for (const v of raw) {
    if (typeof v !== 'string' || !KNOWN.has(v) || seen.has(v)) continue;
    seen.add(v);
    out.push(v as CardId);
  }
  return out;
}

export async function fetchTrends(pb: PocketBase, days: number): Promise<TrendsPayload> {
  return saolrianSend<TrendsPayload>(pb, 'GET', `/api/saolrian/trends?days=${days}`);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd frontend && npx vitest run src/lib/trends.test.ts && npx tsc --noEmit
```

Expected: PASS, and no type errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/types.ts frontend/src/lib/trends.ts frontend/src/lib/trends.test.ts
git commit -m "feat(trends): payload types, card registry and client"
```

---

### Task 6: Chart scale helpers and LineChart

**Files:**
- Create: `frontend/src/components/ui/charts/scale.ts`
- Create: `frontend/src/components/ui/charts/LineChart.tsx`
- Test: `frontend/src/components/ui/charts/scale.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `VB` (viewBox constants `{ W: 320, H: 140 }`), `niceBounds(values: number[]): {min: number; max: number}`, `scaleY(v, min, max, top, bottom): number`, `scaleX(i, n, left, right): number`, `linePath(pts: {x: number; y: number}[]): string`; component `LineChart`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/components/ui/charts/scale.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { niceBounds, scaleX, scaleY, linePath } from './scale';

describe('niceBounds', () => {
  it('pads a normal range so the line does not touch the frame', () => {
    const { min, max } = niceBounds([80, 84]);
    expect(min).toBeLessThan(80);
    expect(max).toBeGreaterThan(84);
  });

  it('gives a flat series a non-zero span so scaleY cannot divide by zero', () => {
    const { min, max } = niceBounds([80, 80, 80]);
    expect(max).toBeGreaterThan(min);
  });

  it('handles an empty series without producing NaN', () => {
    const { min, max } = niceBounds([]);
    expect(Number.isFinite(min)).toBe(true);
    expect(Number.isFinite(max)).toBe(true);
    expect(max).toBeGreaterThan(min);
  });
});

describe('scaleY', () => {
  it('maps the maximum to the top and the minimum to the bottom', () => {
    // SVG y grows downward, so the max must produce the smaller number.
    expect(scaleY(10, 0, 10, 0, 100)).toBeCloseTo(0);
    expect(scaleY(0, 0, 10, 0, 100)).toBeCloseTo(100);
    expect(scaleY(5, 0, 10, 0, 100)).toBeCloseTo(50);
  });

  it('returns the midpoint rather than NaN for a zero span', () => {
    expect(scaleY(5, 5, 5, 0, 100)).toBeCloseTo(50);
  });
});

describe('scaleX', () => {
  it('spreads points across the full width', () => {
    expect(scaleX(0, 5, 0, 100)).toBeCloseTo(0);
    expect(scaleX(4, 5, 0, 100)).toBeCloseTo(100);
  });

  it('centres a single point', () => {
    expect(scaleX(0, 1, 0, 100)).toBeCloseTo(50);
  });
});

describe('linePath', () => {
  it('builds an SVG path', () => {
    expect(linePath([{ x: 0, y: 0 }, { x: 10, y: 5 }])).toBe('M0 0 L10 5');
  });

  it('returns an empty string for no points', () => {
    expect(linePath([])).toBe('');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd frontend && npx vitest run src/components/ui/charts/scale.test.ts
```

Expected: FAIL — cannot resolve `./scale`.

- [ ] **Step 3: Write the scale helpers**

Create `frontend/src/components/ui/charts/scale.ts`:

```ts
/** Shared geometry for the hand-rolled SVG charts.
 *
 * Charts are drawn in a fixed viewBox and scaled by CSS, so they are
 * responsive without measuring the DOM. Colour never appears here — every
 * chart paints with `currentColor` and the Tailwind token variables, which is
 * how accent switching and dark mode work with no per-chart code. */

export const VB = { W: 320, H: 140 } as const;

/** Inset so strokes and labels are not clipped by the viewBox edge. */
export const PAD = { top: 8, right: 4, bottom: 18, left: 30 } as const;

export interface Bounds {
  min: number;
  max: number;
}

/** Pad a data range by 5% so the line never touches the frame, and guarantee a
 * non-zero span so scaleY cannot divide by zero on a flat or empty series. */
export function niceBounds(values: number[]): Bounds {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return { min: 0, max: 1 };

  let min = Math.min(...finite);
  let max = Math.max(...finite);

  if (min === max) {
    const bump = Math.abs(min) * 0.05 || 1;
    return { min: min - bump, max: max + bump };
  }

  const pad = (max - min) * 0.05;
  min -= pad;
  max += pad;
  return { min, max };
}

/** Map a value to a y coordinate. SVG y grows downward, so the maximum maps to
 * `top` and the minimum to `bottom`. */
export function scaleY(v: number, min: number, max: number, top: number, bottom: number): number {
  const span = max - min;
  if (span === 0) return (top + bottom) / 2;
  return bottom - ((v - min) / span) * (bottom - top);
}

/** Map index `i` of `n` points to an x coordinate. A lone point is centred
 * rather than pinned to the left edge. */
export function scaleX(i: number, n: number, left: number, right: number): number {
  if (n <= 1) return (left + right) / 2;
  return left + (i / (n - 1)) * (right - left);
}

export function linePath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return '';
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ');
}
```

- [ ] **Step 4: Write LineChart**

Create `frontend/src/components/ui/charts/LineChart.tsx`:

```tsx
import { VB, PAD, niceBounds, scaleX, scaleY, linePath } from './scale';

export interface LineSeries {
  /** One value per x position; null leaves a gap rather than drawing zero. */
  values: (number | null)[];
  /** 'accent' follows the user's accent colour; 'muted' is the faint variant. */
  tone?: 'accent' | 'muted';
  dashed?: boolean;
  /** Draw a dot at each non-null value — used for raw weigh-ins. */
  dots?: boolean;
}

/** A minimal multi-series line chart.
 *
 * Every series shares one y scale, which is what lets the weight card overlay
 * the raw weigh-ins, the EMA line and the fitted regression segment and have
 * them line up. */
export function LineChart({
  series,
  labels,
  zeroLine = false,
  ariaLabel,
}: {
  series: LineSeries[];
  /** Sparse x labels, e.g. ['Jun', '', '', 'Jul', ...]. */
  labels?: string[];
  /** Draw a baseline at y=0 — used by the cumulative energy-balance card. */
  zeroLine?: boolean;
  ariaLabel: string;
}) {
  const all = series.flatMap((s) => s.values.filter((v): v is number => v != null));
  const bounds = niceBounds(zeroLine ? [...all, 0] : all);
  const n = Math.max(...series.map((s) => s.values.length), 1);
  const right = VB.W - PAD.right;
  const bottom = VB.H - PAD.bottom;

  const y = (v: number) => scaleY(v, bounds.min, bounds.max, PAD.top, bottom);

  return (
    <svg
      viewBox={`0 0 ${VB.W} ${VB.H}`}
      className="h-auto w-full"
      role="img"
      aria-label={ariaLabel}
      preserveAspectRatio="none"
    >
      {/* axis frame */}
      <line x1={PAD.left} y1={bottom} x2={right} y2={bottom} className="stroke-border" strokeWidth={1} />
      {zeroLine && bounds.min < 0 && bounds.max > 0 && (
        <line x1={PAD.left} y1={y(0)} x2={right} y2={y(0)} className="stroke-border" strokeWidth={1} strokeDasharray="3 3" />
      )}

      {/* y bounds as text, cheaper and clearer than a full axis */}
      <text x={2} y={PAD.top + 8} className="fill-text-faint text-[9px]">{Math.round(bounds.max)}</text>
      <text x={2} y={bottom} className="fill-text-faint text-[9px]">{Math.round(bounds.min)}</text>

      {series.map((s, si) => {
        // Split on nulls so a gap is a gap, not a straight line through it.
        const segments: { x: number; y: number }[][] = [];
        let current: { x: number; y: number }[] = [];
        s.values.forEach((v, i) => {
          if (v == null) {
            if (current.length) segments.push(current);
            current = [];
            return;
          }
          current.push({ x: scaleX(i, n, PAD.left, right), y: y(v) });
        });
        if (current.length) segments.push(current);

        const stroke = s.tone === 'muted' ? 'stroke-text-faint' : 'stroke-accent';
        return (
          <g key={si}>
            {segments.map((seg, gi) => (
              <path
                key={gi}
                d={linePath(seg)}
                fill="none"
                className={stroke}
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray={s.dashed ? '4 3' : undefined}
              />
            ))}
            {s.dots &&
              segments.flat().map((p, pi) => (
                <circle key={pi} cx={p.x} cy={p.y} r={1.8} className={s.tone === 'muted' ? 'fill-text-faint' : 'fill-accent'} />
              ))}
          </g>
        );
      })}

      {labels?.map((l, i) =>
        l ? (
          <text
            key={i}
            x={scaleX(i, n, PAD.left, right)}
            y={VB.H - 4}
            textAnchor="middle"
            className="fill-text-faint text-[9px]"
          >
            {l}
          </text>
        ) : null,
      )}
    </svg>
  );
}
```

- [ ] **Step 5: Run the tests and typecheck**

```bash
cd frontend && npx vitest run src/components/ui/charts/scale.test.ts && npx tsc --noEmit
```

Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/ui/charts/
git commit -m "feat(charts): SVG scale helpers and LineChart primitive"
```

---

### Task 7: BarChart, Heatmap and StackedBar

**Files:**
- Create: `frontend/src/components/ui/charts/BarChart.tsx`
- Create: `frontend/src/components/ui/charts/Heatmap.tsx`
- Create: `frontend/src/components/ui/charts/StackedBar.tsx`
- Modify: `frontend/src/components/ui/index.ts`
- Test: `frontend/src/components/ui/__tests__/charts.test.tsx`

**Interfaces:**
- Consumes: `VB`, `PAD`, `niceBounds`, `scaleX`, `scaleY` from Task 6.
- Produces: `BarChart({ values, labels, target, ariaLabel })`, `Heatmap({ cells, ariaLabel })` where `cells: { date: string; level: 0|1|2|3 }[]`, `StackedBar({ rows, ariaLabel })` where `rows: { label: string; parts: { label: string; value: number }[] }[]`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/components/ui/__tests__/charts.test.tsx`:

```tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { BarChart } from '../charts/BarChart';
import { Heatmap } from '../charts/Heatmap';
import { StackedBar } from '../charts/StackedBar';

afterEach(cleanup);

describe('BarChart', () => {
  it('renders one bar per value', () => {
    const { container } = render(<BarChart values={[1, 2, 3]} ariaLabel="Test" />);
    expect(container.querySelectorAll('rect[data-bar]')).toHaveLength(3);
  });

  it('omits a bar for a null value rather than drawing zero', () => {
    const { container } = render(<BarChart values={[1, null, 3]} ariaLabel="Test" />);
    expect(container.querySelectorAll('rect[data-bar]')).toHaveLength(2);
  });

  it('draws a target line when given one', () => {
    const { container } = render(<BarChart values={[1, 2]} target={1.5} ariaLabel="Test" />);
    expect(container.querySelector('line[data-target]')).not.toBeNull();
  });

  it('is labelled for screen readers', () => {
    render(<BarChart values={[1]} ariaLabel="Intake vs budget" />);
    expect(screen.getByRole('img', { name: 'Intake vs budget' })).toBeTruthy();
  });

  it('survives an empty series', () => {
    const { container } = render(<BarChart values={[]} ariaLabel="Test" />);
    expect(container.querySelectorAll('rect[data-bar]')).toHaveLength(0);
  });
});

describe('Heatmap', () => {
  it('renders one cell per day', () => {
    const cells = [
      { date: '2026-01-01', level: 0 as const },
      { date: '2026-01-02', level: 3 as const },
    ];
    const { container } = render(<Heatmap cells={cells} ariaLabel="Consistency" />);
    expect(container.querySelectorAll('rect[data-cell]')).toHaveLength(2);
  });
});

describe('StackedBar', () => {
  it('renders a segment per part', () => {
    const rows = [{ label: 'Mon', parts: [{ label: 'Breakfast', value: 300 }, { label: 'Lunch', value: 700 }] }];
    const { container } = render(<StackedBar rows={rows} ariaLabel="Meals" />);
    expect(container.querySelectorAll('rect[data-part]')).toHaveLength(2);
  });

  it('ignores a row whose parts sum to zero without dividing by zero', () => {
    const rows = [{ label: 'Mon', parts: [{ label: 'Breakfast', value: 0 }] }];
    const { container } = render(<StackedBar rows={rows} ariaLabel="Meals" />);
    expect(container.querySelectorAll('rect[data-part]')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd frontend && npx vitest run src/components/ui/__tests__/charts.test.tsx
```

Expected: FAIL — cannot resolve `../charts/BarChart`.

- [ ] **Step 3: Write BarChart**

Create `frontend/src/components/ui/charts/BarChart.tsx`:

```tsx
import { VB, PAD, niceBounds, scaleY } from './scale';

/** Daily bars with an optional target line.
 *
 * A null value draws nothing at all — the distinction between "did not log"
 * and "logged zero calories" is the whole point of the zero-filled payload and
 * must survive into the chart. */
export function BarChart({
  values,
  labels,
  target,
  ariaLabel,
}: {
  values: (number | null)[];
  labels?: string[];
  target?: number | null;
  ariaLabel: string;
}) {
  const present = values.filter((v): v is number => v != null);
  const bounds = niceBounds(target != null ? [0, ...present, target] : [0, ...present]);
  const right = VB.W - PAD.right;
  const bottom = VB.H - PAD.bottom;
  const inner = right - PAD.left;
  const slot = values.length > 0 ? inner / values.length : inner;
  const barW = Math.max(1, slot * 0.7);

  const y = (v: number) => scaleY(v, bounds.min, bounds.max, PAD.top, bottom);
  const zeroY = y(Math.max(bounds.min, 0));

  return (
    <svg viewBox={`0 0 ${VB.W} ${VB.H}`} className="h-auto w-full" role="img" aria-label={ariaLabel} preserveAspectRatio="none">
      <line x1={PAD.left} y1={bottom} x2={right} y2={bottom} className="stroke-border" strokeWidth={1} />
      <text x={2} y={PAD.top + 8} className="fill-text-faint text-[9px]">{Math.round(bounds.max)}</text>

      {values.map((v, i) => {
        if (v == null) return null;
        const top = y(v);
        return (
          <rect
            key={i}
            data-bar
            x={PAD.left + i * slot + (slot - barW) / 2}
            y={Math.min(top, zeroY)}
            width={barW}
            height={Math.max(1, Math.abs(zeroY - top))}
            rx={1}
            className="fill-accent"
            opacity={0.85}
          />
        );
      })}

      {target != null && (
        <line
          data-target
          x1={PAD.left}
          y1={y(target)}
          x2={right}
          y2={y(target)}
          className="stroke-text-faint"
          strokeWidth={1.2}
          strokeDasharray="4 3"
        />
      )}

      {labels?.map((l, i) =>
        l ? (
          <text key={i} x={PAD.left + i * slot + slot / 2} y={VB.H - 4} textAnchor="middle" className="fill-text-faint text-[9px]">
            {l}
          </text>
        ) : null,
      )}
    </svg>
  );
}
```

- [ ] **Step 4: Write Heatmap**

Create `frontend/src/components/ui/charts/Heatmap.tsx`:

```tsx
/** Calendar heatmap of logging consistency, laid out in week columns.
 *
 * Level 0 is "nothing logged" and renders as an empty cell, so a gap in the
 * grid reads as a gap in the data — the same honesty rule the charts follow. */
export function Heatmap({
  cells,
  ariaLabel,
}: {
  cells: { date: string; level: 0 | 1 | 2 | 3 }[];
  ariaLabel: string;
}) {
  const CELL = 11;
  const GAP = 2;
  const rows = 7;
  const cols = Math.ceil(cells.length / rows) || 1;
  const w = cols * (CELL + GAP);
  const h = rows * (CELL + GAP);

  const fill = ['fill-surface', 'fill-accent', 'fill-accent', 'fill-accent'] as const;
  const opacity = [1, 0.35, 0.65, 1] as const;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-auto w-full" role="img" aria-label={ariaLabel}>
      {cells.map((c, i) => (
        <rect
          key={c.date}
          data-cell
          x={Math.floor(i / rows) * (CELL + GAP)}
          y={(i % rows) * (CELL + GAP)}
          width={CELL}
          height={CELL}
          rx={2}
          className={fill[c.level]}
          opacity={opacity[c.level]}
          stroke="currentColor"
          strokeOpacity={0.08}
        >
          <title>{c.date}</title>
        </rect>
      ))}
    </svg>
  );
}
```

- [ ] **Step 5: Write StackedBar**

Create `frontend/src/components/ui/charts/StackedBar.tsx`:

```tsx
/** Horizontal 100%-stacked bars, one row per group.
 *
 * Used for meal distribution, where the question is "what share of the day
 * went where", not "how many calories" — so every row normalises to full
 * width. A row summing to zero renders nothing rather than dividing by zero. */
export function StackedBar({
  rows,
  ariaLabel,
}: {
  rows: { label: string; parts: { label: string; value: number }[] }[];
  ariaLabel: string;
}) {
  const ROW_H = 18;
  const GAP = 6;
  const LABEL_W = 64;
  const W = 320;
  const H = Math.max(1, rows.length * (ROW_H + GAP));
  const barW = W - LABEL_W;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={ariaLabel}>
      {rows.map((row, ri) => {
        const total = row.parts.reduce((s, p) => s + p.value, 0);
        const y = ri * (ROW_H + GAP);
        let x = LABEL_W;
        return (
          <g key={row.label}>
            <text x={0} y={y + ROW_H * 0.72} className="fill-text-faint text-[10px]">
              {row.label}
            </text>
            {total > 0 &&
              row.parts.map((p, pi) => {
                const w = (p.value / total) * barW;
                const rect = (
                  <rect
                    key={p.label}
                    data-part
                    x={x}
                    y={y}
                    width={Math.max(0, w)}
                    height={ROW_H}
                    className="fill-accent"
                    opacity={0.3 + (0.7 * (pi + 1)) / row.parts.length}
                  >
                    <title>{`${p.label}: ${Math.round(p.value)} kcal`}</title>
                  </rect>
                );
                x += w;
                return rect;
              })}
          </g>
        );
      })}
    </svg>
  );
}
```

- [ ] **Step 6: Export the primitives**

Append to `frontend/src/components/ui/index.ts`:

```ts
export { LineChart } from './charts/LineChart';
export { BarChart } from './charts/BarChart';
export { Heatmap } from './charts/Heatmap';
export { StackedBar } from './charts/StackedBar';
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cd frontend && npx vitest run src/components/ui/__tests__/charts.test.tsx && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/ui/
git commit -m "feat(charts): BarChart, Heatmap and StackedBar primitives"
```

---

### Task 8: Card series transforms

**Files:**
- Modify: `frontend/src/lib/trends.ts` (append)
- Modify: `frontend/src/lib/trends.test.ts` (append)

**Interfaces:**
- Consumes: `TrendsPayload`, `TrendDay` from Task 5.
- Produces: `intakeSeries(p)`, `balanceSeries(p)`, `consistencyCells(p)`, `weekdayAverages(p)`, `mealRows(p)`, `sparseLabels(dates)`, `movingAverage(values, window)`, `regressionOverlay(p)`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/trends.test.ts`:

```ts
import {
  intakeSeries,
  balanceSeries,
  consistencyCells,
  weekdayAverages,
  movingAverage,
  sparseLabels,
} from './trends';
import type { TrendsPayload, TrendDay } from './types';

function day(date: string, kcal: number, logged = kcal > 0): TrendDay {
  return {
    date, kcal, protein: 0, carbs: 0, fat: 0,
    entries: logged ? 1 : 0, logged, water_ml: 0, steps: 0, by_slot: {},
  };
}

function payload(days: TrendDay[], over: Partial<TrendsPayload> = {}): TrendsPayload {
  return {
    range: { from: days[0]?.date ?? '2026-01-01', to: days.at(-1)?.date ?? '2026-01-01', days: days.length },
    days, weights: [], ema: [], budget: 2000, formula_tdee: 2200,
    goal: 'lose', goal_rate: -0.5, target_source: '', target_set_at: '',
    targets: { protein_g: 150, carbs_g: 200, fat_g: 60, water_ml: 2000, steps: 10000 },
    slots: [],
    estimate: {
      sufficient: false, reason: 'no_data', window_days: 28, observed_tdee: 0,
      margin: 0, slope_kg_per_week: 0, mean_intake: 0, qualifying_days: 0,
      weigh_ins: 0, span_days: 0, suggested_target: 0,
    },
    ...over,
  };
}

describe('intakeSeries', () => {
  it('gives an unlogged day null, not zero', () => {
    const p = payload([day('2026-01-01', 2000), day('2026-01-02', 0, false)]);
    expect(intakeSeries(p).values).toEqual([2000, null]);
  });
});

describe('movingAverage', () => {
  it('averages only the non-null values in the window', () => {
    expect(movingAverage([2, null, 4], 3)?.at(-1)).toBeCloseTo(3);
  });

  it('is null until the window has any data', () => {
    expect(movingAverage([null, null], 2)).toEqual([null, null]);
  });
});

describe('balanceSeries', () => {
  it('accumulates intake minus TDEE across logged days only', () => {
    const p = payload(
      [day('2026-01-01', 1500), day('2026-01-02', 0, false), day('2026-01-03', 1500)],
      {
        estimate: {
          sufficient: true, reason: '', window_days: 28, observed_tdee: 2000,
          margin: 100, slope_kg_per_week: -0.5, mean_intake: 1500,
          qualifying_days: 2, weigh_ins: 10, span_days: 25, suggested_target: 1450,
        },
      },
    );
    const s = balanceSeries(p);
    // -500 on day 1, unchanged across the unlogged day, -1000 by day 3.
    expect(s.values[0]).toBeCloseTo(-500);
    expect(s.values[1]).toBeCloseTo(-500);
    expect(s.values[2]).toBeCloseTo(-1000);
    expect(s.predictedKg).toBeCloseTo(-1000 / 7700);
    expect(s.reference).toBe('observed');
  });

  it('falls back to the formula TDEE when the estimate is insufficient', () => {
    const p = payload([day('2026-01-01', 1500)]);
    expect(balanceSeries(p).reference).toBe('formula');
  });
});

describe('consistencyCells', () => {
  it('grades a day by how much of the budget was logged', () => {
    const p = payload([day('2026-01-01', 0, false), day('2026-01-02', 500), day('2026-01-03', 1900)]);
    expect(consistencyCells(p).map((c) => c.level)).toEqual([0, 1, 3]);
  });
});

describe('weekdayAverages', () => {
  it('averages by day of week over logged days only', () => {
    // 2026-01-01 is a Thursday.
    const p = payload([
      day('2026-01-01', 2000), day('2026-01-08', 3000),
      day('2026-01-02', 1000), day('2026-01-09', 0, false),
    ]);
    const avgs = weekdayAverages(p);
    expect(avgs[4]).toBeCloseTo(2500); // Thursday
    expect(avgs[5]).toBeCloseTo(1000); // Friday, ignoring the unlogged day
  });
});

describe('sparseLabels', () => {
  it('labels roughly six positions and blanks the rest', () => {
    const dates = Array.from({ length: 30 }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`);
    const labels = sparseLabels(dates);
    expect(labels).toHaveLength(30);
    expect(labels.filter(Boolean).length).toBeLessThanOrEqual(7);
    expect(labels[0]).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd frontend && npx vitest run src/lib/trends.test.ts
```

Expected: FAIL — `intakeSeries` is not exported.

- [ ] **Step 3: Write the transforms**

Append to `frontend/src/lib/trends.ts`:

```ts
import type { TrendDay } from './types';

const KCAL_PER_KG = 7700;

/** Daily intake, with unlogged days as null so charts leave a gap instead of
 * drawing a zero the user never ate. */
export function intakeSeries(p: TrendsPayload): { values: (number | null)[]; budget: number | null } {
  return {
    values: p.days.map((d) => (d.logged ? d.kcal : null)),
    budget: p.budget,
  };
}

/** Trailing mean over `window` positions, ignoring nulls. Null until the
 * window contains at least one value. */
export function movingAverage(values: (number | null)[], window: number): (number | null)[] {
  return values.map((_, i) => {
    const slice = values.slice(Math.max(0, i - window + 1), i + 1).filter((v): v is number => v != null);
    if (slice.length === 0) return null;
    return slice.reduce((s, v) => s + v, 0) / slice.length;
  });
}

/** Cumulative energy balance: Σ(intake − TDEE) over logged days.
 *
 * Unlogged days hold the running total flat rather than assuming a deficit —
 * we have no idea what happened on those days, and inventing one would make
 * the reconciliation against actual weight change meaningless. */
export function balanceSeries(p: TrendsPayload): {
  values: number[];
  predictedKg: number;
  reference: 'observed' | 'formula';
  referenceTdee: number;
} {
  const useObserved = p.estimate.sufficient;
  const tdeeRef = useObserved ? p.estimate.observed_tdee : (p.formula_tdee ?? 0);

  let running = 0;
  const values = p.days.map((d) => {
    if (d.logged && tdeeRef > 0) running += d.kcal - tdeeRef;
    return running;
  });

  return {
    values,
    predictedKg: running / KCAL_PER_KG,
    reference: useObserved ? 'observed' : 'formula',
    referenceTdee: tdeeRef,
  };
}

/** Grade each day 0-3 by how much of the budget was logged, for the heatmap.
 * Level 0 is "nothing logged", which renders as an empty cell. */
export function consistencyCells(p: TrendsPayload): { date: string; level: 0 | 1 | 2 | 3 }[] {
  const budget = p.budget ?? 2000;
  return p.days.map((d) => {
    if (!d.logged) return { date: d.date, level: 0 as const };
    const frac = d.kcal / budget;
    if (frac < 0.35) return { date: d.date, level: 1 as const };
    if (frac < 0.75) return { date: d.date, level: 2 as const };
    return { date: d.date, level: 3 as const };
  });
}

/** Mean intake per weekday, index 0 = Sunday. Unlogged days are excluded, so a
 * skipped Sunday does not read as a 0 kcal Sunday. NaN-free: a weekday with no
 * logged days returns 0 and the card renders it as absent. */
export function weekdayAverages(p: TrendsPayload): number[] {
  const sums = new Array(7).fill(0);
  const counts = new Array(7).fill(0);
  for (const d of p.days) {
    if (!d.logged) continue;
    // Parse as UTC to match the payload's bucketing.
    const idx = new Date(`${d.date}T00:00:00Z`).getUTCDay();
    sums[idx] += d.kcal;
    counts[idx] += 1;
  }
  return sums.map((s, i) => (counts[i] > 0 ? s / counts[i] : 0));
}

/** Average kcal per meal slot across the range, as StackedBar rows. */
export function mealRows(p: TrendsPayload): { label: string; parts: { label: string; value: number }[] }[] {
  const totals = new Map<string, number>();
  let loggedDays = 0;
  for (const d of p.days) {
    if (!d.logged) continue;
    loggedDays += 1;
    for (const [slotId, kcal] of Object.entries(d.by_slot)) {
      totals.set(slotId, (totals.get(slotId) ?? 0) + kcal);
    }
  }
  if (loggedDays === 0) return [];

  const parts = p.slots.map((s) => ({
    label: s.name,
    value: (totals.get(s.id) ?? 0) / loggedDays,
  }));
  return [{ label: 'Average day', parts }];
}

/** Label roughly six evenly spaced positions and blank the rest, so the axis
 * stays readable at 30, 90 and 365 days without measuring text. */
export function sparseLabels(dates: string[]): string[] {
  if (dates.length === 0) return [];
  const step = Math.max(1, Math.ceil(dates.length / 6));
  return dates.map((d, i) => (i % step === 0 ? d.slice(5) : ''));
}

/** The fitted regression line across the estimate window, as a series aligned
 * to the full day range — the visual proof of where the TDEE number came from.
 * Null outside the window so the line is drawn only where it applies. */
export function regressionOverlay(p: TrendsPayload): (number | null)[] {
  if (!p.estimate.sufficient || p.ema.length === 0) return p.days.map(() => null);

  const windowStart = Math.max(0, p.days.length - p.estimate.window_days);
  const slopePerDay = p.estimate.slope_kg_per_week / 7;

  // Anchor the line at the EMA value on the window's first day, so the overlay
  // sits on the trend rather than floating away from it.
  const startDate = p.days[windowStart]?.date;
  const anchor = p.ema.find((e) => e.date === startDate)?.kg ?? p.ema[0].kg;

  return p.days.map((_, i) => (i < windowStart ? null : anchor + slopePerDay * (i - windowStart)));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd frontend && npx vitest run src/lib/trends.test.ts && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/trends.ts frontend/src/lib/trends.test.ts
git commit -m "feat(trends): per-card series transforms"
```

---

### Task 9: Trends screen shell, route and tab

**Files:**
- Create: `frontend/src/screens/Trends.tsx`
- Modify: `frontend/src/main.tsx`
- Modify: `frontend/src/components/AppShell.tsx`
- Test: `frontend/src/screens/__tests__/Trends.test.tsx`

**Interfaces:**
- Consumes: `fetchTrends`, `resolveCards`, `ALL_CARDS`, `DEFAULT_CARDS`, `CardId` from Task 5.
- Produces: default-exported `Trends` component at route `/trends`; renders a `Segmented` range control (30/90/365), a `Spinner` while loading, and one section per enabled card. Card bodies arrive in Tasks 10-11; this task renders a titled `Card` per enabled id with a stub body.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/screens/__tests__/Trends.test.tsx`:

```tsx
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Trends from '../Trends';
import { AppProvider } from '../../state/AppContext';
import type { TrendsPayload } from '../../lib/types';

const authRecord = { id: 'user-1' };

function makePayload(nDays: number): TrendsPayload {
  const days = Array.from({ length: nDays }, (_, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, '0')}`,
    kcal: 2000, protein: 150, carbs: 200, fat: 60,
    entries: 3, logged: true, water_ml: 1500, steps: 8000, by_slot: {},
  }));
  return {
    range: { from: days[0].date, to: days.at(-1)!.date, days: nDays },
    days, weights: [], ema: [], budget: 2000, formula_tdee: 2200,
    goal: 'lose', goal_rate: -0.5, target_source: '', target_set_at: '',
    targets: { protein_g: 150, carbs_g: 200, fat_g: 60, water_ml: 2000, steps: 10000 },
    slots: [],
    estimate: {
      sufficient: false, reason: 'few_weigh_ins', window_days: 28, observed_tdee: 0,
      margin: 0, slope_kg_per_week: 0, mean_intake: 0, qualifying_days: nDays,
      weigh_ins: 0, span_days: 0, suggested_target: 0,
    },
  };
}

const profileRecord: Record<string, unknown> = { id: 'p1', trend_cards: null };

const fakePb = {
  baseUrl: 'http://localhost:8090',
  authStore: { isValid: true, record: authRecord, onChange: () => () => {} },
  collection: (name: string) => {
    if (name === 'profiles') {
      return {
        getFullList: async () => [profileRecord],
        update: async (_id: string, data: Record<string, unknown>) => {
          Object.assign(profileRecord, data);
          return profileRecord;
        },
      };
    }
    if (name === 'weights') return { getList: async () => ({ items: [] }) };
    if (name === 'meal_slots') return { getFullList: async () => [] };
    throw new Error(`unexpected collection ${name}`);
  },
};

vi.mock('../../lib/pb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pb')>();
  return { ...actual, getClient: () => fakePb };
});

const fetchTrendsMock = vi.fn();
vi.mock('../../lib/trends', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/trends')>();
  return { ...actual, fetchTrends: (...args: unknown[]) => fetchTrendsMock(...args) };
});

function renderTrends() {
  return render(
    <MemoryRouter>
      <AppProvider>
        <Trends />
      </AppProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  fetchTrendsMock.mockReset();
  profileRecord.trend_cards = null;
});

describe('Trends', () => {
  it('renders the five default cards when the profile has none stored', async () => {
    fetchTrendsMock.mockResolvedValue(makePayload(90));
    renderTrends();

    await waitFor(() => expect(screen.getByText('Weight trend')).toBeTruthy());
    for (const title of ['Weight trend', 'Observed TDEE', 'Intake vs budget', 'Energy balance', 'Logging consistency']) {
      expect(screen.getByText(title)).toBeTruthy();
    }
    // An off-by-default card must not appear.
    expect(screen.queryByText('Weekday pattern')).toBeNull();
  });

  it('honours the stored card selection and its order', async () => {
    profileRecord.trend_cards = ['intake', 'weight'];
    fetchTrendsMock.mockResolvedValue(makePayload(90));
    renderTrends();

    await waitFor(() => expect(screen.getByText('Intake vs budget')).toBeTruthy());
    expect(screen.queryByText('Energy balance')).toBeNull();
  });

  it('shows a stub instead of a chart below the card minimum', async () => {
    // 10 days: below the 14-day floor for Observed TDEE.
    fetchTrendsMock.mockResolvedValue(makePayload(10));
    renderTrends();

    await waitFor(() => expect(screen.getByText('Observed TDEE')).toBeTruthy());
    expect(screen.getByText(/needs 14 days/i)).toBeTruthy();
  });

  it('requests a different range when the selector changes', async () => {
    fetchTrendsMock.mockResolvedValue(makePayload(90));
    renderTrends();
    await waitFor(() => expect(fetchTrendsMock).toHaveBeenCalled());
    expect(fetchTrendsMock.mock.calls[0][1]).toBe(90);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd frontend && npx vitest run src/screens/__tests__/Trends.test.tsx
```

Expected: FAIL — cannot resolve `../Trends`.

- [ ] **Step 3: Write the screen shell**

Create `frontend/src/screens/Trends.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../state/AppContext';
import { getClient } from '../lib/pb';
import { fetchTrends, resolveCards, ALL_CARDS, type CardId } from '../lib/trends';
import type { TrendsPayload } from '../lib/types';
import { Button, Card, CardTitle, Segmented, Sheet, Spinner, useToast } from '../components/ui';

type Range = '30' | '90' | '365';

/** Trends — a shell that maps over the user's enabled cards.
 *
 * Deliberately thin: every card owns its own file, so this screen never grows
 * into the 600-line problem AddFood.tsx has. */
export default function Trends() {
  const { endpoint } = useApp();
  const [range, setRange] = useState<Range>('90');
  const [data, setData] = useState<TrendsPayload | null>(null);
  const [cards, setCards] = useState<CardId[]>([]);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [customising, setCustomising] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    if (!endpoint) return;
    setLoading(true);
    const pb = getClient(endpoint);
    try {
      const [payload, profiles] = await Promise.all([
        fetchTrends(pb, Number(range)),
        pb.collection('profiles').getFullList(),
      ]);
      setData(payload);
      const profile = profiles[0] as Record<string, unknown> | undefined;
      setProfileId((profile?.id as string) ?? null);
      setCards(resolveCards(profile?.['trend_cards']));
    } catch (ex) {
      toast(ex instanceof Error ? ex.message : 'Could not load trends', 'err');
    } finally {
      setLoading(false);
    }
    // toast is stable from context; excluding it keeps this from re-running.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, range]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveCards = async (next: CardId[]) => {
    setCards(next);
    if (!endpoint || !profileId) return;
    try {
      await getClient(endpoint).collection('profiles').update(profileId, { trend_cards: next });
    } catch (ex) {
      toast(ex instanceof Error ? ex.message : 'Could not save your card choice', 'err');
    }
  };

  const toggle = (id: CardId) => {
    const next = cards.includes(id) ? cards.filter((c) => c !== id) : [...cards, id];
    void saveCards(next);
  };

  const rangeDays = data?.days.length ?? 0;

  return (
    <div className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-bold tracking-[-.02em]">Trends</h2>
        <Button variant="ghost" onClick={() => setCustomising(true)}>
          Customise
        </Button>
      </div>

      <Segmented
        className="mb-4"
        aria-label="Date range"
        value={range}
        onChange={(v) => setRange(v)}
        options={[
          { value: '30', label: '30 days' },
          { value: '90', label: '90 days' },
          { value: '365', label: '1 year' },
        ]}
      />

      {loading && <Spinner />}

      {!loading && data && (
        <div className="flex flex-col gap-3">
          {cards.map((id) => {
            const meta = ALL_CARDS.find((c) => c.id === id);
            if (!meta) return null;
            return (
              <Card key={id} as="section">
                <CardTitle>{meta.title}</CardTitle>
                {rangeDays < meta.minDays ? (
                  <p className="text-sm text-text-faint">
                    Needs {meta.minDays} days of history — you have {rangeDays}.
                  </p>
                ) : (
                  <CardBody id={id} data={data} onChanged={load} />
                )}
              </Card>
            );
          })}
        </div>
      )}

      <Sheet open={customising} onClose={() => setCustomising(false)} title="Customise trends">
        <div className="flex flex-col gap-2">
          {ALL_CARDS.map((c) => (
            <label key={c.id} className="flex items-start gap-3 rounded-md border border-border p-3">
              <input
                type="checkbox"
                className="mt-1"
                checked={cards.includes(c.id)}
                onChange={() => toggle(c.id)}
              />
              <span>
                <span className="block text-sm font-semibold">{c.title}</span>
                <span className="block text-xs text-text-faint">{c.blurb}</span>
              </span>
            </label>
          ))}
        </div>
      </Sheet>
    </div>
  );
}

/** Card bodies land here in Tasks 10 and 11. */
function CardBody({ id, data, onChanged }: { id: CardId; data: TrendsPayload; onChanged: () => void }) {
  void data;
  void onChanged;
  return <p className="text-sm text-text-faint">Coming in the next task: {id}</p>;
}
```

**Verified prop signatures** (checked against the current source — no need to
re-derive these): `Sheet` takes `{ open: boolean; onClose: () => void; title?: string; children }`
and renders `role="dialog"`; `Button` accepts `variant: 'primary' | 'outline' | 'ghost' | 'danger'`,
`size: 'sm' | 'md'`, `block`, and `loading`; `Segmented` takes
`{ value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; className?; 'aria-label'? }`
and renders `role="tab"` per option. The code above already matches all three.

- [ ] **Step 4: Add the route**

In `frontend/src/main.tsx`, add alongside the other authenticated routes:

```tsx
        <Route path="/trends" element={<Trends />} />
```

and the matching import:

```tsx
import Trends from './screens/Trends';
```

- [ ] **Step 5: Add the nav tab**

In `frontend/src/components/AppShell.tsx`, add a fourth entry to `TABS`, after History:

```tsx
  {
    to: '/trends',
    label: 'Trends',
    glyph: (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d="M4 18l5-6 4 3 6-8" />
        <path d="M15 7h4v4" />
      </svg>
    ),
  },
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd frontend && npx vitest run src/screens/__tests__/Trends.test.tsx && npx tsc --noEmit && npm test
```

Expected: PASS, and the pre-existing suite still green.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/screens/Trends.tsx frontend/src/screens/__tests__/Trends.test.tsx frontend/src/main.tsx frontend/src/components/AppShell.tsx
git commit -m "feat(trends): Trends screen shell, route, tab and customise sheet"
```

---

### Task 10: Weight trend and Observed TDEE cards

**Files:**
- Create: `frontend/src/screens/trends/cards/WeightCard.tsx`
- Create: `frontend/src/screens/trends/cards/TdeeCard.tsx`
- Modify: `frontend/src/screens/Trends.tsx` (replace `CardBody`'s stub for these two ids)
- Modify: `frontend/src/screens/__tests__/Trends.test.tsx` (append)

**Interfaces:**
- Consumes: `LineChart`, `regressionOverlay`, `sparseLabels`, `TrendsPayload`.
- Produces: `WeightCard({ data })`, `TdeeCard({ data, onAccepted })`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/screens/__tests__/Trends.test.tsx`:

```tsx
import userEvent from '@testing-library/user-event';

function sufficientPayload(): TrendsPayload {
  const p = makePayload(90);
  p.estimate = {
    sufficient: true, reason: '', window_days: 28, observed_tdee: 2512,
    margin: 180, slope_kg_per_week: -0.42, mean_intake: 2050,
    qualifying_days: 26, weigh_ins: 14, span_days: 27, suggested_target: 1962,
  };
  p.ema = p.days.map((d, i) => ({ date: d.date, kg: 80 - i * 0.01, interpolated: false }));
  p.weights = p.days.map((d, i) => ({ date: d.date, kg: 80 - i * 0.01 }));
  return p;
}

describe('Observed TDEE card', () => {
  it('shows the estimate with its margin and the formula it beats', async () => {
    fetchTrendsMock.mockResolvedValue(sufficientPayload());
    renderTrends();

    await waitFor(() => expect(screen.getByText(/2,512/)).toBeTruthy());
    expect(screen.getByText(/± ?180/)).toBeTruthy();
    expect(screen.getByText(/2,200/)).toBeTruthy(); // formula_tdee
  });

  it('explains why rather than showing a number when data is thin', async () => {
    const p = makePayload(90);
    p.estimate.reason = 'few_weigh_ins';
    p.estimate.weigh_ins = 3;
    fetchTrendsMock.mockResolvedValue(p);
    renderTrends();

    await waitFor(() => expect(screen.getByText(/weigh-ins/i)).toBeTruthy());
    expect(screen.queryByText(/apply/i)).toBeNull();
  });

  it('writes the suggested target and its provenance when accepted', async () => {
    fetchTrendsMock.mockResolvedValue(sufficientPayload());
    renderTrends();

    await waitFor(() => expect(screen.getByRole('button', { name: /apply/i })).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: /apply/i }));

    await waitFor(() => expect(profileRecord['calorie_target']).toBe(1962));
    expect(profileRecord['calorie_target_source']).toBe('observed');
    expect(profileRecord['calorie_target_set_at']).toBeTruthy();
  });

  it('says how old an accepted target is once it has drifted', async () => {
    const p = sufficientPayload();
    p.target_source = 'observed';
    // 24 days ago — past the 14-day recheck threshold.
    const set = new Date(Date.now() - 24 * 86400_000).toISOString();
    p.target_set_at = set.replace('T', ' ').replace('Z', 'Z');
    fetchTrendsMock.mockResolvedValue(p);
    renderTrends();

    await waitFor(() => expect(screen.getByText(/24 days ago/i)).toBeTruthy());
  });

  it('does not nag about a target set only days ago', async () => {
    const p = sufficientPayload();
    p.target_source = 'observed';
    p.target_set_at = new Date(Date.now() - 2 * 86400_000).toISOString().replace('T', ' ');
    fetchTrendsMock.mockResolvedValue(p);
    renderTrends();

    await waitFor(() => expect(screen.getByText('Observed TDEE')).toBeTruthy());
    expect(screen.queryByText(/days ago/i)).toBeNull();
  });

  it('reverts to the formula, clearing the target and its provenance', async () => {
    const p = sufficientPayload();
    p.target_source = 'observed';
    p.target_set_at = new Date().toISOString().replace('T', ' ');
    fetchTrendsMock.mockResolvedValue(p);
    profileRecord['calorie_target'] = 1962;
    renderTrends();

    await waitFor(() => expect(screen.getByRole('button', { name: /use the formula/i })).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: /use the formula/i }));

    await waitFor(() => expect(profileRecord['calorie_target']).toBe(null));
    expect(profileRecord['calorie_target_source']).toBe('');
    expect(profileRecord['calorie_target_set_at']).toBe(null);
  });

  it('offers no revert when the target did not come from an estimate', async () => {
    const p = sufficientPayload(); // target_source: ''
    fetchTrendsMock.mockResolvedValue(p);
    renderTrends();

    await waitFor(() => expect(screen.getByText('Observed TDEE')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /use the formula/i })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd frontend && npx vitest run src/screens/__tests__/Trends.test.tsx
```

Expected: FAIL — the estimate figures are not rendered.

- [ ] **Step 3: Write WeightCard**

Create `frontend/src/screens/trends/cards/WeightCard.tsx`:

```tsx
import { LineChart } from '../../../components/ui';
import { regressionOverlay, sparseLabels } from '../../../lib/trends';
import type { TrendsPayload } from '../../../lib/types';

/** Raw weigh-ins, the EMA trend line, and the fitted regression segment over
 * the estimate window — so the user can see the exact line the TDEE number
 * was derived from rather than taking it on faith. */
export function WeightCard({ data }: { data: TrendsPayload }) {
  const byDate = new Map(data.weights.map((w) => [w.date, w.kg]));
  const emaByDate = new Map(data.ema.map((e) => [e.date, e.kg]));

  const raw = data.days.map((d) => byDate.get(d.date) ?? null);
  const ema = data.days.map((d) => emaByDate.get(d.date) ?? null);
  const fit = regressionOverlay(data);

  if (data.weights.length === 0) {
    return <p className="text-sm text-text-faint">No weigh-ins in this range. Log a weight from Profile.</p>;
  }

  return (
    <>
      <LineChart
        ariaLabel="Weight trend"
        labels={sparseLabels(data.days.map((d) => d.date))}
        series={[
          { values: raw, tone: 'muted', dots: true },
          { values: ema, tone: 'accent' },
          { values: fit, tone: 'accent', dashed: true },
        ]}
      />
      <p className="mt-2 text-xs text-text-faint">
        Dots are weigh-ins, the solid line is the smoothed trend, and the dashed line is the
        fitted rate over the last {data.estimate.window_days} days.
      </p>
    </>
  );
}
```

- [ ] **Step 4: Write TdeeCard**

Create `frontend/src/screens/trends/cards/TdeeCard.tsx`:

```tsx
import { useState } from 'react';
import { useApp } from '../../../state/AppContext';
import { getClient } from '../../../lib/pb';
import { formatInt } from '../../../lib/format';
import { Button, useToast } from '../../../components/ui';
import type { TrendsPayload } from '../../../lib/types';

const REASONS: Record<string, (e: TrendsPayload['estimate']) => string> = {
  no_data: () => 'Nothing logged yet in this window.',
  sparse_logging: (e) =>
    `Needs ${Math.ceil(e.window_days * 0.8)} logged days in the last ${e.window_days} — you have ${e.qualifying_days}.`,
  few_weigh_ins: (e) => `Needs 8 weigh-ins in the last ${e.window_days} days — you have ${e.weigh_ins}.`,
  short_span: (e) =>
    `Your weigh-ins only span ${e.span_days} days. Spread them over at least 21 so the trend means something.`,
};

/** Days after which an accepted target is worth rechecking. Roughly half the
 * estimate window: long enough not to nag, short enough that a target set
 * before a real change in body weight gets questioned. */
const STALE_AFTER_DAYS = 14;

/** Whole days between an ISO-ish timestamp and now; null when unparseable. */
function daysSince(raw: string): number | null {
  if (!raw) return null;
  const t = Date.parse(raw.replace(' ', 'T'));
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86400_000);
}

/** The suggestion. Never applies itself: a stretch of half-logged days must
 * not be able to quietly cut someone's target. */
export function TdeeCard({ data, onAccepted }: { data: TrendsPayload; onAccepted: () => void }) {
  const { endpoint } = useApp();
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const est = data.estimate;

  const fromEstimate = data.target_source === 'observed';
  const age = fromEstimate ? daysSince(data.target_set_at) : null;
  const stale = age != null && age >= STALE_AFTER_DAYS;

  /** Write to the single profile row. Both actions need this, and the profile
   * id is not in the payload, so it is looked up once here. */
  const patchProfile = async (patch: Record<string, unknown>, ok: string) => {
    if (!endpoint) return;
    setSaving(true);
    const pb = getClient(endpoint);
    try {
      const profiles = await pb.collection('profiles').getFullList();
      const id = (profiles[0] as { id?: string } | undefined)?.id;
      if (!id) throw new Error('No profile found');
      await pb.collection('profiles').update(id, patch);
      toast(ok);
      onAccepted();
    } catch (ex) {
      toast(ex instanceof Error ? ex.message : 'Could not update your budget', 'err');
    } finally {
      setSaving(false);
    }
  };

  /** Clearing calorie_target hands the budget back to the formula, since
   * userBudget only takes the override branch when the target is > 0. */
  const revert = () =>
    patchProfile(
      { calorie_target: null, calorie_target_source: '', calorie_target_set_at: null },
      'Back to the formula estimate',
    );

  if (!est.sufficient) {
    const explain = REASONS[est.reason] ?? (() => 'Not enough data yet.');
    return (
      <>
        <p className="text-sm text-text-faint">{explain(est)}</p>
        <p className="mt-2 text-xs text-text-faint">
          Until then your budget comes from the Mifflin-St Jeor estimate in your profile.
        </p>
        {/* Someone who accepted an estimate and then let their logging lapse
            still needs a way back to the formula. */}
        {fromEstimate && (
          <div className="mt-3">
            <Button variant="outline" onClick={() => void revert()} disabled={saving}>
              Use the formula instead
            </Button>
          </div>
        )}
      </>
    );
  }

  const apply = () =>
    patchProfile(
      {
        calorie_target: est.suggested_target,
        calorie_target_source: 'observed',
        calorie_target_set_at: new Date().toISOString(),
      },
      'Budget updated from your own data',
    );

  return (
    <>
      <p className="text-2xl font-bold tracking-[-.02em]">
        {formatInt(est.observed_tdee)}{' '}
        <span className="text-sm font-medium text-text-faint">± {formatInt(est.margin)} kcal/day</span>
      </p>
      <p className="mt-1 text-sm text-text-muted">
        Your formula estimate is {data.formula_tdee != null ? formatInt(data.formula_tdee) : '—'} kcal.
        Based on {est.qualifying_days} logged days and {est.weigh_ins} weigh-ins over the last{' '}
        {est.window_days} days, changing {est.slope_kg_per_week.toFixed(2)} kg/week.
      </p>

      {stale && (
        <p className="mt-2 text-sm text-warn">
          Your budget was set from an estimate {age} days ago. Worth a recheck.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button onClick={() => void apply()} disabled={saving}>
          Apply {formatInt(est.suggested_target)} kcal
        </Button>
        {fromEstimate && (
          <Button variant="outline" onClick={() => void revert()} disabled={saving}>
            Use the formula instead
          </Button>
        )}
      </div>

      <p className="mt-2 text-xs text-text-faint">
        Always measured over {est.window_days} days, whatever range the charts are showing.
      </p>
    </>
  );
}
```

- [ ] **Step 5: Wire both into the screen**

In `frontend/src/screens/Trends.tsx`, replace the placeholder `CardBody` with:

```tsx
function CardBody({ id, data, onChanged }: { id: CardId; data: TrendsPayload; onChanged: () => void }) {
  switch (id) {
    case 'weight':
      return <WeightCard data={data} />;
    case 'tdee':
      return <TdeeCard data={data} onAccepted={onChanged} />;
    default:
      return <p className="text-sm text-text-faint">Coming in the next task: {id}</p>;
  }
}
```

and import them:

```tsx
import { WeightCard } from './trends/cards/WeightCard';
import { TdeeCard } from './trends/cards/TdeeCard';
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd frontend && npx vitest run src/screens/__tests__/Trends.test.tsx && npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/screens/
git commit -m "feat(trends): weight trend and observed TDEE cards"
```

---

### Task 11: Intake, Energy balance and Consistency cards

**Files:**
- Create: `frontend/src/screens/trends/cards/IntakeCard.tsx`
- Create: `frontend/src/screens/trends/cards/BalanceCard.tsx`
- Create: `frontend/src/screens/trends/cards/ConsistencyCard.tsx`
- Modify: `frontend/src/screens/Trends.tsx` (extend `CardBody`)
- Modify: `frontend/src/screens/__tests__/Trends.test.tsx` (append)

**Interfaces:**
- Consumes: `BarChart`, `LineChart`, `Heatmap`, `intakeSeries`, `movingAverage`, `balanceSeries`, `consistencyCells`, `sparseLabels`.
- Produces: `IntakeCard({ data })`, `BalanceCard({ data })`, `ConsistencyCard({ data })`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/screens/__tests__/Trends.test.tsx`:

```tsx
describe('Energy balance card', () => {
  it('reconciles predicted against actual weight change', async () => {
    fetchTrendsMock.mockResolvedValue(sufficientPayload());
    renderTrends();

    await waitFor(() => expect(screen.getByText('Energy balance')).toBeTruthy());
    expect(screen.getByText(/predicted/i)).toBeTruthy();
    expect(screen.getByText(/actual/i)).toBeTruthy();
  });

  it('says which TDEE it is measuring against', async () => {
    const p = makePayload(90); // insufficient estimate
    fetchTrendsMock.mockResolvedValue(p);
    renderTrends();

    await waitFor(() => expect(screen.getByText('Energy balance')).toBeTruthy());
    expect(screen.getByText(/formula/i)).toBeTruthy();
  });
});

describe('Consistency card', () => {
  it('reports how many days were logged', async () => {
    fetchTrendsMock.mockResolvedValue(makePayload(90));
    renderTrends();

    await waitFor(() => expect(screen.getByText('Logging consistency')).toBeTruthy());
    expect(screen.getByText(/90 of 90/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd frontend && npx vitest run src/screens/__tests__/Trends.test.tsx
```

Expected: FAIL — "Unable to find an element with the text: /predicted/i".

- [ ] **Step 3: Write IntakeCard**

Create `frontend/src/screens/trends/cards/IntakeCard.tsx`:

```tsx
import { BarChart } from '../../../components/ui';
import { formatInt } from '../../../lib/format';
import { intakeSeries, movingAverage, sparseLabels } from '../../../lib/trends';
import type { TrendsPayload } from '../../../lib/types';

/** Daily intake against the budget. Days with nothing logged draw no bar at
 * all — a missing day is missing data, not a zero-calorie day. */
export function IntakeCard({ data }: { data: TrendsPayload }) {
  const { values, budget } = intakeSeries(data);
  const avg7 = movingAverage(values, 7);
  const logged = values.filter((v): v is number => v != null);
  const mean = logged.length > 0 ? logged.reduce((s, v) => s + v, 0) / logged.length : 0;

  return (
    <>
      <BarChart
        ariaLabel="Intake vs budget"
        values={values}
        target={budget}
        labels={sparseLabels(data.days.map((d) => d.date))}
      />
      <p className="mt-2 text-sm text-text-muted">
        Averaging {formatInt(mean)} kcal across {logged.length} logged days
        {budget != null && <> against a {formatInt(budget)} kcal budget</>}.
      </p>
      <p className="mt-1 text-xs text-text-faint">
        7-day average today: {avg7.at(-1) != null ? `${formatInt(avg7.at(-1) as number)} kcal` : '—'}.
      </p>
    </>
  );
}
```

- [ ] **Step 4: Write BalanceCard**

Create `frontend/src/screens/trends/cards/BalanceCard.tsx`:

```tsx
import { LineChart } from '../../../components/ui';
import { formatInt } from '../../../lib/format';
import { balanceSeries, sparseLabels } from '../../../lib/trends';
import type { TrendsPayload } from '../../../lib/types';

/** Cumulative energy balance, reconciled against the scale.
 *
 * This is the card that makes the rest of the feature checkable: when the
 * predicted change and the actual change agree, the TDEE estimate is doing its
 * job, and the user can see that for themselves instead of trusting a number. */
export function BalanceCard({ data }: { data: TrendsPayload }) {
  const { values, predictedKg, reference, referenceTdee } = balanceSeries(data);

  const firstEma = data.ema[0]?.kg;
  const lastEma = data.ema.at(-1)?.kg;
  const actualKg = firstEma != null && lastEma != null ? lastEma - firstEma : null;

  if (referenceTdee <= 0) {
    return <p className="text-sm text-text-faint">Needs a TDEE to measure against — set your profile details first.</p>;
  }

  return (
    <>
      <LineChart
        ariaLabel="Cumulative energy balance"
        zeroLine
        labels={sparseLabels(data.days.map((d) => d.date))}
        series={[{ values, tone: 'accent' }]}
      />
      <p className="mt-2 text-sm text-text-muted">
        {formatInt(Math.abs(values.at(-1) ?? 0))} kcal {(values.at(-1) ?? 0) < 0 ? 'deficit' : 'surplus'} so far —
        predicted {predictedKg.toFixed(2)} kg.
        {actualKg != null && <> Actual change on the scale: {actualKg.toFixed(2)} kg.</>}
      </p>
      <p className="mt-1 text-xs text-text-faint">
        Measured against your {reference === 'observed' ? 'observed' : 'formula'} TDEE of{' '}
        {formatInt(referenceTdee)} kcal.
      </p>
    </>
  );
}
```

- [ ] **Step 5: Write ConsistencyCard**

Create `frontend/src/screens/trends/cards/ConsistencyCard.tsx`:

```tsx
import { Heatmap } from '../../../components/ui';
import { consistencyCells } from '../../../lib/trends';
import type { TrendsPayload } from '../../../lib/types';

/** Which days were logged. Doubles as the honesty check for the TDEE card:
 * a sparse grid is exactly why an estimate gets withheld. */
export function ConsistencyCard({ data }: { data: TrendsPayload }) {
  const cells = consistencyCells(data);
  const logged = cells.filter((c) => c.level > 0).length;

  return (
    <>
      <Heatmap cells={cells} ariaLabel="Logging consistency" />
      <p className="mt-2 text-sm text-text-muted">
        Logged {logged} of {cells.length} days.
      </p>
      <p className="mt-1 text-xs text-text-faint">
        Darker cells are fuller days. Gaps are days with nothing recorded — those are excluded
        from the TDEE estimate rather than counted as zero.
      </p>
    </>
  );
}
```

- [ ] **Step 6: Extend CardBody**

In `frontend/src/screens/Trends.tsx`, add the three cases and imports:

```tsx
    case 'intake':
      return <IntakeCard data={data} />;
    case 'balance':
      return <BalanceCard data={data} />;
    case 'consistency':
      return <ConsistencyCard data={data} />;
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cd frontend && npx vitest run src/screens/__tests__/Trends.test.tsx && npx tsc --noEmit && npm test
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/screens/
git commit -m "feat(trends): intake, energy balance and consistency cards"
```

---

### Task 12: The five optional cards

**Files:**
- Create: `frontend/src/screens/trends/cards/MacrosCard.tsx`
- Create: `frontend/src/screens/trends/cards/WeekdayCard.tsx`
- Create: `frontend/src/screens/trends/cards/MealsCard.tsx`
- Create: `frontend/src/screens/trends/cards/MetricCard.tsx`
- Modify: `frontend/src/screens/Trends.tsx` (extend `CardBody`)
- Modify: `frontend/src/screens/__tests__/Trends.test.tsx` (append)

**Interfaces:**
- Consumes: `BarChart`, `StackedBar`, `weekdayAverages`, `mealRows`, `movingAverage`, `sparseLabels`.
- Produces: `MacrosCard({ data })`, `WeekdayCard({ data })`, `MealsCard({ data })`, `MetricCard({ data, metric })` where `metric: 'water' | 'steps'`.

`MetricCard` is shared by the water and steps cards: both are "a daily value against a flat target with a rolling average", and writing it twice would be two files that drift apart.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/screens/__tests__/Trends.test.tsx`:

```tsx
describe('optional cards', () => {
  it('renders each one when enabled', async () => {
    profileRecord.trend_cards = ['macros', 'weekday', 'meals', 'water', 'steps'];
    fetchTrendsMock.mockResolvedValue(makePayload(90));
    renderTrends();

    await waitFor(() => expect(screen.getByText('Macros')).toBeTruthy());
    for (const title of ['Macros', 'Weekday pattern', 'Meal distribution', 'Water', 'Steps']) {
      expect(screen.getByText(title)).toBeTruthy();
    }
  });

  it('switches the macro shown when the selector changes', async () => {
    profileRecord.trend_cards = ['macros'];
    fetchTrendsMock.mockResolvedValue(makePayload(90));
    renderTrends();

    await waitFor(() => expect(screen.getByRole('tab', { name: 'Carbs' })).toBeTruthy());
    await userEvent.click(screen.getByRole('tab', { name: 'Carbs' }));
    expect(screen.getByRole('img', { name: /carbs/i })).toBeTruthy();
  });

  it('tells the user where meal data comes from when there are no slots', async () => {
    profileRecord.trend_cards = ['meals'];
    fetchTrendsMock.mockResolvedValue(makePayload(90)); // slots: []
    renderTrends();

    await waitFor(() => expect(screen.getByText('Meal distribution')).toBeTruthy());
    expect(screen.getByText(/no meals/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd frontend && npx vitest run src/screens/__tests__/Trends.test.tsx
```

Expected: FAIL — "Unable to find an element with the text: Macros".

- [ ] **Step 3: Write MacrosCard**

Create `frontend/src/screens/trends/cards/MacrosCard.tsx`:

```tsx
import { useState } from 'react';
import { BarChart, Segmented } from '../../../components/ui';
import { formatInt } from '../../../lib/format';
import { sparseLabels } from '../../../lib/trends';
import type { TrendsPayload } from '../../../lib/types';

type Macro = 'protein' | 'carbs' | 'fat';

const LABEL: Record<Macro, string> = { protein: 'Protein', carbs: 'Carbs', fat: 'Fat' };

/** Grams per day for one macro at a time, against its target.
 *
 * Absolute grams rather than a percentage split, because a percentage hides
 * the number people actually chase — you cannot tell whether 30% protein was
 * 90 g or 190 g without also knowing the day's calories. */
export function MacrosCard({ data }: { data: TrendsPayload }) {
  const [macro, setMacro] = useState<Macro>('protein');

  const values = data.days.map((d) => (d.logged ? d[macro] : null));
  const target = { protein: data.targets.protein_g, carbs: data.targets.carbs_g, fat: data.targets.fat_g }[macro];
  const logged = values.filter((v): v is number => v != null);
  const mean = logged.length > 0 ? logged.reduce((s, v) => s + v, 0) / logged.length : 0;

  return (
    <>
      <Segmented
        className="mb-3"
        aria-label="Macro"
        value={macro}
        onChange={(v) => setMacro(v)}
        options={[
          { value: 'protein' as const, label: 'Protein' },
          { value: 'carbs' as const, label: 'Carbs' },
          { value: 'fat' as const, label: 'Fat' },
        ]}
      />
      <BarChart
        ariaLabel={`${LABEL[macro]} per day`}
        values={values}
        target={target > 0 ? target : null}
        labels={sparseLabels(data.days.map((d) => d.date))}
      />
      <p className="mt-2 text-sm text-text-muted">
        Averaging {formatInt(mean)} g of {LABEL[macro].toLowerCase()} per logged day
        {target > 0 && <> against a {formatInt(target)} g target</>}.
      </p>
    </>
  );
}
```

- [ ] **Step 4: Write WeekdayCard**

Create `frontend/src/screens/trends/cards/WeekdayCard.tsx`:

```tsx
import { BarChart } from '../../../components/ui';
import { formatInt } from '../../../lib/format';
import { weekdayAverages } from '../../../lib/trends';
import type { TrendsPayload } from '../../../lib/types';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Average intake by day of the week — the card that finds weekend drift. */
export function WeekdayCard({ data }: { data: TrendsPayload }) {
  const avgs = weekdayAverages(data);
  // A weekday with no logged days averages 0; show it as absent, not as zero.
  const values = avgs.map((v) => (v > 0 ? v : null));

  const present = avgs.filter((v) => v > 0);
  const spread = present.length > 1 ? Math.max(...present) - Math.min(...present) : 0;

  return (
    <>
      <BarChart ariaLabel="Average intake by weekday" values={values} target={data.budget} labels={DAYS} />
      <p className="mt-2 text-sm text-text-muted">
        {spread > 0
          ? `${formatInt(spread)} kcal between your heaviest and lightest day of the week.`
          : 'Not enough logged days yet to compare weekdays.'}
      </p>
    </>
  );
}
```

- [ ] **Step 5: Write MealsCard**

Create `frontend/src/screens/trends/cards/MealsCard.tsx`:

```tsx
import { StackedBar } from '../../../components/ui';
import { mealRows } from '../../../lib/trends';
import type { TrendsPayload } from '../../../lib/types';

/** How an average day's calories spread across the user's own meal slots,
 * next to the pct_allocation targets those slots already carry. */
export function MealsCard({ data }: { data: TrendsPayload }) {
  const rows = mealRows(data);

  if (data.slots.length === 0 || rows.length === 0) {
    return <p className="text-sm text-text-faint">No meals to compare yet — add meal slots in Profile and log to them.</p>;
  }

  const total = rows[0].parts.reduce((s, p) => s + p.value, 0);

  return (
    <>
      <StackedBar rows={rows} ariaLabel="Meal distribution" />
      <ul className="mt-3 flex flex-col gap-1">
        {rows[0].parts.map((p, i) => {
          const share = total > 0 ? (p.value / total) * 100 : 0;
          const target = data.slots[i]?.pct_allocation ?? 0;
          return (
            <li key={p.label} className="flex justify-between text-xs">
              <span className="text-text-muted">{p.label}</span>
              <span className="text-text-faint">
                {share.toFixed(0)}%{target > 0 && <> of a {target}% target</>}
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}
```

- [ ] **Step 6: Write MetricCard**

Create `frontend/src/screens/trends/cards/MetricCard.tsx`:

```tsx
import { BarChart } from '../../../components/ui';
import { formatInt } from '../../../lib/format';
import { movingAverage, sparseLabels } from '../../../lib/trends';
import type { TrendsPayload } from '../../../lib/types';

/** Water and steps are the same shape — a daily value against a flat target
 * with a rolling average — so they share one component rather than two files
 * that drift apart. */
export function MetricCard({ data, metric }: { data: TrendsPayload; metric: 'water' | 'steps' }) {
  const values = data.days.map((d) => {
    const v = metric === 'water' ? d.water_ml : d.steps;
    return v > 0 ? v : null;
  });
  const target = metric === 'water' ? data.targets.water_ml : data.targets.steps;
  const unit = metric === 'water' ? 'ml' : 'steps';

  const present = values.filter((v): v is number => v != null);
  const mean = present.length > 0 ? present.reduce((s, v) => s + v, 0) / present.length : 0;
  const avg7 = movingAverage(values, 7).at(-1);

  return (
    <>
      <BarChart
        ariaLabel={metric === 'water' ? 'Water per day' : 'Steps per day'}
        values={values}
        target={target > 0 ? target : null}
        labels={sparseLabels(data.days.map((d) => d.date))}
      />
      <p className="mt-2 text-sm text-text-muted">
        Averaging {formatInt(mean)} {unit} on the {present.length} days you recorded any
        {target > 0 && <>, against a {formatInt(target)} {unit} target</>}.
      </p>
      {avg7 != null && (
        <p className="mt-1 text-xs text-text-faint">
          Last 7 days: {formatInt(avg7)} {unit}.
        </p>
      )}
    </>
  );
}
```

- [ ] **Step 7: Extend CardBody**

In `frontend/src/screens/Trends.tsx`, add the remaining cases and drop the
`default` stub in favour of returning `null`:

```tsx
    case 'macros':
      return <MacrosCard data={data} />;
    case 'weekday':
      return <WeekdayCard data={data} />;
    case 'meals':
      return <MealsCard data={data} />;
    case 'water':
      return <MetricCard data={data} metric="water" />;
    case 'steps':
      return <MetricCard data={data} metric="steps" />;
    default:
      return null;
```

- [ ] **Step 8: Run the full suite**

```bash
cd frontend && npx vitest run && npx tsc --noEmit && npm run build
```

Expected: PASS, clean typecheck, successful production build.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/screens/
git commit -m "feat(trends): macros, weekday, meals, water and steps cards"
```

---

### Task 13: Documentation and whole-branch verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Run everything**

```bash
cd backend && go build ./... && go test ./... && gofmt -l internal/trend internal/routes/trends.go internal/migrations/trend_cards.go
cd ../frontend && npx vitest run && npx tsc --noEmit && npm run build
```

Expected: all green; `gofmt -l` prints nothing for the files this branch created.

- [ ] **Step 2: Manual check against a running app**

```bash
cd backend && go run . serve --http 127.0.0.1:8090
# separate shell
cd frontend && npm run dev
```

Verify in the browser:
1. A brand-new account opens Trends without console errors and every card shows a stub rather than a broken axis.
2. The customise sheet toggles cards, and the choice survives a reload (it is on the profile, not localStorage).
3. Switching 30/90/365 refetches and redraws; the TDEE card keeps saying 28 days.
4. Switching accent colour and dark mode restyles every chart with no per-chart code.
5. With a seeded month of data, Apply changes the budget shown on Today.

- [ ] **Step 3: Update the README feature list**

Under `### Dashboard`, add:

```markdown
- 📈 **Trends** — weight trend with a fitted rate, intake vs budget, cumulative
  energy balance, logging heatmap, macros, weekday pattern, meal split, water
  and steps; pick which cards you want
- 🧮 **Observed TDEE** — your real calorie burn worked out from your own intake
  and weight history, offered as a suggestion you accept rather than applied
  behind your back
```

And add to the custom API surface list:

```markdown
- `GET  /api/saolrian/trends?days=` — day series, weight trend and observed TDEE
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: describe Trends and observed TDEE in the README"
```

---

## Verification for the whole plan

- `go test ./...` and `npx vitest run` green.
- `gofmt -l` clean on created Go files only.
- `npx tsc --noEmit` and `npm run build` clean.
- No new dependency in `frontend/package.json` or `backend/go.mod`.
- `git diff main --stat -- backend/internal/routes/summary.go` shows exactly one added line (the route registration) — `userBudget` untouched.
- `grep -rn "exercise_entries" backend/internal/trend backend/internal/routes/trends.go` returns nothing.

## Follow-on work

- **Staleness nudge.** `calorie_target_set_at` plus the existing `internal/push` package make "your observed TDEE has moved since you set this" a small feature.
- **Estimate history.** A `tdee_estimates` collection charting how observed TDEE fell as the user lost weight. Deliberately deferred; the estimate is cheap enough to compute on demand.
- **Card reordering.** The storage format already carries order.
- **Micronutrient coverage card.** Lands with Plan 4 of the food-datasources spec.
- **Local-timezone day bucketing.** Must move `/summary`, `/trends` and the client together.

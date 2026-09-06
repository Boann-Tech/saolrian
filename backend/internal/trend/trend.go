// Package trend derives trend lines and an observed TDEE from a user's own
// logged history.
//
// Everything here is a function of its arguments: no database, no clock, no
// PocketBase imports. That keeps the whole estimator table-testable and lets
// the endpoint stay a thin adapter over it.
package trend

import (
	"math"
	"time"
)

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
//
// WindowDays on the returned Estimate reports the number of days actually
// handed in (len(days)), not the WindowDays constant — a caller passing a
// shorter range (e.g. a 7-day chart) gets an estimate that honestly says so,
// rather than one that claims a 28-day window it never had.
func Compute(days []Day, samples []Sample) Estimate {
	est := Estimate{WindowDays: len(days), Reason: ReasonNone}

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

// daysBetween returns hi - lo in whole days for two YYYY-MM-DD dates.
func daysBetween(lo, hi string) int {
	l, err1 := time.Parse("2006-01-02", lo)
	h, err2 := time.Parse("2006-01-02", hi)
	if err1 != nil || err2 != nil {
		return 0
	}
	return int(h.Sub(l).Hours() / 24)
}

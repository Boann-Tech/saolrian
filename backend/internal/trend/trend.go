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

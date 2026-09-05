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
		"range":         map[string]any{"from": from, "to": to, "days": days},
		"days":          out,
		"weights":       weights,
		"ema":           ema,
		"budget":        budget,
		"formula_tdee":  formulaTDEE(app, uid, profile),
		"goal":          profile.GetString("goal"),
		"goal_rate":     goalRate,
		"target_source": profile.GetString("calorie_target_source"),
		"target_set_at": profile.GetString("calorie_target_set_at"),
		"targets":       trendTargets(profile, budget),
		"slots":         slotsOut,
		"estimate":      estOut,
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

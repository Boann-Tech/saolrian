# Adaptive TDEE and trend charts

Date: 2026-09-05
Status: Approved design, pending implementation plan

## Goal

Turn the weight history Saolrian already stores into two things it does not
currently provide: an **observed TDEE** derived from the user's own energy
balance rather than a population formula, offered as a suggestion they accept;
and a **Trends screen** of charts over the logged history, where the user
chooses which cards to show.

## Why now

`weights` has been an append-only history with a `(user, measured_at)` index
since the first migration, and exactly one row of it is ever read — the newest,
at `backend/internal/routes/summary.go`, to feed the Mifflin/Katch formula.
Every weigh-in after the first is dead data.

The formula is also the weakest part of the budget. Mifflin-St Jeor predicts a
*population mean* and routinely misses a given individual's true expenditure by
10% or more even when height, weight, age and sex are exact — and the activity
multiplier layers a five-way guess on top of a number that is already an
estimate. A user who has logged consistently for a month is carrying enough
information to beat it, and the app throws that information away.

There is no aggregation endpoint of any kind: `/summary` is strictly per-day, so
nothing in the product can answer a question that spans more than 24 hours.

## Decisions

Settled during brainstorming; not open questions.

| Decision | Choice |
|---|---|
| Adopt model | Suggestion the user explicitly accepts — never automatic |
| Placement | New Trends screen (fourth tab) |
| Charting | Hand-rolled SVG primitives, zero dependencies |
| Estimator location | Backend, pure package + one endpoint |
| Rate derivation | OLS regression on (day, kg), not an EMA delta |
| Uncertainty | Reported as a ± range, not a point estimate |
| Unlogged days | Excluded from the mean; never counted as zero |
| Card visibility | Per-user, stored server-side, ordered array |
| Accept mechanism | Writes `calorie_target`; `userBudget` unchanged |

## Non-goals

- **Automatic budget adjustment.** The estimate never moves the budget on its
  own. A month of half-logged days must not be able to quietly cut someone's
  target.
- **Estimate history.** No `tdee_estimates` collection, no scheduled job. The
  estimate costs microseconds to compute on demand. Charting how observed TDEE
  moved over months is a genuinely good future feature; it is not this one.
- **Card reordering UI.** The storage format carries order so it falls out
  later for free. v1 ships toggles only.
- **Micronutrients.** Plan 4 of the food-datasources spec owns those. The card
  catalogue has room for a coverage card when it lands.
- **Local-timezone day bucketing.** See §8.
- **Notifying the user that their estimate is stale.** `internal/push` exists
  and makes this a small follow-on; it is out of scope here.

## 1. The estimator — `backend/internal/trend`

A pure package with no PocketBase imports, in the shape of `internal/tdee` and
`internal/food`. Everything in it is a function of its arguments, so the whole
estimator is table-testable without a database.

### 1.1 Weight rate by ordinary least squares

Given weigh-ins as points `(t_i, w_i)` where `t_i` is days since the window
start and `w_i` is kilograms:

```
b  = Σ(t_i − t̄)(w_i − w̄) / Σ(t_i − t̄)²        slope, kg/day
a  = w̄ − b·t̄                                   intercept
e_i = w_i − (a + b·t_i)                         residuals
s²  = Σe_i² / (n − 2)                           residual variance, needs n ≥ 3
SE(b) = √( s² / Σ(t_i − t̄)² )
```

Regression rather than a first-to-last EMA delta for three reasons: weigh-ins
arrive at irregular intervals and regression handles that natively; it uses
every measurement instead of two; and it yields `SE(b)`, without which the
estimate cannot honestly report uncertainty.

### 1.2 Observed TDEE

```
mean_intake = Σ kcal over logged days / count(logged days)
observed    = mean_intake − b · 7700
```

Sign check: gaining 0.1 kg/day is a 770 kcal/day surplus, so intake exceeds
TDEE by 770 and `observed = mean_intake − 770`. Correct.

7700 kcal/kg is the conventional Wishnofsky figure, already used by
`tdee.Budget` for goal rates. Reusing it keeps the suggestion consistent with
the budget arithmetic the user already sees.

### 1.3 Uncertainty

Both terms contribute, and both are reported as one interval:

```
SE(mean) = sd(intake over logged days) / √n_logged
margin   = t_crit(df) · √( SE(mean)² + (7700 · SE(b))² )
```

`t_crit` comes from a small embedded two-tailed 95% t-table for df 1–30,
falling back to 1.96 beyond it. A z-value would understate the interval at the
sample sizes this feature actually runs on (8–28 weigh-ins), and the point of
the interval is to be honest.

The two SEs carry different degrees of freedom, so the combination is an
approximation. Documented as such in the package doc; the alternative is
Welch–Satterthwaite machinery for a number that is displayed rounded to the
nearest 10 kcal.

### 1.4 Completeness gate

`Completeness` returns a reason constant, and the endpoint returns
`sufficient: false` with it rather than a wrong number. Named constants so the
UI renders specific copy, not a generic shrug:

| Requirement | Default | Reason constant |
|---|---|---|
| Logged days ≥ 80% of window | 23 of 28 | `ReasonSparseLogging` |
| Weigh-ins in window ≥ 8 | 8 | `ReasonFewWeighIns` |
| Span between first and last weigh-in ≥ 21 days | 21 | `ReasonShortSpan` |
| Window has any data at all | — | `ReasonNoData` |

A day counts as logged when its kcal total is **≥ 500** (`MinLoggedKcal`). A day
where someone logged a single apple is not a logged day, and admitting it drags
the mean down and the estimated TDEE with it.

The span requirement exists because eight weigh-ins clustered in four days
produce a confident-looking slope fitted to water-weight noise and extrapolated
across a month.

### 1.5 Two limitations, documented not modelled

**The estimate is TDEE at the window's average weight.** Someone losing weight
has a falling TDEE, and a 28-day window returns its midpoint. At realistic rates
this is tens of kcal — smaller than the reported margin — and modelling it would
mean fitting a moving target for no visible gain.

**Chronic under-logging biases the estimate low, and this is fine.** People
under-report by 10–20%. The estimate absorbs that bias into itself, which means
it is expressed *in the user's own logging units* — and the budget derived from
it is then applied to that same under-reporting. The two errors cancel where it
matters. This is the reason the technique works at all, and it belongs in the
package doc so nobody later "fixes" it.

### 1.6 Display smoothing

`EMA(series, alpha)` with `alpha = 0.10` produces the chart's trend line. It
walks calendar days: on a day with a weigh-in, `ema += alpha·(w − ema)`; on a
day without, the previous value carries forward, flagged `interpolated` so the
renderer can draw it as a continuing line without implying a measurement. Seeded
with the first weigh-in, not zero.

EMA is for the eye; the regression is for the number. The chart draws both, so
the user can see the line the number came from.

## 2. Endpoint

```
GET /api/saolrian/trends?days=90
```

`days` clamped to [7, 730], default 90. Registered in `routes.Register`
alongside the existing routes, behind the same `apis.RequireAuth()` bind.

Four queries: diary totals grouped by date; diary totals grouped by date and
meal slot; `weights` over the range; `daily_metrics` over the range.

```jsonc
{
  "range": { "from": "2026-06-07", "to": "2026-09-05", "days": 90 },
  "days": [
    { "date": "2026-06-07", "kcal": 2103, "protein": 142, "carbs": 180,
      "fat": 78, "entries": 11, "logged": true,
      "water_ml": 2000, "steps": 8412,
      "by_slot": { "<slot_id>": 620 } }
  ],
  "weights": [ { "date": "2026-06-07", "kg": 83.4 } ],
  "budget": 1690,
  "formula_tdee": 2240,
  "goal": "lose",
  "goal_rate": -0.5,
  "targets": { "protein_g": 168, "carbs_g": 224, "fat_g": 75,
               "water_ml": 2000, "steps": 10000 },
  "slots": [ { "id": "...", "name": "Breakfast", "sort_order": 0,
               "pct_allocation": 25 } ],
  "estimate": {
    "sufficient": true,
    "reason": "",
    "window_days": 28,
    "observed_tdee": 2512,
    "margin": 180,
    "slope_kg_per_week": -0.42,
    "mean_intake": 2050,
    "logged_days": 26,
    "weigh_ins": 14,
    "span_days": 27,
    "suggested_target": 1962
  }
}
```

The worked example ties out: `−0.42 kg/week` is `−0.06 kg/day`, so
`observed = 2050 + 0.06 × 7700 = 2512`; `suggested = 2512 − 550 = 1962`; and the
current `budget` of 1690 is the formula TDEE of 2240 less the same 550 goal
adjustment. `budget` is post-goal, `formula_tdee` and `observed_tdee` are both
pre-goal — the suggestion card compares like with like.

`targets.protein_g` and its siblings are derived from the profile's macro
percentages against the current budget (`protein_pct × budget / 4` and so on),
so they move when the budget does.

`days` is **zero-filled**: one row per calendar day in the range, with
`logged: false` where nothing was recorded. Filling it server-side means no card
has to reconstruct the calendar, and the distinction between "ate nothing
recorded" and "zero calories" lives in one place instead of ten.

`suggested_target` = `observed_tdee + goal_rate × 7700/7`, matching
`tdee.Budget`'s convention where `goal_rate` is negative for loss.

Thin data returns **200 with `sufficient: false`**, never an error. A new user
opening Trends is the expected case, not a failure.

## 3. Card catalogue

Every card is a pure transform of the single payload above. Toggling one on
costs no request and no backend work — the property that makes a ten-card
catalogue cheap instead of ten endpoints.

| id | Card | Answers | minDays | Default |
|---|---|---|---|---|
| `weight` | Weight trend | Raw weigh-ins, EMA line, regression segment over the estimate window | 7 | on |
| `tdee` | Observed TDEE | The suggestion: observed ± margin vs formula, accept / dismiss, staleness | 14 | on |
| `intake` | Intake vs budget | Daily bars, budget line, 7-day average; unlogged days blank, not zero | 7 | on |
| `balance` | Energy balance | Cumulative (intake − TDEE) in kcal and predicted kg, beside actual change | 14 | on |
| `consistency` | Logging consistency | Calendar heatmap of logged days — also the honesty check for `tdee` | 7 | on |
| `macros` | Macros | Segmented: % split vs target, or absolute g/day per macro | 7 | off |
| `weekday` | Weekday pattern | Mean kcal by day of week vs budget — surfaces weekend drift | 21 | off |
| `meals` | Meal distribution | Share of kcal per slot vs the `pct_allocation` already on `meal_slots` | 7 | off |
| `water` | Water | Daily ml vs target, with average | 7 | off |
| `steps` | Steps | Daily steps, 7-day average, vs target | 7 | off |

Five on by default. A new user should not land on ten charts.

`balance` reconciles the two halves of the feature: cumulative
`Σ(intake − TDEE_ref)` over logged days, converted to predicted kg at 7700, set
next to the actual change in the EMA line over the same span. When those two
numbers agree the estimate is trustworthy, and the user can see that for
themselves. `TDEE_ref` is the observed estimate when sufficient, the formula
otherwise, and the card states which.

Below its `minDays` a card renders a stub — "needs 14 days of logging, you have
6" — rather than an axis with two points on it.

## 4. Chart primitives

Four components under `frontend/src/components/ui/charts/`, plus shared scale
helpers:

| Primitive | Used by |
|---|---|
| `LineChart` | `weight`, `balance` |
| `BarChart` | `intake`, `macros`, `weekday`, `water`, `steps` |
| `Heatmap` | `consistency` |
| `StackedBar` | `meals` |

Responsive by `viewBox` rather than measurement. Colour comes from the existing
Tailwind v4 tokens and `currentColor`, so the accent switcher and dark mode work
with no per-chart handling — the reason hand-rolled SVG beat a library here.

A range selector (30 / 90 / 365) reuses `Segmented`. The **28-day estimate
window is independent of the display range** and every card that shows the
estimate says so; otherwise changing the chart range appears to move the user's
TDEE.

## 5. Persistence

One migration, three fields on `profiles`:

| Field | Type | Purpose |
|---|---|---|
| `trend_cards` | JSON | Ordered array of enabled card ids |
| `calorie_target_source` | Select `manual` \| `observed` | Where the current target came from |
| `calorie_target_set_at` | Date | When it was set |

`trend_cards` uses presence for enabled and position for order, so one field
covers visibility now and drag-reorder later. Null or absent means defaults —
important, because it makes every existing profile correct without a backfill.
Unrecognised ids are ignored by the client rather than erroring, so a profile
written by a newer build degrades quietly on an older one.

## 6. Accepting a suggestion

Accept writes `calorie_target = suggested_target` and stamps
`calorie_target_source = "observed"` with `calorie_target_set_at = today`.

`calorie_target` is already the manual-override branch at
`backend/internal/routes/summary.go`, and it already wins over the formula.
**`userBudget` therefore needs no change at all** — the whole adopt path reuses
a code path that has been in production since the first release.

The provenance fields are what stop this being a one-shot calculation. With them
the card can say "this came from your data on 12 Sep, 24 days ago — recheck?",
which closes the loop: estimate, accept, drift, re-estimate. Without them an
accepted target is indistinguishable from a number the user typed in once and
forgot.

"Revert to formula" clears `calorie_target` and the two provenance fields.

## 7. Files

```
backend/internal/trend/trend.go            EMA, OLS, Estimate, Completeness
backend/internal/trend/trend_test.go
backend/internal/routes/trends.go          endpoint + aggregation queries
backend/internal/routes/trends_test.go
backend/internal/migrations/trend_cards.go three profile fields

frontend/src/components/ui/charts/         4 primitives + scale helpers
frontend/src/lib/trends.ts                 payload → per-card series
frontend/src/lib/trends.test.ts
frontend/src/screens/Trends.tsx            shell: range, card list, customise Sheet
frontend/src/screens/trends/cards/*.tsx    one file per card
frontend/src/screens/__tests__/Trends.test.tsx
```

One card per file is deliberate. `AddFood.tsx` at 649 lines and
`ProfileGoals.tsx` at 581 are the warning: a screen that accretes features in
one file becomes the file nobody wants to touch. `Trends.tsx` should stay a
shell that maps over enabled ids.

The customise UI is the existing `Sheet` primitive with a checkbox list. Nav
gains a fourth tab in `AppShell`'s `TABS`; routing gains `/trends` in
`main.tsx`.

## 8. Day bucketing — inherited, not fixed

`/summary` buckets a day as `date 00:00:00.000Z` to the next date at the same
time: **UTC calendar days**. `/trends` must bucket identically.

This is wrong for any user not near UTC — their day boundary is not local
midnight — but a Trends chart that disagreed with the Today screen about the
same day's total would be a worse bug than the one it fixed. Matching the
existing behaviour is the requirement; changing it is a separate piece of work
that has to move both endpoints and the client at once.

## 9. Testing

**Go.** The estimator is tested against planted answers: synthesise 28 days at a
known intake with a known slope, assert the recovered TDEE lands within
tolerance, and assert the margin widens as scatter is added. Each gate
rejection gets a case — sparse logging, too few weigh-ins, clustered weigh-ins
that pass the count but fail the span. `n < 3` must not divide by zero. Sign
convention gets an explicit test in both directions, since a flipped sign here
yields a plausible-looking and completely wrong number.

The endpoint is tested for UTC bucket alignment against `/summary` for the same
day, for zero-filling across a gap, and for `sufficient: false` on a new user.

**Vitest.** `lib/trends.ts` transforms follow the `recipes.ts` / `nutrition.ts`
pattern. The `Trends.tsx` test follows `screens/__tests__`, covering default
cards, a toggle round-trip, and the stub state below `minDays`.

TDD throughout, per the repo's existing practice.

## 10. Sequencing

The implementation plan should treat the five default cards as the deliverable
and the five optional ones as an additive second pass. The estimator, the
endpoint, the migration, the four chart primitives and `weight` / `tdee` /
`intake` / `balance` / `consistency` are what make the feature real; `macros`,
`weekday`, `meals`, `water` and `steps` are each a small pure transform plus an
existing primitive, and none of them blocks anything.

This matters because the interesting risk is concentrated in the estimator and
the aggregation query. Getting those reviewed before writing five more cards on
top of them is the cheaper order.

## 11. Verification

- `go test ./...` and `npm test` green.
- `gofmt -l` clean **on files this branch touches** (the repo is not globally
  gofmt-clean; do not reformat unrelated files).
- Trends renders for a profile with no data at all, showing stubs and no
  console errors.
- A seeded 28-day fixture produces an estimate whose accept path changes the
  budget on Today.
- Accent switching and dark mode restyle every chart with no per-chart code.

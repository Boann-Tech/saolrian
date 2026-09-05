# Food Pack Sources (CNF, CIQUAL, CoFID, AFCD) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the `foodpack` tool from four USDA-only thousand rows to a five-source, ~21k-row pack — adding the Canadian Nutrient File, CIQUAL, CoFID and AFCD adapters, a pinned fetch manifest, and the cross-source checks that catch a whole-column unit error.

**Architecture:** Every new adapter is one file in `internal/foodpack/source` exporting `LoadX(XOptions) ([]format.RefFood, []format.SourceInfo, error)` — the same shape `LoadUSDA` already has — driven by a checked-in CSV mapping table. Three pieces of shared machinery come first so the four adapters are thin: a CSV row streamer (encoding fallback, BOM strip, required-column check), a `ValueSyntax` sentinel parser (`Tr` → 0, `N` → absent, `[12]` → 12), and a `Builder` that assembles `RefFood`s and collects range violations. `cmd/foodpack` gains `fetch` (pinned URLs and SHA-256, with a documented manual fallback) and two new verification checks.

**Tech Stack:** Go 1.27, `encoding/csv` + `encoding/xml` + `archive/zip` (stdlib), `golang.org/x/text/encoding/charmap` (already an indirect dependency, promoted to direct), `github.com/xuri/excelize/v2` (new, ingest-only), `go test`.

**Spec:** `docs/superpowers/specs/2026-09-04-food-datasources-design.md` (§1 Canonical nutrient model incl. *Source sentinels*, §3 Ingest pipeline, §8 Licensing and attribution, §9 Testing)

**Predecessor:** `docs/superpowers/plans/2026-09-04-food-pack-ingest.md` (Plan 1 — vocabulary, pack format, mapping loader, USDA adapter, `build`/`verify` CLI). Plan 1's own real-data gate was never run; **Task 8 of this plan closes it** alongside the four new sources.

## Global Constraints

- Go **1.27**, module `github.com/boanntech/saolrian/backend`. PocketBase pinned at **v0.40.2** — do not upgrade it in this plan.
- **Absent is not zero.** A nutrient with no data is omitted from the profile. Never write `0` to mean "unknown". The one deliberate exception is a *trace* sentinel, which is a measurement of "negligible" and therefore a real `0.0`.
- All stored values are **per 100 g edible portion**.
- Each canonical nutrient has **exactly one** unit: `kcal`, `g`, `mg`, or `ug`. Conversion happens once, in an adapter's mapping factor, never later.
- **No new server-reachable dependency.** `github.com/xuri/excelize/v2` may be imported only from `internal/foodpack/source`. The server binary imports `internal/food` and `internal/foodpack/format` and nothing else from the ingest tree. Task 5 adds a check that proves this.
- **An unrecognised non-numeric token is a build error**, never a silent zero. A dataset refresh that introduces a new sentinel must stop the build.
- **A mapped source code that is absent from the dataset is a build error** (`ErrMappingNotInSource`). This is what makes the starter mapping tables in Tasks 3–6 safe: a wrong code fails loudly on real data in Task 8 rather than silently dropping a nutrient.
- Run backend tests with `cd backend && go test ./...`.
- Commit after every task. Branch: `feat/multi-source-food-data`.

## File Structure

| File | Responsibility |
|---|---|
| `backend/internal/foodpack/source/csvrows.go` | Shared CSV streamer: BOM strip, Windows-1252 fallback, required-column check |
| `backend/internal/foodpack/source/value.go` | `ValueSyntax` — per-dataset sentinel and number grammar |
| `backend/internal/foodpack/source/build.go` | `Builder` — `RefFood` assembly, dedupe, collected range violations; `UnmappedCollector` |
| `backend/internal/foodpack/source/manifest.go` | Fetch manifest loader |
| `backend/internal/foodpack/source/manifest/sources.csv` | Checked-in pinned URLs + SHA-256 per archive |
| `backend/internal/foodpack/source/cnf.go` | Canadian Nutrient File multi-CSV adapter |
| `backend/internal/foodpack/source/ciqual.go` | CIQUAL XML adapter |
| `backend/internal/foodpack/source/sheet.go` | excelize worksheet → header + rows, with header normalisation |
| `backend/internal/foodpack/source/cofid.go` | CoFID xlsx adapter (multi-sheet join on food code) |
| `backend/internal/foodpack/source/afcd.go` | AFCD xlsx adapter (single per-100g sheet) |
| `backend/internal/foodpack/source/mapping/{cnf,ciqual,cofid,afcd}.csv` | Checked-in, human-auditable nutrient mapping per source |
| `backend/cmd/foodpack/fetch.go` | `foodpack fetch` — download, hash, extract |
| `backend/cmd/foodpack/crosssource.go` | Cross-source agreement check + anchor table loader |
| `backend/cmd/foodpack/golden/anchors.csv` | Checked-in per-source name regexes for the cross-source anchors |
| `backend/cmd/foodpack/verify.go` | *modified* — registers the two new checks |
| `backend/cmd/foodpack/main.go` | *modified* — `fetch` subcommand, `build --work`, `--report-unmapped` |

---

### Task 1: Shared adapter toolkit

Four adapters are about to be written. Without this task each would carry its own copy of "stream a CSV", "is this cell a number", and "assemble a `RefFood`", and the three would drift. `usda.go` already contains two of the three (`usdaEachRow`, and the assembly tail inside `LoadUSDA`); this task lifts them out and ports USDA onto the shared versions, with the existing USDA tests as the regression net.

**Files:**
- Create: `backend/internal/foodpack/source/csvrows.go`
- Create: `backend/internal/foodpack/source/value.go`
- Create: `backend/internal/foodpack/source/build.go`
- Test: `backend/internal/foodpack/source/value_test.go`
- Test: `backend/internal/foodpack/source/build_test.go`
- Test: `backend/internal/foodpack/source/csvrows_test.go`
- Modify: `backend/internal/foodpack/source/usda.go` (delete `usdaEachRow`, call `eachCSVRow`; replace the assembly tail of `LoadUSDA` with `Builder`; add `Unmapped` to `USDAOptions`)

**Interfaces:**
- Consumes: `food.Profile`, `food.Validate`, `food.Encode`, `food.SearchText`, `food.RangeViolationsError` (Plan 1 Tasks 1–2); `format.RefFood`, `format.Portion` (Plan 1 Task 3).
- Produces:
  - `eachCSVRow(path string, required []string, fn func(get func(string) string) error) error`
  - `ValueSyntax{Absent, Trace []string; DecimalComma bool}`; `(ValueSyntax).Parse(raw string) (val float64, present bool, err error)`; `ErrUnknownToken`
  - `FoodInput{Source, SourceID, Region, Licence, Name, NameLocale, SearchExtra string; Profile food.Profile; Portions []format.Portion}`
  - `NewBuilder() *Builder`; `(*Builder).Add(FoodInput)`; `(*Builder).Foods() []format.RefFood`; `(*Builder).Rows() map[string]int`; `(*Builder).Err(prefix string) error`
  - `UnmappedSink func(code, label string)`; `NewUnmappedCollector() *UnmappedCollector`; `(*UnmappedCollector).Note(code, label string)`; `(*UnmappedCollector).Report() string`; `noteUnmapped(sink UnmappedSink, code, label string)`

- [ ] **Step 1: Write the failing value-syntax test**

Create `backend/internal/foodpack/source/value_test.go`:

```go
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
		{"grouped thousands", ciqualLike, "1 234,5", 1234.5, true},
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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd backend && go test ./internal/foodpack/source/ -run ValueSyntax -v`
Expected: FAIL — `undefined: ValueSyntax`, `undefined: ErrUnknownToken`.

- [ ] **Step 3: Implement `value.go`**

Create `backend/internal/foodpack/source/value.go`:

```go
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

// spaceChars are every space a spreadsheet export has been seen to emit:
// ordinary, non-breaking, and narrow no-break (French thousands grouping).
const spaceChars = " \t   "

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
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `cd backend && go test ./internal/foodpack/source/ -run 'ValueSyntax|Trace' -v`
Expected: PASS.

- [ ] **Step 5: Write the failing builder test**

Create `backend/internal/foodpack/source/build_test.go`:

```go
package source

import (
	"errors"
	"strings"
	"testing"

	"github.com/boanntech/saolrian/backend/internal/food"
	"github.com/boanntech/saolrian/backend/internal/foodpack/format"
)

func sampleInput(id, name string, prof food.Profile) FoodInput {
	return FoodInput{
		Source: "cnf", SourceID: id, Region: "ca", Licence: "ogl-canada",
		Name: name, Profile: prof,
	}
}

func TestBuilderAssemblesRefFood(t *testing.T) {
	b := NewBuilder()
	b.Add(FoodInput{
		Source: "cnf", SourceID: "12", Region: "ca", Licence: "ogl-canada",
		Name: "Banana, raw", SearchExtra: "banane crue",
		Profile:  food.Profile{"energy_kcal": 89, "protein": 1.09},
		Portions: []format.Portion{{Label: "1 medium", Grams: 118}, {Label: "1 cup", Grams: 150}},
	})

	foods := b.Foods()
	if len(foods) != 1 {
		t.Fatalf("got %d foods, want 1", len(foods))
	}
	f := foods[0]
	if f.Source != "cnf" || f.SourceID != "12" || f.Region != "ca" || f.Licence != "ogl-canada" {
		t.Errorf("provenance not carried through: %+v", f)
	}
	// The default serving is the first portion: sources list their most
	// representative measure first, and the pack has nowhere else to
	// record which one that is.
	if f.DefaultServingG != 118 {
		t.Errorf("DefaultServingG = %v, want 118", f.DefaultServingG)
	}
	if got := food.Decode(f.Nutrients)["energy_kcal"]; got != 89 {
		t.Errorf("energy_kcal = %v, want 89", got)
	}
	// SearchExtra exists so a CIQUAL food stays findable under its French
	// name even though it is stored under its English one.
	if !strings.Contains(f.SearchText, "banane") {
		t.Errorf("SearchText %q does not include the extra terms", f.SearchText)
	}
	if b.Rows()["cnf"] != 1 {
		t.Errorf("Rows()[cnf] = %d, want 1", b.Rows()["cnf"])
	}
}

// A food with no nutrient data at all is not worth shipping: it adds a row
// to every search result and answers no question.
func TestBuilderSkipsEmptyProfiles(t *testing.T) {
	b := NewBuilder()
	b.Add(sampleInput("1", "Nothing known", nil))
	b.Add(sampleInput("2", "Also nothing", food.Profile{}))
	if len(b.Foods()) != 0 {
		t.Fatalf("got %d foods, want 0", len(b.Foods()))
	}
}

// (source, source_id) is the unique index the seed migration relies on.
// Two rows sharing it would make the seed fail at 3am, not here.
func TestBuilderDedupesBySourceID(t *testing.T) {
	b := NewBuilder()
	b.Add(sampleInput("7", "First wins", food.Profile{"energy_kcal": 10}))
	b.Add(sampleInput("7", "Second loses", food.Profile{"energy_kcal": 20}))
	foods := b.Foods()
	if len(foods) != 1 {
		t.Fatalf("got %d foods, want 1", len(foods))
	}
	if foods[0].Name != "First wins" {
		t.Errorf("kept %q, want the first row", foods[0].Name)
	}
}

// Range violations are collected, not fatal on the first offender: fixing a
// mapping table one rebuild per defect is a wasted afternoon.
func TestBuilderCollectsRangeViolations(t *testing.T) {
	b := NewBuilder()
	b.Add(sampleInput("1", "Fine", food.Profile{"energy_kcal": 89}))
	b.Add(sampleInput("2", "Iron in ug not mg", food.Profile{"iron": 2710}))
	b.Add(sampleInput("3", "Also broken", food.Profile{"calcium": 999999}))

	if len(b.Foods()) != 1 {
		t.Errorf("got %d foods, want only the valid one", len(b.Foods()))
	}
	err := b.Err("cnf")
	if !errors.Is(err, food.ErrOutOfRange) {
		t.Fatalf("Err() = %v, want ErrOutOfRange", err)
	}
	for _, want := range []string{"cnf", "Iron in ug not mg", "Also broken"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %q", err.Error(), want)
		}
	}
}

func TestBuilderErrIsNilWhenClean(t *testing.T) {
	b := NewBuilder()
	b.Add(sampleInput("1", "Fine", food.Profile{"energy_kcal": 89}))
	if err := b.Err("cnf"); err != nil {
		t.Errorf("Err() = %v, want nil", err)
	}
}

func TestUnmappedCollectorReportsEachCodeOnce(t *testing.T) {
	c := NewUnmappedCollector()
	c.Note("9999", "Some new nutrient")
	c.Note("9999", "Some new nutrient")
	c.Note("8888", "Another")
	rep := c.Report()
	if strings.Count(rep, "9999") != 1 {
		t.Errorf("code reported %d times, want 1:\n%s", strings.Count(rep, "9999"), rep)
	}
	if !strings.Contains(rep, "8888") || !strings.Contains(rep, "Another") {
		t.Errorf("report is missing a code or its label:\n%s", rep)
	}
}

// A nil sink is the normal case; adapters must not have to check.
func TestNoteUnmappedToleratesNilSink(t *testing.T) {
	noteUnmapped(nil, "1", "x")
}
```

- [ ] **Step 6: Run it to confirm it fails**

Run: `cd backend && go test ./internal/foodpack/source/ -run 'Builder|Unmapped' -v`
Expected: FAIL — `undefined: NewBuilder`, `undefined: FoodInput`, `undefined: NewUnmappedCollector`.

- [ ] **Step 7: Implement `build.go`**

Create `backend/internal/foodpack/source/build.go`:

```go
package source

import (
	"fmt"
	"sort"
	"strings"

	"github.com/boanntech/saolrian/backend/internal/food"
	"github.com/boanntech/saolrian/backend/internal/foodpack/format"
)

// FoodInput is one source food handed to the shared assembly tail.
type FoodInput struct {
	Source   string
	SourceID string
	Region   string
	Licence  string
	Name     string
	// NameLocale is the language Name is written in, e.g. "fr". Empty
	// means English.
	NameLocale string
	// SearchExtra is folded into SearchText but never displayed: a
	// second-language name, or a synonym the source publishes separately.
	SearchExtra string
	Profile     food.Profile
	Portions    []format.Portion
}

// Builder assembles canonical foods from adapter output, applying the rules
// every adapter must share: skip foods with no data, keep the first row for
// a repeated id, and collect range violations across the whole load instead
// of failing on the first.
type Builder struct {
	foods      []format.RefFood
	rows       map[string]int
	seen       map[string]bool
	violations []string
}

func NewBuilder() *Builder {
	return &Builder{rows: map[string]int{}, seen: map[string]bool{}}
}

// Add assembles one food. Call order fixes output order, so adapters should
// iterate their source file in file order to keep builds reproducible.
func (b *Builder) Add(in FoodInput) {
	if len(in.Profile) == 0 {
		return // no nutrient data at all: not worth shipping
	}
	key := in.Source + "\x00" + in.SourceID
	if b.seen[key] {
		// A repeated (source, source_id) would emit two rows against the
		// unique index the seed migration relies on. First row wins.
		return
	}

	// Claimed before validation, not after: a food that fails the range
	// check has still used up its id, and letting a later duplicate take
	// the slot would make the pack depend on which copy came first.
	b.seen[key] = true

	if err := food.Validate(in.Profile); err != nil {
		b.violations = append(b.violations,
			fmt.Sprintf("%s/%s (%s): %v", in.Source, in.SourceID, in.Name, err))
		return
	}

	var defaultServing float64
	if len(in.Portions) > 0 {
		defaultServing = in.Portions[0].Grams
	}
	search := in.Name
	if in.SearchExtra != "" {
		search += " " + in.SearchExtra
	}
	b.rows[in.Source]++
	b.foods = append(b.foods, format.RefFood{
		Source:          in.Source,
		SourceID:        in.SourceID,
		Region:          in.Region,
		Licence:         in.Licence,
		Name:            in.Name,
		NameLocale:      in.NameLocale,
		SearchText:      food.SearchText(search),
		Nutrients:       food.Encode(in.Profile),
		Portions:        in.Portions,
		DefaultServingG: defaultServing,
	})
}

// Foods returns the assembled foods in Add order.
func (b *Builder) Foods() []format.RefFood { return b.foods }

// Rows counts accepted foods per source value, for SourceInfo.
func (b *Builder) Rows() map[string]int { return b.rows }

// Err returns the collected range violations as one error, prefixed with
// the adapter name, or nil when the load was clean.
func (b *Builder) Err(prefix string) error {
	if err := food.RangeViolationsError(b.violations); err != nil {
		return fmt.Errorf("%s: %w", prefix, err)
	}
	return nil
}

// UnmappedSink is called once per distinct source nutrient code that
// appears in a dataset but is absent from its mapping table. Adapters skip
// such codes silently by design — a national dataset carries hundreds of
// nutrients outside the canonical vocabulary — but whoever is writing a
// mapping table needs the authoritative list of what they have not covered.
type UnmappedSink func(code, label string)

func noteUnmapped(sink UnmappedSink, code, label string) {
	if sink != nil {
		sink(code, label)
	}
}

// UnmappedCollector gathers codes for `foodpack build --report-unmapped`.
type UnmappedCollector struct {
	labels map[string]string
}

func NewUnmappedCollector() *UnmappedCollector {
	return &UnmappedCollector{labels: map[string]string{}}
}

// Note satisfies UnmappedSink as a method value: c.Note.
func (c *UnmappedCollector) Note(code, label string) {
	if _, seen := c.labels[code]; !seen {
		c.labels[code] = label
	}
}

// Report renders the codes sorted, one per line, ready to paste into a
// mapping table as a starting point.
func (c *UnmappedCollector) Report() string {
	if len(c.labels) == 0 {
		return "no unmapped nutrient codes"
	}
	codes := make([]string, 0, len(c.labels))
	for code := range c.labels {
		codes = append(codes, code)
	}
	sort.Strings(codes)
	var sb strings.Builder
	fmt.Fprintf(&sb, "%d unmapped nutrient code(s):\n", len(codes))
	for _, code := range codes {
		fmt.Fprintf(&sb, "  %s,-,1,%s\n", code, c.labels[code])
	}
	return sb.String()
}
```

- [ ] **Step 8: Run it to confirm it passes**

Run: `cd backend && go test ./internal/foodpack/source/ -run 'Builder|Unmapped' -v`
Expected: PASS.

- [ ] **Step 9: Write the failing CSV-streamer test**

Create `backend/internal/foodpack/source/csvrows_test.go`:

```go
package source

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeFile(t *testing.T, dir, name string, body []byte) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, body, 0o644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	return p
}

// A UTF-8 BOM on the first header cell renames that column to "﻿id",
// which turns a required-column check into a mystery. CNF and CoFID CSV
// exports both ship one.
func TestEachCSVRowStripsBOM(t *testing.T) {
	dir := t.TempDir()
	p := writeFile(t, dir, "bom.csv", []byte("﻿id,name\n1,Banana\n"))

	var got []string
	err := eachCSVRow(p, []string{"id", "name"}, func(get func(string) string) error {
		got = append(got, get("id")+"="+get("name"))
		return nil
	})
	if err != nil {
		t.Fatalf("eachCSVRow: %v", err)
	}
	if len(got) != 1 || got[0] != "1=Banana" {
		t.Errorf("rows = %v, want [1=Banana]", got)
	}
}

// CNF's CSV export is Windows-1252, not UTF-8. Read as UTF-8 the accented
// French names become invalid bytes that survive all the way into
// search_text.
func TestEachCSVRowDecodesWindows1252(t *testing.T) {
	dir := t.TempDir()
	// 0xE9 is é in Windows-1252 and an invalid lone byte in UTF-8.
	p := writeFile(t, dir, "latin.csv", []byte("id,name\n1,Cr\xe8me fra\xeeche\n"))

	var name string
	err := eachCSVRow(p, []string{"id", "name"}, func(get func(string) string) error {
		name = get("name")
		return nil
	})
	if err != nil {
		t.Fatalf("eachCSVRow: %v", err)
	}
	if name != "Crème fraîche" {
		t.Errorf("name = %q, want %q", name, "Crème fraîche")
	}
}

// A renamed column must fail the build, not quietly produce empty values
// for every row.
func TestEachCSVRowRejectsMissingColumn(t *testing.T) {
	dir := t.TempDir()
	p := writeFile(t, dir, "short.csv", []byte("id\n1\n"))

	err := eachCSVRow(p, []string{"id", "name"}, func(func(string) string) error { return nil })
	if err == nil {
		t.Fatal("want an error naming the missing column")
	}
	if !strings.Contains(err.Error(), `"name"`) {
		t.Errorf("error %q does not name the missing column", err)
	}
}

// Column names in these exports carry stray spaces often enough that
// matching on the raw header text is a trap.
func TestEachCSVRowTrimsHeaderNames(t *testing.T) {
	dir := t.TempDir()
	p := writeFile(t, dir, "spacey.csv", []byte(" id , name \n1,Banana\n"))

	err := eachCSVRow(p, []string{"id", "name"}, func(get func(string) string) error {
		if get("name") != "Banana" {
			t.Errorf("name = %q", get("name"))
		}
		return nil
	})
	if err != nil {
		t.Fatalf("eachCSVRow: %v", err)
	}
}
```

- [ ] **Step 10: Run it to confirm it fails**

Run: `cd backend && go test ./internal/foodpack/source/ -run EachCSVRow -v`
Expected: FAIL — `undefined: eachCSVRow`.

- [ ] **Step 11: Implement `csvrows.go` and delete `usdaEachRow`**

Create `backend/internal/foodpack/source/csvrows.go` — the body is `usdaEachRow` from `usda.go`, renamed, with BOM stripping and the Windows-1252 fallback added:

```go
package source

import (
	"bufio"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/encoding/charmap"
)

// sniffLen is how much of a file is examined to decide its encoding. Big
// enough to reach the accented names that appear well past the header.
const sniffLen = 64 << 10

// eachCSVRow streams a CSV, calling fn with a column accessor. It fails
// fast if any required column is missing from the header.
//
// Two quirks of national dataset exports are handled here rather than in
// each adapter: a UTF-8 BOM glued to the first header cell, and files
// published as Windows-1252 rather than UTF-8 (CNF, and some CoFID CSV
// releases). Both corrupt data silently — the BOM by renaming a column so
// a lookup returns "", the encoding by pushing invalid bytes into
// search_text — so neither can be left to chance.
func eachCSVRow(path string, required []string, fn func(get func(string) string) error) error {
	f, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open %s: %w", filepath.Base(path), err)
	}
	defer f.Close()

	br := bufio.NewReaderSize(f, sniffLen)
	var src io.Reader = br
	head, _ := br.Peek(sniffLen) // Peek does not consume; a short read is fine
	if !utf8.Valid(trimPartialRune(head)) {
		src = charmap.Windows1252.NewDecoder().Reader(br)
	}

	r := csv.NewReader(src)
	r.FieldsPerRecord = -1
	r.ReuseRecord = true
	r.LazyQuotes = true

	header, err := r.Read()
	if err != nil {
		return fmt.Errorf("read header of %s: %w", filepath.Base(path), err)
	}
	col := map[string]int{}
	for i, h := range header {
		h = strings.TrimPrefix(h, "﻿")
		col[strings.Trim(strings.TrimSpace(h), "\"")] = i
	}
	for _, name := range required {
		if _, ok := col[name]; !ok {
			return fmt.Errorf("%s: missing required column %q", filepath.Base(path), name)
		}
	}

	for {
		rec, err := r.Read()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("read %s: %w", filepath.Base(path), err)
		}
		get := func(name string) string {
			i, ok := col[name]
			if !ok || i >= len(rec) {
				return ""
			}
			return rec[i]
		}
		if err := fn(get); err != nil {
			return err
		}
	}
}

// trimPartialRune drops a multi-byte rune left half-read at the end of the
// sniff window, which would otherwise look like invalid UTF-8 and send a
// perfectly good UTF-8 file down the Windows-1252 path.
func trimPartialRune(b []byte) []byte {
	for i := 0; i < 4 && len(b) > 0; i++ {
		if r, size := utf8.DecodeLastRune(b); r != utf8.RuneError || size > 1 {
			break
		}
		b = b[:len(b)-1]
	}
	return b
}
```

Then in `backend/internal/foodpack/source/usda.go`: delete the `usdaEachRow` function entirely, replace all five `usdaEachRow(` call sites with `eachCSVRow(`, and drop the now-unused `encoding/csv`, `io` and `os` imports (`errors`, `fmt`, `filepath`, `sort`, `strconv`, `strings` are still used).

- [ ] **Step 12: Run the whole source package**

Run: `cd backend && go test ./internal/foodpack/source/ -v`
Expected: PASS, including every pre-existing USDA test — the rename must be behaviour-preserving.

- [ ] **Step 13: Port `LoadUSDA` onto `Builder`**

In `backend/internal/foodpack/source/usda.go`, add the sink option and replace the assembly tail. `USDAOptions` becomes:

```go
// USDAOptions configures the FoodData Central adapter.
type USDAOptions struct {
	Dir       string   // directory of extracted FDC CSVs
	DataTypes []string // e.g. "foundation_food", "sr_legacy_food"
	Mapping   *Mapping
	// Unmapped, when set, is told about every source nutrient code the
	// mapping does not cover. Optional.
	Unmapped UnmappedSink
}
```

In the `food_nutrient.csv` loop, report unmapped codes before skipping them:

```go
			key, value, ok := o.Mapping.Apply(n.number, amount)
			if !ok {
				if !o.Mapping.Known(n.number) {
					noteUnmapped(o.Unmapped, n.number, n.name)
				}
				return nil // unmapped or explicitly ignored
			}
```

That needs the nutrient's name, so widen `usdaNutrient` to `struct{ number, unit, name string }`, add `"name"` to the required columns of the `nutrient.csv` read in `usdaNutrients`, and set `name: strings.TrimSpace(get("name"))`.

Replace everything from `out := make([]format.RefFood, 0, len(order))` down to the `return out, sources, nil` with:

```go
	b := NewBuilder()
	for _, fdcID := range order {
		f := foods[fdcID]
		b.Add(FoodInput{
			Source:   f.source,
			SourceID: fdcID,
			Region:   usdaRegion,
			Licence:  usdaLicence,
			Name:     f.name,
			Profile:  profiles[fdcID],
			Portions: portions[fdcID],
		})
	}
	if err := b.Err("usda"); err != nil {
		return nil, nil, err
	}

	rows := b.Rows()
	var sources []format.SourceInfo
	for _, sub := range usdaSubtypeOrder {
		if rows[sub] == 0 {
			continue
		}
		sources = append(sources, format.SourceInfo{
			Source: sub, Region: usdaRegion, Licence: usdaLicence,
			URL: usdaURL, Rows: rows[sub],
		})
	}
	return b.Foods(), sources, nil
```

`food` and `format` are still imported (`food.Profile` in the map declaration, `format.SourceInfo` here).

- [ ] **Step 14: Run every test in the repo**

Run: `cd backend && go test ./...`
Expected: PASS. The USDA adapter tests from Plan 1 are the regression net for this port — if `TestLoadUSDA*` still passes, `Builder` reproduces the old assembly exactly.

- [ ] **Step 15: Commit**

```bash
cd backend && gofmt -l . && go vet ./...
cd /home/slynch/code/saolrian
git add backend/internal/foodpack/source/
git commit -m "refactor(foodpack): shared adapter toolkit for the four new sources

Lifts the three things every adapter needs out of usda.go before there
are four more copies of them: eachCSVRow (now with a BOM strip and a
Windows-1252 fallback, both of which CNF needs), ValueSyntax for the
in-band sentinels the non-USDA sources use, and Builder for the RefFood
assembly tail. USDA is ported onto all three, with its existing tests as
the regression net.

Tr parses to a real 0.0 and N to absent, per the design's source-sentinel
rule: a trace was measured and found negligible, a gap was never looked
at, and collapsing the two makes coverage lie in opposite directions.
An unlisted non-numeric token is a hard error so that a dataset refresh
introducing a new sentinel stops the build.

Also adds UnmappedSink, so whoever writes the next mapping table can ask
the dataset what it has that the table does not cover.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Fetch manifest, `foodpack fetch`, and `build --work`

Five sources across three formats is where "download these by hand and put them somewhere" stops being workable. This task pins each archive's URL and SHA-256 in a checked-in manifest, adds the command that downloads and extracts them, and teaches `build` to find every source from one work directory.

The manifest ships with `sha256` set to the literal `unpinned` for every row. That is a designed state, not a placeholder: `fetch` downloads an unpinned archive, prints the hash it computed, and tells you to paste it into the manifest. **Task 8 pins all six rows against the real downloads.** Once a row is pinned, a mismatch is fatal.

**Files:**
- Create: `backend/internal/foodpack/source/manifest.go`
- Create: `backend/internal/foodpack/source/manifest/sources.csv`
- Create: `backend/internal/foodpack/source/manifest_test.go`
- Create: `backend/cmd/foodpack/fetch.go`
- Create: `backend/cmd/foodpack/fetch_test.go`
- Modify: `backend/internal/foodpack/source/embed.go` (embed the manifest directory)
- Modify: `backend/internal/foodpack/format/pack.go` (`SourceInfo.ArchiveSHA256`)
- Modify: `backend/cmd/foodpack/main.go` (`fetch` subcommand; `build --work` and `--report-unmapped`)
- Modify: `backend/cmd/foodpack/main_test.go` (cover `--work`)

**Interfaces:**
- Consumes: `source.UnmappedCollector` (Task 1); `source.LoadUSDA`, `source.LoadNamedMapping`, `format.Pack` (Plan 1).
- Produces:
  - `source.ManifestEntry{Source, URL, SHA256, ArchiveKind, ExtractTo string}`; `source.Unpinned` (`= "unpinned"`); `source.LoadManifest() ([]ManifestEntry, error)`; `source.ParseManifest(io.Reader) ([]ManifestEntry, error)`
  - `source.WriteFetchRecord(dir string, e ManifestEntry) error`; `source.ReadFetchRecord(dir string) (ManifestEntry, bool, error)`
  - `format.SourceInfo.ArchiveSHA256 string` — new field
  - `loaders` registry in `cmd/foodpack`: `map[string]sourceLoader` where `type sourceLoader func(dir string, sink source.UnmappedSink) ([]format.RefFood, []format.SourceInfo, error)` — **Tasks 3–6 each add one entry to this map.**

- [ ] **Step 1: Write the failing manifest test**

Create `backend/internal/foodpack/source/manifest_test.go`:

```go
package source

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const goodManifest = `source,url,sha256,archive_kind,extract_to
usda_sr,https://example.test/sr.zip,unpinned,zip,usda_sr
cnf,https://example.test/cnf.zip,0000000000000000000000000000000000000000000000000000000000000000,zip,cnf
cofid,https://example.test/cofid.xlsx,unpinned,xlsx,cofid
`

func TestParseManifest(t *testing.T) {
	entries, err := ParseManifest(strings.NewReader(goodManifest))
	if err != nil {
		t.Fatalf("ParseManifest: %v", err)
	}
	if len(entries) != 3 {
		t.Fatalf("got %d entries, want 3", len(entries))
	}
	if entries[0].Source != "usda_sr" || entries[0].SHA256 != Unpinned || entries[0].ArchiveKind != "zip" {
		t.Errorf("first entry = %+v", entries[0])
	}
	if entries[2].ExtractTo != "cofid" || entries[2].ArchiveKind != "xlsx" {
		t.Errorf("third entry = %+v", entries[2])
	}
}

func TestParseManifestRejectsBadRows(t *testing.T) {
	cases := map[string]string{
		"unknown archive kind": "source,url,sha256,archive_kind,extract_to\na,https://e.test/a,unpinned,rar,a\n",
		"short sha":            "source,url,sha256,archive_kind,extract_to\na,https://e.test/a,abc123,zip,a\n",
		"non-hex sha":          "source,url,sha256,archive_kind,extract_to\na,https://e.test/a,zzzz000000000000000000000000000000000000000000000000000000000000,zip,a\n",
		"duplicate source":     "source,url,sha256,archive_kind,extract_to\na,https://e.test/a,unpinned,zip,a\na,https://e.test/b,unpinned,zip,b\n",
		"empty url":            "source,url,sha256,archive_kind,extract_to\na,,unpinned,zip,a\n",
		// extract_to is joined onto a caller-supplied work directory, so a
		// path separator or a .. in it writes outside that directory.
		"extract_to escapes":  "source,url,sha256,archive_kind,extract_to\na,https://e.test/a,unpinned,zip,../a\n",
		"extract_to nests":    "source,url,sha256,archive_kind,extract_to\na,https://e.test/a,unpinned,zip,a/b\n",
		"non-https url":       "source,url,sha256,archive_kind,extract_to\na,http://e.test/a,unpinned,zip,a\n",
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseManifest(strings.NewReader(body)); err == nil {
				t.Fatal("want an error")
			}
		})
	}
}

// The checked-in manifest is what a human edits when a dataset moves. It
// must always parse, and must cover every source the pack ships.
func TestCheckedInManifestParses(t *testing.T) {
	entries, err := LoadManifest()
	if err != nil {
		t.Fatalf("LoadManifest: %v", err)
	}
	want := map[string]bool{
		"usda_foundation": false, "usda_sr": false,
		"cnf": false, "ciqual": false, "cofid": false, "afcd": false,
	}
	for _, e := range entries {
		if _, ok := want[e.Source]; !ok {
			t.Errorf("manifest has unexpected source %q", e.Source)
			continue
		}
		want[e.Source] = true
	}
	for s, seen := range want {
		if !seen {
			t.Errorf("manifest is missing source %q", s)
		}
	}
}

func TestFetchRecordRoundTrips(t *testing.T) {
	dir := t.TempDir()
	e := ManifestEntry{
		Source: "cnf", URL: "https://example.test/cnf.zip",
		SHA256: "abc", ArchiveKind: "zip", ExtractTo: "cnf",
	}
	if err := WriteFetchRecord(dir, e); err != nil {
		t.Fatalf("WriteFetchRecord: %v", err)
	}
	got, ok, err := ReadFetchRecord(dir)
	if err != nil || !ok {
		t.Fatalf("ReadFetchRecord: %v, ok=%v", err, ok)
	}
	if got.Source != e.Source || got.URL != e.URL || got.SHA256 != e.SHA256 {
		t.Errorf("record = %+v, want %+v", got, e)
	}
}

func TestReadFetchRecordAbsent(t *testing.T) {
	_, ok, err := ReadFetchRecord(t.TempDir())
	if err != nil {
		t.Fatalf("ReadFetchRecord: %v", err)
	}
	if ok {
		t.Error("want ok=false for a directory with no record")
	}
}

func TestReadFetchRecordRejectsGarbage(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, fetchRecordName), []byte("nonsense"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := ReadFetchRecord(dir); err == nil {
		t.Fatal("want an error for a malformed record")
	}
}
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd backend && go test ./internal/foodpack/source/ -run 'Manifest|FetchRecord' -v`
Expected: FAIL — `undefined: ParseManifest`.

- [ ] **Step 3: Write the checked-in manifest**

Create `backend/internal/foodpack/source/manifest/sources.csv`:

```csv
source,url,sha256,archive_kind,extract_to
usda_foundation,https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_csv_2025-04-24.zip,unpinned,zip,usda_foundation
usda_sr,https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_csv_2018-04.zip,unpinned,zip,usda_sr
cnf,https://food-nutrition.canada.ca/hn-vsan/assets/cnf-fce_2015_csv.zip,unpinned,zip,cnf
ciqual,https://ciqual.anses.fr/cms/sites/default/files/inline-files/CIQUAL2020_XML_2020_07_07.zip,unpinned,zip,ciqual
cofid,https://assets.publishing.service.gov.uk/media/5eb6296486650c2ce2ba0d24/McCance_Widdowsons_Composition_of_Foods_Integrated_Dataset_2019.xlsx,unpinned,xlsx,cofid
afcd,https://www.foodstandards.gov.au/sites/default/files/2023-11/Release%202%20-%20Food%20nutrient%20database.xlsx,unpinned,xlsx,afcd
```

Note that the two USDA archives extract to **separate** directories. Each contains its own `food.csv`, `food_nutrient.csv` and so on; merging them into one directory (as Plan 1's verification section suggested) would have the second overwrite the first. `LoadUSDA` is called once per directory and the `data_type` column selects the subtype, so this costs nothing and is the only correct layout.

These URLs are best-effort as of this plan's date. Every one of the four national sites has moved its download at least once. That is exactly why `fetch` prints a manual-drop path on failure and why Task 8 re-pins the whole file.

- [ ] **Step 4: Implement `manifest.go`**

Create `backend/internal/foodpack/source/manifest.go`:

```go
package source

import (
	"encoding/csv"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Unpinned marks a manifest row whose archive hash is not yet recorded.
// fetch will download it and print the hash to paste in; once a real hash
// is there, a mismatch is fatal.
const Unpinned = "unpinned"

// fetchRecordName is the breadcrumb fetch leaves in an extracted source
// directory so build can tell which archive produced it.
const fetchRecordName = ".foodpack-fetch"

// ManifestEntry is one downloadable archive.
type ManifestEntry struct {
	Source      string // matches the pack's source value, e.g. "cnf"
	URL         string
	SHA256      string // 64 lowercase hex chars, or Unpinned
	ArchiveKind string // zip | xlsx | xml | csv
	ExtractTo   string // single directory name under the work dir
}

var archiveKinds = map[string]bool{"zip": true, "xlsx": true, "xml": true, "csv": true}

// LoadManifest reads the checked-in manifest.
func LoadManifest() ([]ManifestEntry, error) {
	f, err := MappingFS.Open("manifest/sources.csv")
	if err != nil {
		return nil, fmt.Errorf("open manifest: %w", err)
	}
	defer f.Close()
	return ParseManifest(f)
}

// ParseManifest reads a manifest CSV with header
// source,url,sha256,archive_kind,extract_to.
func ParseManifest(r io.Reader) ([]ManifestEntry, error) {
	cr := csv.NewReader(r)
	cr.FieldsPerRecord = -1
	rows, err := cr.ReadAll()
	if err != nil {
		return nil, fmt.Errorf("read manifest csv: %w", err)
	}
	if len(rows) < 2 {
		return nil, fmt.Errorf("manifest csv has no rows")
	}

	var out []ManifestEntry
	seen := map[string]bool{}
	for i, row := range rows[1:] { // skip header
		line := i + 2
		if len(row) < 5 {
			return nil, fmt.Errorf("line %d: want 5 columns, got %d", line, len(row))
		}
		e := ManifestEntry{
			Source:      strings.TrimSpace(row[0]),
			URL:         strings.TrimSpace(row[1]),
			SHA256:      strings.ToLower(strings.TrimSpace(row[2])),
			ArchiveKind: strings.ToLower(strings.TrimSpace(row[3])),
			ExtractTo:   strings.TrimSpace(row[4]),
		}
		if e.Source == "" {
			return nil, fmt.Errorf("line %d: empty source", line)
		}
		if seen[e.Source] {
			return nil, fmt.Errorf("line %d: duplicate source %q", line, e.Source)
		}
		seen[e.Source] = true
		// Plain http would let anyone on the path swap a dataset for one
		// with different numbers; an unpinned row has no hash to catch it.
		if !strings.HasPrefix(e.URL, "https://") {
			return nil, fmt.Errorf("line %d: url must be https, got %q", line, e.URL)
		}
		if !archiveKinds[e.ArchiveKind] {
			return nil, fmt.Errorf("line %d: unknown archive_kind %q", line, e.ArchiveKind)
		}
		if e.SHA256 != Unpinned {
			if len(e.SHA256) != 64 || strings.Trim(e.SHA256, "0123456789abcdef") != "" {
				return nil, fmt.Errorf("line %d: sha256 must be 64 hex chars or %q", line, Unpinned)
			}
		}
		// extract_to is joined onto a work directory the caller supplies,
		// so it must be one ordinary directory name and nothing else.
		if e.ExtractTo == "" || e.ExtractTo != filepath.Base(e.ExtractTo) ||
			e.ExtractTo == "." || e.ExtractTo == ".." || strings.ContainsRune(e.ExtractTo, filepath.Separator) {
			return nil, fmt.Errorf("line %d: extract_to %q must be a single directory name", line, e.ExtractTo)
		}
		out = append(out, e)
	}
	return out, nil
}

// WriteFetchRecord records which archive was extracted into dir.
func WriteFetchRecord(dir string, e ManifestEntry) error {
	body := fmt.Sprintf("source=%s\nurl=%s\nsha256=%s\n", e.Source, e.URL, e.SHA256)
	return os.WriteFile(filepath.Join(dir, fetchRecordName), []byte(body), 0o644)
}

// ReadFetchRecord reads the breadcrumb fetch left in dir. ok is false when
// the directory was populated some other way — by hand, say.
func ReadFetchRecord(dir string) (ManifestEntry, bool, error) {
	b, err := os.ReadFile(filepath.Join(dir, fetchRecordName))
	if os.IsNotExist(err) {
		return ManifestEntry{}, false, nil
	}
	if err != nil {
		return ManifestEntry{}, false, err
	}
	var e ManifestEntry
	for _, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			return ManifestEntry{}, false, fmt.Errorf("%s: malformed line %q", fetchRecordName, line)
		}
		switch k {
		case "source":
			e.Source = v
		case "url":
			e.URL = v
		case "sha256":
			e.SHA256 = v
		default:
			return ManifestEntry{}, false, fmt.Errorf("%s: unknown key %q", fetchRecordName, k)
		}
	}
	if e.Source == "" || e.URL == "" {
		return ManifestEntry{}, false, fmt.Errorf("%s: incomplete record", fetchRecordName)
	}
	return e, true, nil
}
```

In `backend/internal/foodpack/format/pack.go`, add the checksum field to `SourceInfo`. Spec §3 asks the build to record per-source checksums alongside row counts and licences, and `SourceInfo` is where the other two already live:

```go
// SourceInfo records provenance and attribution for one dataset.
type SourceInfo struct {
	Source  string
	Region  string
	Licence string
	URL     string
	Rows    int
	// ArchiveSHA256 is the hash of the download this data came from, so a
	// pack can say which release of a dataset it holds. Empty when the
	// source directory was populated by hand rather than by `foodpack
	// fetch`. Appended rather than inserted: gob decodes by field name, so
	// an older pack simply leaves it empty.
	ArchiveSHA256 string
}
```

In `backend/internal/foodpack/source/embed.go`, widen the embed so the manifest travels with the binary:

```go
// MappingFS holds the checked-in, human-auditable nutrient mapping tables
// and the archive manifest. These are the files to open when a number looks
// wrong or a dataset has moved.
//
//go:embed all:mapping all:manifest
var MappingFS embed.FS
```

- [ ] **Step 5: Run it to confirm it passes**

Run: `cd backend && go test ./internal/foodpack/source/ -run 'Manifest|FetchRecord' -v`
Expected: PASS.

- [ ] **Step 6: Write the failing fetch test**

Create `backend/cmd/foodpack/fetch_test.go`:

```go
package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/boanntech/saolrian/backend/internal/foodpack/source"
)

// zipBytes builds an in-memory zip. Nested paths are deliberate: every
// real dataset zip puts its files under a release-named directory.
func zipBytes(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, body := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("zip create %s: %v", name, err)
		}
		if _, err := w.Write([]byte(body)); err != nil {
			t.Fatalf("zip write %s: %v", name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("zip close: %v", err)
	}
	return buf.Bytes()
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func TestFetchOneDownloadsAndExtractsZip(t *testing.T) {
	body := zipBytes(t, map[string]string{
		"CNF_2015/FOOD NAME.csv": "FoodID,FoodDescription\n1,Banana\n",
		"CNF_2015/NUTRIENT NAME.csv": "NutrientID,NutrientName\n208,ENERGY\n",
	})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(body)
	}))
	defer srv.Close()

	work := t.TempDir()
	e := source.ManifestEntry{
		Source: "cnf", URL: srv.URL + "/cnf.zip", SHA256: sha256Hex(body),
		ArchiveKind: "zip", ExtractTo: "cnf",
	}
	var out bytes.Buffer
	if err := fetchOne(context.Background(), srv.Client(), e, work, false, &out); err != nil {
		t.Fatalf("fetchOne: %v", err)
	}

	// Archive directory structure is flattened: adapters take a flat
	// directory of files, and the release-named wrapper directory changes
	// with every release.
	for _, name := range []string{"FOOD NAME.csv", "NUTRIENT NAME.csv"} {
		if _, err := os.Stat(filepath.Join(work, "cnf", name)); err != nil {
			t.Errorf("extracted file %s: %v", name, err)
		}
	}
	rec, ok, err := source.ReadFetchRecord(filepath.Join(work, "cnf"))
	if err != nil || !ok {
		t.Fatalf("ReadFetchRecord: %v, ok=%v", err, ok)
	}
	if rec.SHA256 != e.SHA256 {
		t.Errorf("record sha = %s, want %s", rec.SHA256, e.SHA256)
	}
}

// A pinned hash that does not match is the whole point of pinning: an
// upstream file changed under us and the numbers may have moved.
func TestFetchOneRejectsHashMismatch(t *testing.T) {
	body := zipBytes(t, map[string]string{"a/x.csv": "id\n1\n"})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(body)
	}))
	defer srv.Close()

	work := t.TempDir()
	e := source.ManifestEntry{
		Source: "cnf", URL: srv.URL + "/cnf.zip",
		SHA256:      "1111111111111111111111111111111111111111111111111111111111111111",
		ArchiveKind: "zip", ExtractTo: "cnf",
	}
	err := fetchOne(context.Background(), srv.Client(), e, work, false, &bytes.Buffer{})
	if err == nil {
		t.Fatal("want an error")
	}
	if !strings.Contains(err.Error(), sha256Hex(body)) {
		t.Errorf("error %q does not report the hash actually received", err)
	}
	if _, statErr := os.Stat(filepath.Join(work, "cnf", "x.csv")); statErr == nil {
		t.Error("a mismatched archive must not be extracted")
	}
}

// An unpinned row still downloads, but must print the hash to paste in.
func TestFetchOneReportsHashForUnpinned(t *testing.T) {
	body := zipBytes(t, map[string]string{"a/x.csv": "id\n1\n"})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(body)
	}))
	defer srv.Close()

	var out bytes.Buffer
	e := source.ManifestEntry{
		Source: "cnf", URL: srv.URL + "/cnf.zip", SHA256: source.Unpinned,
		ArchiveKind: "zip", ExtractTo: "cnf",
	}
	if err := fetchOne(context.Background(), srv.Client(), e, t.TempDir(), false, &out); err != nil {
		t.Fatalf("fetchOne: %v", err)
	}
	if !strings.Contains(out.String(), sha256Hex(body)) {
		t.Errorf("output does not offer the hash to pin:\n%s", out.String())
	}
}

// A 404 is the expected failure for these datasets, whose download URLs
// move. It must say where to put the file by hand.
func TestFetchOneOn404NamesTheManualPath(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	defer srv.Close()

	work := t.TempDir()
	e := source.ManifestEntry{
		Source: "cofid", URL: srv.URL + "/cofid.xlsx", SHA256: source.Unpinned,
		ArchiveKind: "xlsx", ExtractTo: "cofid",
	}
	err := fetchOne(context.Background(), srv.Client(), e, work, false, &bytes.Buffer{})
	if err == nil {
		t.Fatal("want an error")
	}
	if !strings.Contains(err.Error(), filepath.Join(work, "cofid")) {
		t.Errorf("error %q does not name the manual drop directory", err)
	}
}

// Zip slip: an entry named ../../etc/x must not escape the target
// directory. These archives come from the network.
func TestExtractZipRejectsPathEscape(t *testing.T) {
	body := zipBytes(t, map[string]string{"../escaped.csv": "id\n1\n"})
	dir := t.TempDir()
	archive := filepath.Join(dir, "a.zip")
	if err := os.WriteFile(archive, body, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := extractZip(archive, filepath.Join(dir, "out")); err == nil {
		t.Fatal("want an error for an entry that escapes the target directory")
	}
}

// Flattening two entries onto one name would silently keep whichever came
// last, which for a dataset is a different pack every run.
func TestExtractZipRejectsFlattenCollision(t *testing.T) {
	body := zipBytes(t, map[string]string{
		"a/food.csv": "id\n1\n",
		"b/food.csv": "id\n2\n",
	})
	dir := t.TempDir()
	archive := filepath.Join(dir, "a.zip")
	if err := os.WriteFile(archive, body, 0o644); err != nil {
		t.Fatal(err)
	}
	err := extractZip(archive, filepath.Join(dir, "out"))
	if err == nil || !strings.Contains(err.Error(), "food.csv") {
		t.Fatalf("err = %v, want a collision naming food.csv", err)
	}
}

func TestFetchOneCopiesBareFile(t *testing.T) {
	body := []byte("not really a spreadsheet")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(body)
	}))
	defer srv.Close()

	work := t.TempDir()
	e := source.ManifestEntry{
		Source: "afcd", URL: srv.URL + "/release2.xlsx", SHA256: sha256Hex(body),
		ArchiveKind: "xlsx", ExtractTo: "afcd",
	}
	if err := fetchOne(context.Background(), srv.Client(), e, work, false, &bytes.Buffer{}); err != nil {
		t.Fatalf("fetchOne: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(work, "afcd", "release2.xlsx"))
	if err != nil {
		t.Fatalf("read extracted file: %v", err)
	}
	if !bytes.Equal(got, body) {
		t.Error("copied file does not match what was served")
	}
}
```

- [ ] **Step 7: Run it to confirm it fails**

Run: `cd backend && go test ./cmd/foodpack/ -run 'Fetch|ExtractZip' -v`
Expected: FAIL — `undefined: fetchOne`, `undefined: extractZip`.

- [ ] **Step 8: Implement `fetch.go`**

Create `backend/cmd/foodpack/fetch.go`:

```go
package main

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/boanntech/saolrian/backend/internal/foodpack/source"
)

// fetchTimeout bounds one archive. The USDA SR Legacy zip is a few hundred
// megabytes over a slow link.
const fetchTimeout = 30 * time.Minute

func fetchCmd(args []string) error {
	fs := flag.NewFlagSet("fetch", flag.ExitOnError)
	work := fs.String("work", "", "work directory to download and extract into")
	only := fs.String("source", "", "comma-separated sources to fetch (default: all)")
	force := fs.Bool("force", false, "re-download even when the archive is already present and matches")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *work == "" {
		return fmt.Errorf("--work is required")
	}

	entries, err := source.LoadManifest()
	if err != nil {
		return err
	}
	want := map[string]bool{}
	for _, s := range strings.Split(*only, ",") {
		if s = strings.TrimSpace(s); s != "" {
			want[s] = true
		}
	}

	client := &http.Client{}

	var failed []string
	for _, e := range entries {
		if len(want) > 0 && !want[e.Source] {
			continue
		}
		fmt.Printf("== %s\n", e.Source)
		ctx, cancel := context.WithTimeout(context.Background(), fetchTimeout)
		err := fetchOne(ctx, client, e, *work, *force, os.Stdout)
		cancel()
		if err != nil {
			// One dataset moving must not stop the other four. Report at
			// the end so the operator fixes them in one sitting.
			fmt.Fprintf(os.Stderr, "   %v\n", err)
			failed = append(failed, e.Source)
		}
	}
	if len(failed) > 0 {
		return fmt.Errorf("%d source(s) failed: %s", len(failed), strings.Join(failed, ", "))
	}
	return nil
}

// fetchOne downloads, hashes and extracts one manifest entry.
func fetchOne(ctx context.Context, client *http.Client, e source.ManifestEntry, work string, force bool, out io.Writer) error {
	dest := filepath.Join(work, e.ExtractTo)
	archiveDir := filepath.Join(work, "_archives")
	if err := os.MkdirAll(archiveDir, 0o755); err != nil {
		return err
	}
	name := path.Base(e.URL)
	if name == "" || name == "." || name == "/" {
		name = e.Source
	}
	archive := filepath.Join(archiveDir, name)

	sum, err := hashFile(archive)
	switch {
	case err == nil && !force && e.SHA256 != source.Unpinned && sum == e.SHA256:
		fmt.Fprintf(out, "   cached %s\n", archive)
	default:
		sum, err = downloadTo(ctx, client, e.URL, archive)
		if err != nil {
			return fmt.Errorf("%s: %w\n   download it by hand and unpack it into %s",
				e.Source, err, dest)
		}
	}

	if e.SHA256 == source.Unpinned {
		fmt.Fprintf(out, "   UNPINNED — paste this into manifest/sources.csv: %s\n", sum)
	} else if sum != e.SHA256 {
		os.Remove(archive)
		return fmt.Errorf("%s: sha256 mismatch: manifest pins %s but %s served %s (upstream file changed; check the release notes before re-pinning)",
			e.Source, e.SHA256, e.URL, sum)
	}

	if err := os.RemoveAll(dest); err != nil {
		return err
	}
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}
	switch e.ArchiveKind {
	case "zip":
		if err := extractZip(archive, dest); err != nil {
			return fmt.Errorf("%s: %w", e.Source, err)
		}
	default: // xlsx, xml, csv — the download is the file
		if err := copyFile(archive, filepath.Join(dest, name)); err != nil {
			return fmt.Errorf("%s: %w", e.Source, err)
		}
	}

	rec := e
	rec.SHA256 = sum
	if err := source.WriteFetchRecord(dest, rec); err != nil {
		return err
	}
	fmt.Fprintf(out, "   ready %s\n", dest)
	return nil
}

// downloadTo streams url into dst, hashing as it goes, and returns the
// hex SHA-256. It writes through a temp file so a failed download never
// leaves a truncated archive that a later run would treat as cached.
func downloadTo(ctx context.Context, client *http.Client, url, dst string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("GET %s: %s", url, resp.Status)
	}

	tmp, err := os.CreateTemp(filepath.Dir(dst), filepath.Base(dst)+".part-*")
	if err != nil {
		return "", err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)

	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(tmp, h), resp.Body); err != nil {
		tmp.Close()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	if err := os.Rename(tmpPath, dst); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func hashFile(p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// extractZip unpacks archive into dest, flattening the release-named
// wrapper directory every dataset zip carries. Adapters take a flat
// directory, and the wrapper's name changes with every release.
func extractZip(archive, dest string) error {
	zr, err := zip.OpenReader(archive)
	if err != nil {
		return err
	}
	defer zr.Close()

	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}
	written := map[string]string{}
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		// These archives come off the network. Flattening to the base name
		// already defuses an entry named ../../x, but a traversal attempt
		// means the archive is not what it claims to be, so refuse the
		// whole thing rather than quietly unpacking the rest of it.
		if hasDotDot(f.Name) {
			return fmt.Errorf("zip entry %q escapes the target directory", f.Name)
		}
		base := filepath.Base(filepath.FromSlash(f.Name))
		if base == "." || base == ".." || base == "" {
			return fmt.Errorf("zip entry %q has no usable file name", f.Name)
		}
		if prev, dup := written[base]; dup {
			return fmt.Errorf("zip entries %q and %q both flatten to %q", prev, f.Name, base)
		}
		written[base] = f.Name

		if err := writeZipEntry(f, filepath.Join(dest, base)); err != nil {
			return err
		}
	}
	if len(written) == 0 {
		return fmt.Errorf("%s contains no files", filepath.Base(archive))
	}
	return nil
}

// hasDotDot reports a path traversal element, without tripping over an
// ordinary name like "foo..csv".
func hasDotDot(name string) bool {
	for _, part := range strings.Split(filepath.ToSlash(name), "/") {
		if part == ".." {
			return true
		}
	}
	return false
}

func writeZipEntry(f *zip.File, dst string) error {
	rc, err := f.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	w, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer w.Close()
	if _, err := io.Copy(w, rc); err != nil {
		return err
	}
	return w.Close()
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return out.Close()
}
```

- [ ] **Step 9: Run it to confirm it passes**

Run: `cd backend && go test ./cmd/foodpack/ -run 'Fetch|ExtractZip' -v`
Expected: PASS.

- [ ] **Step 10: Add the loader registry and `build --work`**

In `backend/cmd/foodpack/main.go`, add the registry above `buildCmd`. **Tasks 3–6 each add one entry here**; today only USDA exists:

```go
// sourceLoader runs one adapter over one extracted directory. The registry
// is keyed on the manifest's source column, so adding a dataset is a
// manifest row plus an entry here.
type sourceLoader func(dir string, sink source.UnmappedSink) ([]format.RefFood, []format.SourceInfo, error)

var loaders = map[string]sourceLoader{
	// Both USDA subtypes come from LoadUSDA; each archive extracts to its
	// own directory and the data_type column inside decides the subtype.
	"usda_foundation": loadUSDADir,
	"usda_sr":         loadUSDADir,
}

func loadUSDADir(dir string, sink source.UnmappedSink) ([]format.RefFood, []format.SourceInfo, error) {
	m, err := source.LoadNamedMapping("usda")
	if err != nil {
		return nil, nil, err
	}
	return source.LoadUSDA(source.USDAOptions{
		Dir:       dir,
		DataTypes: []string{"foundation_food", "sr_legacy_food"},
		Mapping:   m,
		Unmapped:  sink,
	})
}
```

Rewrite `buildCmd` to drive that registry. The per-source directory flags stay, so a test or a one-off can still point at an ad-hoc directory:

```go
func buildCmd(args []string) error {
	fs := flag.NewFlagSet("build", flag.ExitOnError)
	work := fs.String("work", "", "work directory populated by `foodpack fetch`")
	usdaDir := fs.String("usda", "", "directory of extracted USDA FDC CSVs (overrides --work)")
	version := fs.String("version", "", "pack version, e.g. 2026.09")
	out := fs.String("out", "", "output pack path")
	reportUnmapped := fs.Bool("report-unmapped", false, "list every source nutrient code no mapping table covers")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *version == "" || *out == "" {
		return fmt.Errorf("--version and --out are required")
	}
	if *work == "" && *usdaDir == "" {
		return fmt.Errorf("pass --work, or at least one per-source directory flag")
	}

	var sink source.UnmappedSink
	collector := source.NewUnmappedCollector()
	if *reportUnmapped {
		sink = collector.Note
	}

	pack := format.Pack{
		Version:      *version,
		BuiltAt:      time.Now().UTC(),
		NutrientKeys: food.Keys(),
	}

	dirs, err := resolveSourceDirs(*work, map[string]string{"usda_sr": *usdaDir})
	if err != nil {
		return err
	}
	rows := map[string]*format.SourceInfo{}
	var order []string
	seen := map[string]string{} // source\x00id -> the dir that produced it

	for _, d := range dirs {
		foods, sources, err := loaders[d.source](d.dir, sink)
		if err != nil {
			return fmt.Errorf("%s: %w", d.source, err)
		}
		for _, f := range foods {
			key := f.Source + "\x00" + f.SourceID
			if prev, dup := seen[key]; dup {
				return fmt.Errorf("%s/%s appears in both %s and %s; the work directory has an archive extracted twice",
					f.Source, f.SourceID, prev, d.dir)
			}
			seen[key] = d.dir
		}
		pack.Foods = append(pack.Foods, foods...)
		for _, s := range sources {
			if got, ok := rows[s.Source]; ok {
				got.Rows += s.Rows
				continue
			}
			cp := s
			// Spec §3 wants the build to record per-source checksums
			// alongside counts and licences. The adapter cannot know which
			// archive it was handed, so the hash is stamped here from the
			// breadcrumb fetch left behind.
			cp.ArchiveSHA256 = d.sha256
			rows[s.Source] = &cp
			order = append(order, s.Source)
		}
	}
	for _, name := range order {
		pack.Sources = append(pack.Sources, *rows[name])
		fmt.Printf("%s: %d foods\n", name, rows[name].Rows)
	}

	if len(pack.Foods) == 0 {
		return fmt.Errorf("no sources produced any foods; pass at least one source directory")
	}

	if *reportUnmapped {
		fmt.Println()
		fmt.Println(collector.Report())
	}

	size, err := writePackAtomically(*out, pack)
	if err != nil {
		return err
	}
	fmt.Printf("wrote %s: %d foods, %.1f MB\n", *out, len(pack.Foods), float64(size)/(1<<20))
	return nil
}

type sourceDir struct {
	source string
	dir    string
	sha256 string // the archive this directory was extracted from, if known
}

// resolveSourceDirs turns a work directory plus any explicit overrides into
// the list of (source, directory) pairs to load, in manifest order. A
// source whose directory is absent is skipped: building a US-only pack
// while the French download is still running has to stay possible.
func resolveSourceDirs(work string, overrides map[string]string) ([]sourceDir, error) {
	entries, err := source.LoadManifest()
	if err != nil {
		return nil, err
	}
	var out []sourceDir
	for _, e := range entries {
		loader, known := loaders[e.Source]
		if !known || loader == nil {
			continue // manifest row for an adapter this build does not have yet
		}
		dir := overrides[e.Source]
		if dir == "" && work != "" {
			candidate := filepath.Join(work, e.ExtractTo)
			if st, err := os.Stat(candidate); err == nil && st.IsDir() {
				dir = candidate
				if err := checkFetchRecord(candidate, e); err != nil {
					return nil, err
				}
			}
		}
		if dir == "" {
			continue
		}
		sha := ""
		if rec, ok, err := source.ReadFetchRecord(dir); err == nil && ok {
			sha = rec.SHA256
		}
		out = append(out, sourceDir{source: e.Source, dir: dir, sha256: sha})
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no source directories found; run `foodpack fetch --work <dir>` first")
	}
	return out, nil
}

// checkFetchRecord catches a manifest re-pinned without a re-fetch: the
// directory then holds the old dataset while the manifest claims the new
// one, and nothing else would notice.
func checkFetchRecord(dir string, e source.ManifestEntry) error {
	rec, ok, err := source.ReadFetchRecord(dir)
	if err != nil {
		return err
	}
	if !ok {
		fmt.Fprintf(os.Stderr, "warning: %s was not populated by `foodpack fetch`; its provenance is unrecorded\n", dir)
		return nil
	}
	if e.SHA256 != source.Unpinned && rec.SHA256 != e.SHA256 {
		return fmt.Errorf("%s holds the archive %s but the manifest now pins %s; re-run `foodpack fetch --source %s`",
			dir, rec.SHA256, e.SHA256, e.Source)
	}
	return nil
}
```

Add `fetch` to the subcommand switch in `main`, and update the usage lines in the package comment:

```go
//	foodpack fetch  --work ./work
//	foodpack build  --work ./work --version 2026.09 --out ./pack.bin.zst
//	foodpack verify --pack ./pack.bin.zst
```

```go
	case "fetch":
		err = fetchCmd(os.Args[2:])
```

and

```go
		fmt.Fprintln(os.Stderr, "usage: foodpack <fetch|build|verify> [flags]")
```

New imports in `main.go`: `path/filepath` and `os` are already there; nothing else is needed.

- [ ] **Step 11: Extend the CLI test for `--work`**

Append to `backend/cmd/foodpack/main_test.go`:

```go
// A work directory laid out the way fetch leaves it must build without any
// per-source flags — that is the whole point of the manifest.
func TestBuildFromWorkDirectory(t *testing.T) {
	work := t.TempDir()
	usda := filepath.Join(work, "usda_sr")
	if err := os.MkdirAll(usda, 0o755); err != nil {
		t.Fatal(err)
	}
	copyTestdataUSDA(t, usda)
	if err := source.WriteFetchRecord(usda, source.ManifestEntry{
		Source: "usda_sr", URL: "https://example.test/sr.zip", SHA256: source.Unpinned,
	}); err != nil {
		t.Fatal(err)
	}

	out := filepath.Join(t.TempDir(), "pack.bin.zst")
	if err := buildCmd([]string{"--work", work, "--version", "test", "--out", out}); err != nil {
		t.Fatalf("buildCmd: %v", err)
	}
	f, err := os.Open(out)
	if err != nil {
		t.Fatalf("open pack: %v", err)
	}
	defer f.Close()
	p, err := format.Read(f)
	if err != nil {
		t.Fatalf("format.Read: %v", err)
	}
	if len(p.Foods) == 0 {
		t.Error("built pack has no foods")
	}
}

// A work directory with nothing in it must say what to do, not produce an
// empty pack.
func TestBuildFromEmptyWorkDirectory(t *testing.T) {
	out := filepath.Join(t.TempDir(), "pack.bin.zst")
	err := buildCmd([]string{"--work", t.TempDir(), "--version", "test", "--out", out})
	if err == nil || !strings.Contains(err.Error(), "foodpack fetch") {
		t.Fatalf("err = %v, want a message pointing at foodpack fetch", err)
	}
}

// copyTestdataUSDA copies the Plan 1 USDA fixture CSVs into dir.
func copyTestdataUSDA(t *testing.T, dir string) {
	t.Helper()
	src := filepath.Join("..", "..", "internal", "foodpack", "source", "testdata", "usda")
	names, err := os.ReadDir(src)
	if err != nil {
		t.Fatalf("read fixture dir: %v", err)
	}
	for _, n := range names {
		b, err := os.ReadFile(filepath.Join(src, n.Name()))
		if err != nil {
			t.Fatalf("read %s: %v", n.Name(), err)
		}
		if err := os.WriteFile(filepath.Join(dir, n.Name()), b, 0o644); err != nil {
			t.Fatalf("write %s: %v", n.Name(), err)
		}
	}
}
```

Add whatever of `os`, `strings`, `path/filepath`, `format` and `source` the existing `main_test.go` imports do not already cover.

- [ ] **Step 12: Run every test**

Run: `cd backend && go test ./... && go vet ./... && gofmt -l .`
Expected: PASS, no vet output, no unformatted files.

- [ ] **Step 13: Commit**

```bash
cd /home/slynch/code/saolrian
git add backend/internal/foodpack/source/ backend/cmd/foodpack/
git commit -m "feat(foodpack): pinned fetch manifest, foodpack fetch, build --work

Five sources across three formats is past the point where 'download
these and put them somewhere' works. sources.csv pins a URL, SHA-256,
archive kind and target directory per archive; foodpack fetch downloads,
hashes, flattens and extracts them; build --work finds every source from
one directory via a loader registry that Tasks 3-6 extend a line at a
time.

Every row ships sha256=unpinned for now. fetch downloads an unpinned row
and prints the hash to paste in; a pinned mismatch is fatal and names
both hashes. Task 8 pins all six against the real downloads.

The two USDA archives extract to separate directories: each carries its
own food.csv, so Plan 1's suggestion to unpack both into ./work/usda
would have had the second overwrite the first.

Fetch failures are per-source and reported at the end, because these
four national sites move their downloads and fixing them one build at a
time is the slow way. Every failure names the directory to drop the file
into by hand.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Canadian Nutrient File adapter

CNF is the other clean multi-file CSV join, and it reuses USDA's nutrient numbering, so this is the cheapest of the four and the one that proves the Task 1 toolkit before the awkward formats arrive.

Two CNF-specific facts drive the code. Its conversion factors are **multipliers on 100 g**, so a factor of `1.18` means 118 g, not 1.18 g — getting that wrong silently scales every portion by 100. And its CSV export is Windows-1252 with a BOM, which Task 1's `eachCSVRow` already absorbs.

**Files:**
- Create: `backend/internal/foodpack/source/cnf.go`
- Create: `backend/internal/foodpack/source/mapping/cnf.csv`
- Test: `backend/internal/foodpack/source/cnf_test.go`
- Create: `backend/internal/foodpack/source/testdata/cnf/FOOD NAME.csv`
- Create: `backend/internal/foodpack/source/testdata/cnf/NUTRIENT NAME.csv`
- Create: `backend/internal/foodpack/source/testdata/cnf/NUTRIENT AMOUNT.csv`
- Create: `backend/internal/foodpack/source/testdata/cnf/CONVERSION FACTOR.csv`
- Create: `backend/internal/foodpack/source/testdata/cnf/MEASURE NAME.csv`
- Modify: `backend/internal/foodpack/source/mapping_files_test.go` (add `cnf`)
- Modify: `backend/cmd/foodpack/main.go` (register `cnf` in `loaders`)

**Interfaces:**
- Consumes: `eachCSVRow`, `ValueSyntax`, `NewBuilder`, `FoodInput`, `UnmappedSink`, `noteUnmapped` (Task 1); `Mapping` (Plan 1 Task 4); `loaders` (Task 2).
- Produces: `source.SourceCNF` (`= "cnf"`); `source.CNFOptions{Dir string; Mapping *Mapping; Unmapped UnmappedSink}`; `source.LoadCNF(CNFOptions) ([]format.RefFood, []format.SourceInfo, error)`.

- [ ] **Step 1: Write the fixture files**

Create `backend/internal/foodpack/source/testdata/cnf/FOOD NAME.csv`:

```csv
FoodID,FoodCode,FoodGroupID,FoodSourceID,FoodDescription,FoodDescriptionF
2,2,9,3,"Banana, raw","Banane, crue"
14,14,1,3,"Milk, fluid, whole, 3.25% M.F.","Lait, fluide, entier, 3,25 % M.G."
99,99,9,3,"Ghost food, no data","Aliment fantôme"
```

Create `backend/internal/foodpack/source/testdata/cnf/NUTRIENT NAME.csv`:

```csv
NutrientID,NutrientCode,NutrientSymbol,NutrientUnit,NutrientName,NutrientNameF,Tagname,NutrientDecimals
203,203,PROT,g,PROTEIN,PROTÉINES,PROCNT,2
204,204,FAT,g,"FAT, TOTAL (LIPIDS)","LIPIDES, TOTAL",FAT,2
205,205,CARB,g,"CARBOHYDRATE, TOTAL (BY DIFFERENCE)",GLUCIDES,CHOCDF,2
208,208,KCAL,kcal,ENERGY (KILOCALORIES),ÉNERGIE (KILOCALORIES),ENERC_KCAL,0
268,268,KJ,kJ,ENERGY (KILOJOULES),ÉNERGIE (KILOJOULES),ENERC_KJ,0
291,291,FIBTG,g,"FIBRE, TOTAL DIETARY",FIBRES,FIBTG,2
301,301,CA,mg,CALCIUM,CALCIUM,CA,0
303,303,FE,mg,IRON,FER,FE,2
317,317,SE,µg,SELENIUM,SÉLÉNIUM,SE,1
9999,9999,ZZZ,g,SOMETHING NEW,QUELQUE CHOSE,ZZZ,2
```

Create `backend/internal/foodpack/source/testdata/cnf/NUTRIENT AMOUNT.csv`:

```csv
FoodID,NutrientID,NutrientValue,StandardError,NumberofObservations,NutrientSourceID,NutrientDateOfEntry
2,208,89,,,4,2015-01-01
2,203,1.09,,,4,2015-01-01
2,204,0.33,,,4,2015-01-01
2,205,22.84,,,4,2015-01-01
2,291,2.6,,,4,2015-01-01
2,303,0.26,,,4,2015-01-01
2,317,1.0,,,4,2015-01-01
2,268,371,,,4,2015-01-01
2,9999,7.7,,,4,2015-01-01
14,208,61,,,4,2015-01-01
14,203,3.15,,,4,2015-01-01
14,204,3.25,,,4,2015-01-01
14,205,4.8,,,4,2015-01-01
14,301,113,,,4,2015-01-01
```

Create `backend/internal/foodpack/source/testdata/cnf/CONVERSION FACTOR.csv`:

```csv
FoodID,MeasureID,ConversionFactorValue,ConvFactorDateOfEntry
2,341,1.18,2015-01-01
2,1155,1.5,2015-01-01
14,449,2.58,2015-01-01
```

Create `backend/internal/foodpack/source/testdata/cnf/MEASURE NAME.csv`:

```csv
MeasureID,MeasureDescription,MeasureDescriptionF
341,"1 medium (7 to 7-7/8 long)","1 moyenne"
1155,"250ml","250ml"
449,"250ml","250ml"
```

- [ ] **Step 2: Write the failing adapter test**

Create `backend/internal/foodpack/source/cnf_test.go`:

```go
package source

import (
	"errors"
	"math"
	"strings"
	"testing"

	"github.com/boanntech/saolrian/backend/internal/food"
	"github.com/boanntech/saolrian/backend/internal/foodpack/format"
)

const cnfTestMapping = `source_code,canonical_key,factor,note
208,energy_kcal,1,ENERGY (KILOCALORIES)
203,protein,1,PROTEIN
204,fat,1,FAT
205,carbohydrate,1,CARBOHYDRATE
291,fibre,1,FIBRE
301,calcium,1,CALCIUM
303,iron,1,IRON
317,selenium,1,SELENIUM
268,-,1,ENERGY (KILOJOULES); superseded by 208
`

func loadCNFFixture(t *testing.T, mappingCSV string) ([]format.RefFood, []format.SourceInfo) {
	t.Helper()
	m, err := LoadMapping(strings.NewReader(mappingCSV))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	foods, sources, err := LoadCNF(CNFOptions{Dir: "testdata/cnf", Mapping: m})
	if err != nil {
		t.Fatalf("LoadCNF: %v", err)
	}
	return foods, sources
}

func findByName(t *testing.T, foods []format.RefFood, substr string) format.RefFood {
	t.Helper()
	for _, f := range foods {
		if strings.Contains(f.Name, substr) {
			return f
		}
	}
	t.Fatalf("no food whose name contains %q; got %d foods", substr, len(foods))
	return format.RefFood{}
}

func TestLoadCNFReadsNutrients(t *testing.T) {
	foods, sources := loadCNFFixture(t, cnfTestMapping)

	// The ghost food has no nutrient rows at all and must not ship.
	if len(foods) != 2 {
		t.Fatalf("got %d foods, want 2 (the food with no data is dropped)", len(foods))
	}
	banana := findByName(t, foods, "Banana")
	if banana.Source != SourceCNF || banana.Region != "ca" || banana.Licence == "" {
		t.Errorf("provenance = %+v", banana)
	}
	prof := food.Decode(banana.Nutrients)
	for key, want := range map[string]float64{
		"energy_kcal": 89, "protein": 1.09, "fat": 0.33,
		"carbohydrate": 22.84, "fibre": 2.6, "iron": 0.26, "selenium": 1.0,
	} {
		if got := prof[key]; math.Abs(got-want) > 1e-6 {
			t.Errorf("%s = %v, want %v", key, got, want)
		}
	}

	if len(sources) != 1 || sources[0].Source != SourceCNF || sources[0].Rows != 2 {
		t.Errorf("sources = %+v, want one cnf row with Rows=2", sources)
	}
	if sources[0].URL == "" {
		t.Error("SourceInfo has no attribution URL; CNF is OGL-Canada and requires attribution")
	}
}

// CNF conversion factors multiply the per-100g figures, so grams are
// factor*100. Reading 1.18 as 1.18 g makes every portion a rounding error.
func TestLoadCNFConvertsPortionsToGrams(t *testing.T) {
	foods, _ := loadCNFFixture(t, cnfTestMapping)
	banana := findByName(t, foods, "Banana")

	if len(banana.Portions) != 2 {
		t.Fatalf("got %d portions, want 2", len(banana.Portions))
	}
	if got := banana.Portions[0].Grams; math.Abs(got-118) > 1e-6 {
		t.Errorf("first portion = %v g, want 118", got)
	}
	if !strings.Contains(banana.Portions[0].Label, "1 medium") {
		t.Errorf("portion label = %q", banana.Portions[0].Label)
	}
	if math.Abs(banana.DefaultServingG-118) > 1e-6 {
		t.Errorf("DefaultServingG = %v, want 118", banana.DefaultServingG)
	}
}

// The French name is not displayed but must stay searchable: a bilingual
// dataset that only answers to English throws away half of what it knows.
func TestLoadCNFKeepsFrenchNameSearchable(t *testing.T) {
	foods, _ := loadCNFFixture(t, cnfTestMapping)
	banana := findByName(t, foods, "Banana")
	if !strings.Contains(banana.SearchText, "banane") {
		t.Errorf("SearchText %q does not include the French name", banana.SearchText)
	}
	if strings.Contains(banana.Name, "Banane") {
		t.Errorf("Name %q should be the English description only", banana.Name)
	}
}

// A mapping row for a nutrient CNF does not define is a stale table that
// would silently drop the nutrient.
func TestLoadCNFRejectsStaleMapping(t *testing.T) {
	m, err := LoadMapping(strings.NewReader(cnfTestMapping + "1234,biotin,1,not in CNF\n"))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	_, _, err = LoadCNF(CNFOptions{Dir: "testdata/cnf", Mapping: m})
	if !errors.Is(err, ErrMappingNotInSource) {
		t.Fatalf("err = %v, want ErrMappingNotInSource", err)
	}
}

// A factor of 1 asserts the source already reports the canonical unit. If
// it does not, the factor is wrong and the values are off by 1000x.
func TestLoadCNFRejectsUnitDisagreement(t *testing.T) {
	// 317 SELENIUM is µg in CNF; claiming it as mg with factor 1 is the
	// classic 1000x error.
	bad := strings.Replace(cnfTestMapping, "317,selenium,1,SELENIUM", "317,iodine,1,wrong unit", 1)
	bad = strings.Replace(bad, "303,iron,1,IRON", "303,-,1,ignored\n", 1)
	m, err := LoadMapping(strings.NewReader(bad))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	_, _, err = LoadCNF(CNFOptions{Dir: "testdata/cnf", Mapping: m})
	if err == nil || !strings.Contains(err.Error(), "317") {
		t.Fatalf("err = %v, want a unit complaint naming 317", err)
	}
}

// Whoever writes the mapping table needs the list of what they have not
// covered; the dataset is the only authority on that.
func TestLoadCNFReportsUnmappedCodes(t *testing.T) {
	m, err := LoadMapping(strings.NewReader(cnfTestMapping))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	c := NewUnmappedCollector()
	if _, _, err := LoadCNF(CNFOptions{Dir: "testdata/cnf", Mapping: m, Unmapped: c.Note}); err != nil {
		t.Fatalf("LoadCNF: %v", err)
	}
	rep := c.Report()
	if !strings.Contains(rep, "9999") || !strings.Contains(rep, "SOMETHING NEW") {
		t.Errorf("report does not name the unmapped nutrient:\n%s", rep)
	}
	// 268 is explicitly ignored, not unmapped; conflating the two makes the
	// report useless.
	if strings.Contains(rep, "268") {
		t.Errorf("an explicitly ignored code must not be reported as unmapped:\n%s", rep)
	}
}
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `cd backend && go test ./internal/foodpack/source/ -run CNF -v`
Expected: FAIL — `undefined: LoadCNF`, `undefined: CNFOptions`, `undefined: SourceCNF`.

- [ ] **Step 4: Implement `cnf.go`**

Create `backend/internal/foodpack/source/cnf.go`. The `unitMatches` helper at the bottom goes into `value.go` alongside `ValueSyntax`, not into `cnf.go` — CIQUAL and both spreadsheet adapters need it too, and `food` must be imported there for it:

```go
package source

import (
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/boanntech/saolrian/backend/internal/food"
	"github.com/boanntech/saolrian/backend/internal/foodpack/format"
)

// SourceCNF is the Canadian Nutrient File's source value in food_ref.
const SourceCNF = "cnf"

const (
	cnfLicence = "ogl-canada"
	cnfRegion  = "ca"
	cnfURL     = "https://food-nutrition.canada.ca/cnf-fce/"
)

// cnfValues: CNF leaves an unmeasured nutrient's row out of NUTRIENT
// AMOUNT.csv entirely rather than writing a sentinel, so a blank cell is
// the only gap spelling it uses.
var cnfValues = ValueSyntax{Absent: []string{"NA"}}

// CNFOptions configures the Canadian Nutrient File adapter.
type CNFOptions struct {
	Dir      string // directory of extracted CNF CSVs
	Mapping  *Mapping
	Unmapped UnmappedSink
}

type cnfNutrient struct {
	name string
	unit string
}

type cnfFood struct {
	name   string
	nameFr string
}

// LoadCNF reads the Canadian Nutrient File CSV export.
func LoadCNF(o CNFOptions) ([]format.RefFood, []format.SourceInfo, error) {
	if o.Mapping == nil {
		return nil, nil, errors.New("cnf: mapping is required")
	}

	nutrients, err := cnfNutrients(o.Dir)
	if err != nil {
		return nil, nil, err
	}
	if err := cnfCheckMapping(o.Mapping, nutrients); err != nil {
		return nil, nil, err
	}

	foods, order, err := cnfFoods(o.Dir)
	if err != nil {
		return nil, nil, err
	}

	profiles := map[string]food.Profile{}
	err = eachCSVRow(filepath.Join(o.Dir, "NUTRIENT AMOUNT.csv"),
		[]string{"FoodID", "NutrientID", "NutrientValue"},
		func(get func(string) string) error {
			id := strings.TrimSpace(get("FoodID"))
			if _, ok := foods[id]; !ok {
				return nil
			}
			code := strings.TrimSpace(get("NutrientID"))
			n, known := nutrients[code]
			if !known {
				return nil // a nutrient this release's name table does not define
			}
			value, present, err := cnfValues.Parse(get("NutrientValue"))
			if err != nil {
				return fmt.Errorf("food %s nutrient %s: %w", id, code, err)
			}
			if !present {
				return nil
			}
			key, out, ok := o.Mapping.Apply(code, value)
			if !ok {
				if !o.Mapping.Known(code) {
					noteUnmapped(o.Unmapped, code, n.name)
				}
				return nil
			}
			if profiles[id] == nil {
				profiles[id] = food.Profile{}
			}
			profiles[id][key] = out
			return nil
		})
	if err != nil {
		return nil, nil, fmt.Errorf("cnf: %w", err)
	}

	portions, err := cnfPortions(o.Dir, foods)
	if err != nil {
		return nil, nil, fmt.Errorf("cnf: %w", err)
	}

	b := NewBuilder()
	for _, id := range order {
		f := foods[id]
		b.Add(FoodInput{
			Source:      SourceCNF,
			SourceID:    id,
			Region:      cnfRegion,
			Licence:     cnfLicence,
			Name:        f.name,
			SearchExtra: f.nameFr,
			Profile:     profiles[id],
			Portions:    portions[id],
		})
	}
	if err := b.Err("cnf"); err != nil {
		return nil, nil, err
	}

	rows := b.Rows()[SourceCNF]
	if rows == 0 {
		return b.Foods(), nil, nil
	}
	return b.Foods(), []format.SourceInfo{{
		Source: SourceCNF, Region: cnfRegion, Licence: cnfLicence,
		URL: cnfURL, Rows: rows,
	}}, nil
}

func cnfNutrients(dir string) (map[string]cnfNutrient, error) {
	out := map[string]cnfNutrient{}
	err := eachCSVRow(filepath.Join(dir, "NUTRIENT NAME.csv"),
		[]string{"NutrientID", "NutrientUnit", "NutrientName"},
		func(get func(string) string) error {
			id := strings.TrimSpace(get("NutrientID"))
			if id == "" {
				return nil
			}
			out[id] = cnfNutrient{
				name: strings.TrimSpace(get("NutrientName")),
				unit: strings.ToLower(strings.TrimSpace(get("NutrientUnit"))),
			}
			return nil
		})
	if err != nil {
		return nil, fmt.Errorf("cnf: %w", err)
	}
	return out, nil
}

// cnfCheckMapping fails the build when the mapping is stale or a factor of
// 1 disagrees with the unit CNF declares.
func cnfCheckMapping(m *Mapping, nutrients map[string]cnfNutrient) error {
	for _, code := range m.Codes() {
		unit, mapped := m.UnitFor(code)
		if !mapped {
			continue // explicitly ignored codes need not exist
		}
		n, present := nutrients[code]
		if !present {
			return fmt.Errorf("cnf: %w: NutrientID %s", ErrMappingNotInSource, code)
		}
		factor, _ := m.FactorFor(code)
		if factor != 1 {
			// The mapping deliberately converts; the factor is the
			// human-audited assertion and the units are expected to differ.
			continue
		}
		if !unitMatches(unit, n.unit) {
			return fmt.Errorf("cnf NutrientID %s (%s): source unit %q but canonical unit is %q; check the factor in mapping/cnf.csv",
				code, n.name, n.unit, unit)
		}
	}
	return nil
}

// unitMatches accepts a dataset's spellings of a canonical unit. µg appears
// as the micro sign, the Greek mu, "ug" or "mcg" depending on the source,
// its release and its encoding.
//
// Lives in value.go rather than here: CIQUAL and the two spreadsheet
// adapters need the same table.
func unitMatches(canonical food.Unit, sourceUnit string) bool {
	var accept []string
	switch canonical {
	case food.UnitKcal:
		accept = []string{"kcal"}
	case food.UnitG:
		accept = []string{"g"}
	case food.UnitMg:
		accept = []string{"mg"}
	case food.UnitUg:
		accept = []string{"µg", "μg", "ug", "mcg"}
	default:
		return true // an unknown canonical unit is not this check's business
	}
	for _, a := range accept {
		if sourceUnit == a {
			return true
		}
	}
	return false
}

func cnfFoods(dir string) (map[string]cnfFood, []string, error) {
	foods := map[string]cnfFood{}
	var order []string
	err := eachCSVRow(filepath.Join(dir, "FOOD NAME.csv"),
		[]string{"FoodID", "FoodDescription"},
		func(get func(string) string) error {
			id := strings.TrimSpace(get("FoodID"))
			name := strings.TrimSpace(get("FoodDescription"))
			if id == "" || name == "" {
				return nil
			}
			if _, seen := foods[id]; seen {
				return nil // first row wins, as in usdaFoods
			}
			foods[id] = cnfFood{name: name, nameFr: strings.TrimSpace(get("FoodDescriptionF"))}
			order = append(order, id)
			return nil
		})
	if err != nil {
		return nil, nil, fmt.Errorf("cnf: %w", err)
	}
	return foods, order, nil
}

// cnfPortions joins CONVERSION FACTOR to MEASURE NAME.
//
// ConversionFactorValue multiplies the per-100g figures, so the measure
// weighs factor*100 grams. Treating it as grams directly turns "1 medium
// banana" into 1.18 g.
func cnfPortions(dir string, foods map[string]cnfFood) (map[string][]format.Portion, error) {
	measures := map[string]string{}
	if err := eachCSVRow(filepath.Join(dir, "MEASURE NAME.csv"),
		[]string{"MeasureID", "MeasureDescription"},
		func(get func(string) string) error {
			measures[strings.TrimSpace(get("MeasureID"))] = strings.TrimSpace(get("MeasureDescription"))
			return nil
		}); err != nil {
		return nil, err
	}

	type measured struct {
		id string
		p  format.Portion
	}
	acc := map[string][]measured{}
	err := eachCSVRow(filepath.Join(dir, "CONVERSION FACTOR.csv"),
		[]string{"FoodID", "MeasureID", "ConversionFactorValue"},
		func(get func(string) string) error {
			id := strings.TrimSpace(get("FoodID"))
			if _, ok := foods[id]; !ok {
				return nil
			}
			measureID := strings.TrimSpace(get("MeasureID"))
			label := measures[measureID]
			if label == "" {
				return nil
			}
			factor, err := strconv.ParseFloat(strings.TrimSpace(get("ConversionFactorValue")), 64)
			if err != nil || factor <= 0 {
				return nil
			}
			acc[id] = append(acc[id], measured{
				id: measureID,
				p:  format.Portion{Label: label, Grams: factor * 100},
			})
			return nil
		})
	if err != nil {
		return nil, err
	}

	// CNF has no sequence column, so order by MeasureID to keep two builds
	// of the same archive byte-identical.
	out := make(map[string][]format.Portion, len(acc))
	for id, ms := range acc {
		sort.SliceStable(ms, func(i, j int) bool {
			a, _ := strconv.Atoi(ms[i].id)
			b, _ := strconv.Atoi(ms[j].id)
			return a < b
		})
		list := make([]format.Portion, 0, len(ms))
		for _, m := range ms {
			list = append(list, m.p)
		}
		out[id] = list
	}
	return out, nil
}
```

- [ ] **Step 5: Run it to confirm it passes**

Run: `cd backend && go test ./internal/foodpack/source/ -run CNF -v`
Expected: PASS.

- [ ] **Step 6: Write the checked-in mapping table**

Create `backend/internal/foodpack/source/mapping/cnf.csv`. CNF reuses USDA's nutrient numbering, which is why these codes look familiar; the `-` rows are the near-duplicates that would otherwise fight over a canonical key:

```csv
source_code,canonical_key,factor,note
208,energy_kcal,1,ENERGY (KILOCALORIES)
203,protein,1,PROTEIN
204,fat,1,"FAT, TOTAL (LIPIDS)"
205,carbohydrate,1,"CARBOHYDRATE, TOTAL (BY DIFFERENCE)"
291,fibre,1,"FIBRE, TOTAL DIETARY"
269,sugars,1,"SUGARS, TOTAL"
209,starch,1,STARCH
606,fat_saturated,1,"FATTY ACIDS, SATURATED, TOTAL"
645,fat_monounsaturated,1,"FATTY ACIDS, MONOUNSATURATED, TOTAL"
646,fat_polyunsaturated,1,"FATTY ACIDS, POLYUNSATURATED, TOTAL"
605,fat_trans,1,"FATTY ACIDS, TRANS, TOTAL"
601,cholesterol,1,CHOLESTEROL (mg)
221,alcohol,1,ALCOHOL
255,water,1,MOISTURE
207,ash,1,ASH
307,sodium,1,SODIUM (mg)
306,potassium,1,POTASSIUM (mg)
301,calcium,1,CALCIUM (mg)
304,magnesium,1,MAGNESIUM (mg)
305,phosphorus,1,PHOSPHORUS (mg)
303,iron,1,IRON (mg)
309,zinc,1,ZINC (mg)
312,copper,1,COPPER (mg)
315,manganese,1,MANGANESE (mg)
317,selenium,1,SELENIUM (ug)
320,vitamin_a_rae,1,"VITAMIN A, RAE (ug)"
319,retinol,1,RETINOL (ug)
321,carotene_beta,1,"BETA CAROTENE (ug)"
328,vitamin_d,1,VITAMIN D (ug)
323,vitamin_e,1,"VITAMIN E (ALPHA-TOCOPHEROL) (mg)"
430,vitamin_k,1,VITAMIN K (ug)
401,vitamin_c,1,VITAMIN C (mg)
404,thiamin,1,THIAMIN (mg)
405,riboflavin,1,RIBOFLAVIN (mg)
406,niacin,1,"NIACIN (PREFORMED) (mg)"
415,vitamin_b6,1,VITAMIN B-6 (mg)
417,folate,1,"FOLATE, TOTAL (ug)"
418,vitamin_b12,1,VITAMIN B-12 (ug)
410,pantothenate,1,PANTOTHENIC ACID (mg)
268,-,1,ENERGY (KILOJOULES); superseded by 208 kcal
318,-,1,VITAMIN A (IU); superseded by 320 RAE
324,-,1,VITAMIN D (IU); superseded by 328 ug
409,-,1,NIACIN EQUIVALENT; superseded by 406 preformed
435,-,1,"FOLATE, DFE; superseded by 417 total"
431,-,1,FOLIC ACID; a component of 417
432,-,1,"FOLATE, FOOD; a component of 417"
```

Every code here is asserted against the real dataset by `cnfCheckMapping`: a wrong `NutrientID` fails the build with `ErrMappingNotInSource` rather than silently dropping the nutrient. Task 8 runs that assertion against the real download and `--report-unmapped` fills in whatever CNF has that this table does not.

- [ ] **Step 7: Extend the checked-in-mappings test**

In `backend/internal/foodpack/source/mapping_files_test.go`, change the loop to cover both tables:

```go
func TestCheckedInMappingsLoad(t *testing.T) {
	for _, name := range []string{"usda", "cnf"} {
```

- [ ] **Step 8: Register CNF in the build**

In `backend/cmd/foodpack/main.go`, add to `loaders`:

```go
	"cnf": loadCNFDir,
```

and:

```go
func loadCNFDir(dir string, sink source.UnmappedSink) ([]format.RefFood, []format.SourceInfo, error) {
	m, err := source.LoadNamedMapping("cnf")
	if err != nil {
		return nil, nil, err
	}
	return source.LoadCNF(source.CNFOptions{Dir: dir, Mapping: m, Unmapped: sink})
}
```

- [ ] **Step 9: Run every test**

Run: `cd backend && go test ./... && go vet ./... && gofmt -l .`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
cd /home/slynch/code/saolrian
git add backend/internal/foodpack/source/ backend/cmd/foodpack/main.go
git commit -m "feat(foodpack): Canadian Nutrient File adapter

CNF reuses USDA's nutrient numbering, so the mapping table is largely
familiar and the join is the same shape: food x amount x nutrient name,
portions from conversion factor x measure name.

The one trap is the conversion factor, which multiplies the per-100g
figures rather than naming grams: 1.18 means a 118 g banana, and reading
it literally would make every CNF portion a rounding error. Portions sort
by MeasureID because CNF publishes no sequence column and map order would
otherwise vary the pack between builds of the same archive.

French descriptions go into search_text but not into the displayed name,
so a bilingual dataset stays findable in both languages without showing
two names.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: CIQUAL adapter

CIQUAL is XML, French, and writes its numbers with decimal commas and in-band sentinels — the first real customer for `ValueSyntax`. It also publishes both French and English food names, so it is the first source where `Name` and `SearchExtra` differ in a way a user will notice.

The XML layout has moved between releases: some ship one file with `<COMPO>` nested inside each `<ALIM>`, others ship `alim`, `compo` and `const` as three sibling files. Rather than bet on one, the adapter streams every `*.xml` in the directory and accumulates `ALIM`, `COMPO` and `CONST` elements wherever it finds them. That is less code than a layout-specific parser, not more.

**Files:**
- Create: `backend/internal/foodpack/source/ciqual.go`
- Create: `backend/internal/foodpack/source/mapping/ciqual.csv`
- Test: `backend/internal/foodpack/source/ciqual_test.go`
- Create: `backend/internal/foodpack/source/testdata/ciqual/ciqual.xml`
- Modify: `backend/internal/foodpack/source/mapping_files_test.go` (add `ciqual`)
- Modify: `backend/cmd/foodpack/main.go` (register `ciqual` in `loaders`)

**Interfaces:**
- Consumes: `ValueSyntax`, `NewBuilder`, `FoodInput`, `UnmappedSink`, `noteUnmapped` (Task 1); `Mapping`, `ErrMappingNotInSource` (Plan 1); `loaders` (Task 2).
- Produces: `source.SourceCIQUAL` (`= "ciqual"`); `source.CIQUALOptions{Dir string; Mapping *Mapping; Unmapped UnmappedSink}`; `source.LoadCIQUAL(CIQUALOptions) ([]format.RefFood, []format.SourceInfo, error)`.

- [ ] **Step 1: Write the fixture**

Create `backend/internal/foodpack/source/testdata/ciqual/ciqual.xml`. It deliberately mixes every sentinel CIQUAL uses, and puts `CONST` after `COMPO` to prove the adapter does not depend on element order:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<TABLE>
  <ALIM>
    <alim_code>13000</alim_code>
    <alim_nom_fr>Banane, pulpe, crue</alim_nom_fr>
    <alim_nom_eng>Banana, pulp, raw</alim_nom_eng>
  </ALIM>
  <ALIM>
    <alim_code>19024</alim_code>
    <alim_nom_fr>Lait entier, UHT</alim_nom_fr>
    <alim_nom_eng></alim_nom_eng>
  </ALIM>
  <ALIM>
    <alim_code>99999</alim_code>
    <alim_nom_fr>Aliment sans donnée</alim_nom_fr>
    <alim_nom_eng>Food with no data</alim_nom_eng>
  </ALIM>

  <COMPO><alim_code>13000</alim_code><const_code>328</const_code><teneur>89,0</teneur></COMPO>
  <COMPO><alim_code>13000</alim_code><const_code>327</const_code><teneur>371</teneur></COMPO>
  <COMPO><alim_code>13000</alim_code><const_code>25000</const_code><teneur>74,9</teneur></COMPO>
  <COMPO><alim_code>13000</alim_code><const_code>25001</const_code><teneur>1,09</teneur></COMPO>
  <COMPO><alim_code>13000</alim_code><const_code>40000</const_code><teneur>&lt; 0,5</teneur></COMPO>
  <COMPO><alim_code>13000</alim_code><const_code>31000</const_code><teneur>[20,0]</teneur></COMPO>
  <COMPO><alim_code>13000</alim_code><const_code>10200</const_code><teneur>traces</teneur></COMPO>
  <COMPO><alim_code>13000</alim_code><const_code>10400</const_code><teneur>-</teneur></COMPO>
  <COMPO><alim_code>13000</alim_code><const_code>60000</const_code><teneur>1,5</teneur></COMPO>
  <COMPO><alim_code>19024</alim_code><const_code>328</const_code><teneur>63,0</teneur></COMPO>
  <COMPO><alim_code>19024</alim_code><const_code>10120</const_code><teneur>120</teneur></COMPO>

  <CONST><const_code>327</const_code><const_nom_fr>Energie, Règlement UE (kJ/100 g)</const_nom_fr><const_nom_eng>Energy, Regulation EU No 1169/2011 (kJ/100 g)</const_nom_eng></CONST>
  <CONST><const_code>328</const_code><const_nom_fr>Energie, Règlement UE (kcal/100 g)</const_nom_fr><const_nom_eng>Energy, Regulation EU No 1169/2011 (kcal/100 g)</const_nom_eng></CONST>
  <CONST><const_code>25000</const_code><const_nom_fr>Eau (g/100 g)</const_nom_fr><const_nom_eng>Water (g/100 g)</const_nom_eng></CONST>
  <CONST><const_code>25001</const_code><const_nom_fr>Protéines (g/100 g)</const_nom_fr><const_nom_eng>Protein (g/100 g)</const_nom_eng></CONST>
  <CONST><const_code>31000</const_code><const_nom_fr>Glucides (g/100 g)</const_nom_fr><const_nom_eng>Carbohydrate (g/100 g)</const_nom_eng></CONST>
  <CONST><const_code>40000</const_code><const_nom_fr>Lipides (g/100 g)</const_nom_fr><const_nom_eng>Fat (g/100 g)</const_nom_eng></CONST>
  <CONST><const_code>10120</const_code><const_nom_fr>Calcium (mg/100 g)</const_nom_fr><const_nom_eng>Calcium (mg/100 g)</const_nom_eng></CONST>
  <CONST><const_code>10200</const_code><const_nom_fr>Fer (mg/100 g)</const_nom_fr><const_nom_eng>Iron (mg/100 g)</const_nom_eng></CONST>
  <CONST><const_code>10400</const_code><const_nom_fr>Sodium (mg/100 g)</const_nom_fr><const_nom_eng>Sodium (mg/100 g)</const_nom_eng></CONST>
  <CONST><const_code>60000</const_code><const_nom_fr>Quelque chose (g/100 g)</const_nom_fr><const_nom_eng>Something unmapped (g/100 g)</const_nom_eng></CONST>
</TABLE>
```

- [ ] **Step 2: Write the failing adapter test**

Create `backend/internal/foodpack/source/ciqual_test.go`:

```go
package source

import (
	"errors"
	"math"
	"strings"
	"testing"

	"github.com/boanntech/saolrian/backend/internal/food"
	"github.com/boanntech/saolrian/backend/internal/foodpack/format"
)

const ciqualTestMapping = `source_code,canonical_key,factor,note
328,energy_kcal,1,Energy kcal
25001,protein,1,Protein
40000,fat,1,Fat
31000,carbohydrate,1,Carbohydrate
25000,water,1,Water
10120,calcium,1,Calcium
10200,iron,1,Iron
10400,sodium,1,Sodium
327,-,1,Energy kJ; superseded by 328
`

func loadCIQUALFixture(t *testing.T, mappingCSV string) ([]format.RefFood, []format.SourceInfo) {
	t.Helper()
	m, err := LoadMapping(strings.NewReader(mappingCSV))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	foods, sources, err := LoadCIQUAL(CIQUALOptions{Dir: "testdata/ciqual", Mapping: m})
	if err != nil {
		t.Fatalf("LoadCIQUAL: %v", err)
	}
	return foods, sources
}

func TestLoadCIQUALReadsNutrients(t *testing.T) {
	foods, sources := loadCIQUALFixture(t, ciqualTestMapping)
	if len(foods) != 2 {
		t.Fatalf("got %d foods, want 2 (the food with no COMPO rows is dropped)", len(foods))
	}
	banana := findByName(t, foods, "Banana")
	prof := food.Decode(banana.Nutrients)

	for key, want := range map[string]float64{
		"energy_kcal": 89, // decimal comma
		"protein":     1.09,
		"water":       74.9,
		"fat":         0.5,  // "< 0,5" takes the bound
		"carbohydrate": 20.0, // "[20,0]" estimated, taken at face value
	} {
		if got := prof[key]; math.Abs(got-want) > 1e-6 {
			t.Errorf("%s = %v, want %v", key, got, want)
		}
	}

	// "traces" is a measurement of negligible, so a real zero...
	iron, ok := prof["iron"]
	if !ok || iron != 0 {
		t.Errorf("iron = %v, present=%v; want a real 0 from \"traces\"", iron, ok)
	}
	// ...while "-" was never measured and must not appear at all.
	if _, ok := prof["sodium"]; ok {
		t.Error(`sodium is present, but "-" means not measured`)
	}

	if len(sources) != 1 || sources[0].Source != SourceCIQUAL || sources[0].Region != "fr" {
		t.Errorf("sources = %+v", sources)
	}
	if sources[0].Rows != 2 || sources[0].URL == "" {
		t.Errorf("sources = %+v; CIQUAL is Licence Ouverte and requires attribution", sources)
	}
}

// The English name is what a user reads; the French one still has to find
// the food. When CIQUAL ships no English name, French is the name and the
// locale must say so.
func TestLoadCIQUALPrefersEnglishName(t *testing.T) {
	foods, _ := loadCIQUALFixture(t, ciqualTestMapping)

	banana := findByName(t, foods, "Banana")
	if banana.Name != "Banana, pulp, raw" {
		t.Errorf("Name = %q, want the English name", banana.Name)
	}
	if banana.NameLocale != "" {
		t.Errorf("NameLocale = %q, want empty for an English name", banana.NameLocale)
	}
	if !strings.Contains(banana.SearchText, "banane") {
		t.Errorf("SearchText %q does not include the French name", banana.SearchText)
	}

	milk := findByName(t, foods, "Lait")
	if milk.NameLocale != "fr" {
		t.Errorf("NameLocale = %q, want \"fr\" when only the French name exists", milk.NameLocale)
	}
}

func TestLoadCIQUALRejectsStaleMapping(t *testing.T) {
	m, err := LoadMapping(strings.NewReader(ciqualTestMapping + "77777,biotin,1,not in CIQUAL\n"))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	_, _, err = LoadCIQUAL(CIQUALOptions{Dir: "testdata/ciqual", Mapping: m})
	if !errors.Is(err, ErrMappingNotInSource) {
		t.Fatalf("err = %v, want ErrMappingNotInSource", err)
	}
}

// CIQUAL records a constituent's unit only inside its name. Reading it
// there is the difference between catching a kJ-as-kcal mapping and
// shipping every French food at 4.184x its real energy.
func TestLoadCIQUALRejectsUnitDisagreement(t *testing.T) {
	// 327 is kJ. Mapping it to energy_kcal with factor 1 is the exact bug
	// the cross-source check exists to catch; catch it here first.
	bad := strings.Replace(ciqualTestMapping, "328,energy_kcal,1,Energy kcal", "328,-,1,ignored", 1)
	bad = strings.Replace(bad, "327,-,1,Energy kJ; superseded by 328", "327,energy_kcal,1,WRONG", 1)
	m, err := LoadMapping(strings.NewReader(bad))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	_, _, err = LoadCIQUAL(CIQUALOptions{Dir: "testdata/ciqual", Mapping: m})
	if err == nil || !strings.Contains(err.Error(), "327") {
		t.Fatalf("err = %v, want a unit complaint naming 327", err)
	}
}

// A kJ column mapped with the right factor is legitimate and must not be
// blocked by the unit guard.
func TestLoadCIQUALAllowsDeliberateConversion(t *testing.T) {
	ok := strings.Replace(ciqualTestMapping, "328,energy_kcal,1,Energy kcal", "328,-,1,ignored", 1)
	ok = strings.Replace(ok, "327,-,1,Energy kJ; superseded by 328", "327,energy_kcal,0.239006,kJ to kcal", 1)
	m, err := LoadMapping(strings.NewReader(ok))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	foods, _, err := LoadCIQUAL(CIQUALOptions{Dir: "testdata/ciqual", Mapping: m})
	if err != nil {
		t.Fatalf("LoadCIQUAL: %v", err)
	}
	banana := findByName(t, foods, "Banana")
	if got := food.Decode(banana.Nutrients)["energy_kcal"]; math.Abs(got-88.7) > 0.5 {
		t.Errorf("energy_kcal = %v, want ~88.7 from 371 kJ", got)
	}
}

func TestLoadCIQUALReportsUnmappedCodes(t *testing.T) {
	m, err := LoadMapping(strings.NewReader(ciqualTestMapping))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	c := NewUnmappedCollector()
	if _, _, err := LoadCIQUAL(CIQUALOptions{Dir: "testdata/ciqual", Mapping: m, Unmapped: c.Note}); err != nil {
		t.Fatalf("LoadCIQUAL: %v", err)
	}
	if rep := c.Report(); !strings.Contains(rep, "60000") {
		t.Errorf("report does not name the unmapped constituent:\n%s", rep)
	}
}

// An unrecognised token must stop the build rather than become a zero.
func TestLoadCIQUALRejectsUnknownToken(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "x.xml", []byte(`<TABLE>
  <ALIM><alim_code>1</alim_code><alim_nom_eng>Thing</alim_nom_eng></ALIM>
  <COMPO><alim_code>1</alim_code><const_code>328</const_code><teneur>voir note</teneur></COMPO>
  <CONST><const_code>328</const_code><const_nom_eng>Energy (kcal/100 g)</const_nom_eng></CONST>
</TABLE>`))

	m, err := LoadMapping(strings.NewReader("source_code,canonical_key,factor,note\n328,energy_kcal,1,Energy\n"))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	_, _, err = LoadCIQUAL(CIQUALOptions{Dir: dir, Mapping: m})
	if !errors.Is(err, ErrUnknownToken) {
		t.Fatalf("err = %v, want ErrUnknownToken", err)
	}
}
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `cd backend && go test ./internal/foodpack/source/ -run CIQUAL -v`
Expected: FAIL — `undefined: LoadCIQUAL`.

- [ ] **Step 4: Implement `ciqual.go`**

Create `backend/internal/foodpack/source/ciqual.go`. As in Task 3, the last function (`unitFromLabel`) goes into `value.go`, not into `ciqual.go`:

```go
package source

import (
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/boanntech/saolrian/backend/internal/food"
	"github.com/boanntech/saolrian/backend/internal/foodpack/format"
)

// SourceCIQUAL is the ANSES CIQUAL table's source value in food_ref.
const SourceCIQUAL = "ciqual"

const (
	ciqualLicence = "licence-ouverte"
	ciqualRegion  = "fr"
	ciqualURL     = "https://ciqual.anses.fr/"
)

// ciqualValues is CIQUAL's cell grammar: French decimal commas, "traces"
// for a measured negligible amount, "-" for never measured, and "<" bounds
// on figures below the limit of quantification.
var ciqualValues = ValueSyntax{
	Absent:       []string{"-", "ND", "nd"},
	Trace:        []string{"traces", "trace"},
	DecimalComma: true,
}

// CIQUALOptions configures the CIQUAL adapter.
type CIQUALOptions struct {
	Dir      string // directory holding the extracted CIQUAL XML
	Mapping  *Mapping
	Unmapped UnmappedSink
}

type ciqualAlim struct {
	Code    string        `xml:"alim_code"`
	NomFR   string        `xml:"alim_nom_fr"`
	NomEng  string        `xml:"alim_nom_eng"`
	Nested  []ciqualCompo `xml:"COMPO"`
}

type ciqualCompo struct {
	AlimCode  string `xml:"alim_code"`
	ConstCode string `xml:"const_code"`
	Teneur    string `xml:"teneur"`
}

type ciqualConst struct {
	Code   string `xml:"const_code"`
	NomFR  string `xml:"const_nom_fr"`
	NomEng string `xml:"const_nom_eng"`
}

// ciqualDoc is everything the adapter needs, accumulated across however
// many XML files the release ships and in whatever order the elements
// appear.
type ciqualDoc struct {
	alims  map[string]ciqualAlim
	order  []string
	compos []ciqualCompo
	consts map[string]ciqualConst
}

// LoadCIQUAL reads the CIQUAL XML export.
func LoadCIQUAL(o CIQUALOptions) ([]format.RefFood, []format.SourceInfo, error) {
	if o.Mapping == nil {
		return nil, nil, errors.New("ciqual: mapping is required")
	}

	doc, err := readCIQUALDir(o.Dir)
	if err != nil {
		return nil, nil, fmt.Errorf("ciqual: %w", err)
	}
	if len(doc.alims) == 0 {
		return nil, nil, fmt.Errorf("ciqual: %s contains no ALIM elements", o.Dir)
	}
	if err := ciqualCheckMapping(o.Mapping, doc.consts); err != nil {
		return nil, nil, err
	}

	profiles := map[string]food.Profile{}
	for _, c := range doc.compos {
		if _, ok := doc.alims[c.AlimCode]; !ok {
			continue
		}
		value, present, err := ciqualValues.Parse(c.Teneur)
		if err != nil {
			return nil, nil, fmt.Errorf("ciqual: food %s constituent %s: %w", c.AlimCode, c.ConstCode, err)
		}
		if !present {
			continue
		}
		key, out, ok := o.Mapping.Apply(c.ConstCode, value)
		if !ok {
			if !o.Mapping.Known(c.ConstCode) {
				noteUnmapped(o.Unmapped, c.ConstCode, ciqualLabel(doc.consts[c.ConstCode]))
			}
			continue
		}
		if profiles[c.AlimCode] == nil {
			profiles[c.AlimCode] = food.Profile{}
		}
		profiles[c.AlimCode][key] = out
	}

	b := NewBuilder()
	for _, code := range doc.order {
		a := doc.alims[code]
		name, locale, extra := ciqualNames(a)
		if name == "" {
			continue
		}
		b.Add(FoodInput{
			Source:      SourceCIQUAL,
			SourceID:    code,
			Region:      ciqualRegion,
			Licence:     ciqualLicence,
			Name:        name,
			NameLocale:  locale,
			SearchExtra: extra,
			Profile:     profiles[code],
			// CIQUAL publishes no household measures.
		})
	}
	if err := b.Err("ciqual"); err != nil {
		return nil, nil, err
	}

	rows := b.Rows()[SourceCIQUAL]
	if rows == 0 {
		return b.Foods(), nil, nil
	}
	return b.Foods(), []format.SourceInfo{{
		Source: SourceCIQUAL, Region: ciqualRegion, Licence: ciqualLicence,
		URL: ciqualURL, Rows: rows,
	}}, nil
}

// ciqualNames picks the displayed name and the searchable alternate.
// English is preferred because that is what the rest of the pack is in;
// the French name still has to find the food, so it goes to search only.
func ciqualNames(a ciqualAlim) (name, locale, extra string) {
	en := strings.TrimSpace(a.NomEng)
	fr := strings.TrimSpace(a.NomFR)
	if en != "" {
		return en, "", fr
	}
	return fr, "fr", ""
}

func ciqualLabel(c ciqualConst) string {
	if n := strings.TrimSpace(c.NomEng); n != "" {
		return n
	}
	return strings.TrimSpace(c.NomFR)
}

// readCIQUALDir streams every *.xml in dir. Releases have shipped both as
// one combined file with COMPO nested inside ALIM and as three sibling
// files, so the adapter takes elements wherever they turn up rather than
// betting on a layout that has already changed twice.
func readCIQUALDir(dir string) (*ciqualDoc, error) {
	paths, err := filepath.Glob(filepath.Join(dir, "*.xml"))
	if err != nil {
		return nil, err
	}
	if len(paths) == 0 {
		return nil, fmt.Errorf("no .xml file in %s", dir)
	}
	sort.Strings(paths) // deterministic across filesystems

	doc := &ciqualDoc{alims: map[string]ciqualAlim{}, consts: map[string]ciqualConst{}}
	for _, p := range paths {
		if err := readCIQUALFile(p, doc); err != nil {
			return nil, fmt.Errorf("%s: %w", filepath.Base(p), err)
		}
	}
	return doc, nil
}

func readCIQUALFile(path string, doc *ciqualDoc) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	dec := xml.NewDecoder(f)
	for {
		tok, err := dec.Token()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		se, ok := tok.(xml.StartElement)
		if !ok {
			continue
		}
		switch se.Name.Local {
		case "ALIM":
			var a ciqualAlim
			if err := dec.DecodeElement(&a, &se); err != nil {
				return err
			}
			a.Code = strings.TrimSpace(a.Code)
			if a.Code == "" {
				continue
			}
			if _, seen := doc.alims[a.Code]; !seen {
				doc.alims[a.Code] = a
				doc.order = append(doc.order, a.Code)
			}
			// A release that nests COMPO inside ALIM has just had them
			// consumed by DecodeElement; collect them here.
			for _, c := range a.Nested {
				if strings.TrimSpace(c.AlimCode) == "" {
					c.AlimCode = a.Code
				}
				doc.compos = append(doc.compos, normaliseCompo(c))
			}
		case "COMPO":
			var c ciqualCompo
			if err := dec.DecodeElement(&c, &se); err != nil {
				return err
			}
			doc.compos = append(doc.compos, normaliseCompo(c))
		case "CONST":
			var c ciqualConst
			if err := dec.DecodeElement(&c, &se); err != nil {
				return err
			}
			c.Code = strings.TrimSpace(c.Code)
			if c.Code != "" {
				doc.consts[c.Code] = c
			}
		}
	}
}

func normaliseCompo(c ciqualCompo) ciqualCompo {
	c.AlimCode = strings.TrimSpace(c.AlimCode)
	c.ConstCode = strings.TrimSpace(c.ConstCode)
	return c
}

// ciqualCheckMapping fails a stale mapping, and a factor of 1 that
// disagrees with the unit CIQUAL states in the constituent's name.
func ciqualCheckMapping(m *Mapping, consts map[string]ciqualConst) error {
	for _, code := range m.Codes() {
		unit, mapped := m.UnitFor(code)
		if !mapped {
			continue
		}
		c, present := consts[code]
		if !present {
			return fmt.Errorf("ciqual: %w: const_code %s", ErrMappingNotInSource, code)
		}
		factor, _ := m.FactorFor(code)
		if factor != 1 {
			continue // a deliberate conversion; the factor is the assertion
		}
		srcUnit := unitFromLabel(ciqualLabel(c))
		if srcUnit == "" {
			continue // this release does not state a unit; nothing to check
		}
		if !unitMatches(unit, srcUnit) {
			return fmt.Errorf("ciqual const_code %s (%s): source unit %q but canonical unit is %q; check the factor in mapping/ciqual.csv",
				code, ciqualLabel(c), srcUnit, unit)
		}
	}
	return nil
}

// unitFromLabel pulls "kcal" out of
// "Energy, Regulation EU No 1169/2011 (kcal/100 g)". CIQUAL states a
// constituent's unit nowhere else, and it is the only thing standing
// between a kJ column and a pack where every French food carries 4.184x
// its real energy. CoFID and AFCD name their units the same way, in a
// column header, so this belongs in value.go beside unitMatches.
func unitFromLabel(name string) string {
	open := strings.LastIndex(name, "(")
	if open < 0 {
		return ""
	}
	inner := name[open+1:]
	if close := strings.Index(inner, ")"); close >= 0 {
		inner = inner[:close]
	}
	unit, _, _ := strings.Cut(inner, "/")
	return strings.ToLower(strings.TrimSpace(unit))
}
```

- [ ] **Step 5: Run it to confirm it passes**

Run: `cd backend && go test ./internal/foodpack/source/ -run CIQUAL -v`
Expected: PASS.

- [ ] **Step 6: Write the checked-in mapping table**

Create `backend/internal/foodpack/source/mapping/ciqual.csv`:

```csv
source_code,canonical_key,factor,note
328,energy_kcal,1,"Energy, Regulation EU No 1169/2011 (kcal/100 g)"
25000,water,1,Water (g/100 g)
25001,protein,1,"Protein, crude, N x 6.25 (g/100 g)"
40000,fat,1,Fat (g/100 g)
31000,carbohydrate,1,Carbohydrate (g/100 g)
34000,fibre,1,"Fibre, dietary (g/100 g)"
32000,sugars,1,Sugars (g/100 g)
31200,starch,1,Starch (g/100 g)
34100,ash,1,Ash (g/100 g)
10110,salt,1,Salt (g/100 g)
40302,fat_saturated,1,FA saturated (g/100 g)
40303,fat_monounsaturated,1,FA monounsaturated (g/100 g)
40304,fat_polyunsaturated,1,FA polyunsaturated (g/100 g)
40400,cholesterol,1,Cholesterol (mg/100 g)
10120,calcium,1,Calcium (mg/100 g)
10190,copper,1,Copper (mg/100 g)
10200,iron,1,Iron (mg/100 g)
10230,iodine,1,Iodine (ug/100 g)
10250,magnesium,1,Magnesium (mg/100 g)
10260,manganese,1,Manganese (mg/100 g)
10300,phosphorus,1,Phosphorus (mg/100 g)
10310,potassium,1,Potassium (mg/100 g)
10340,selenium,1,Selenium (ug/100 g)
10400,sodium,1,Sodium (mg/100 g)
10410,zinc,1,Zinc (mg/100 g)
51330,retinol,1,Retinol (ug/100 g)
51340,carotene_beta,1,Beta-carotene (ug/100 g)
52100,vitamin_d,1,Vitamin D (ug/100 g)
53100,vitamin_e,1,Vitamin E (mg/100 g)
54100,vitamin_k,1,Vitamin K1 (ug/100 g)
55100,vitamin_c,1,Vitamin C (mg/100 g)
56100,thiamin,1,Thiamin (mg/100 g)
56200,riboflavin,1,Riboflavin (mg/100 g)
56300,niacin,1,Niacin (mg/100 g)
56400,pantothenate,1,Pantothenic acid (mg/100 g)
56500,vitamin_b6,1,Vitamin B6 (mg/100 g)
56600,biotin,1,Biotin (ug/100 g)
56700,folate,1,"Folate, total (ug/100 g)"
56800,vitamin_b12,1,Vitamin B12 (ug/100 g)
327,-,1,"Energy, Regulation EU (kJ/100 g); superseded by 328 kcal"
10004,-,1,Energy N.G.M.; a second energy convention
```

This is a **starting** table. CIQUAL's `const_code` list is long and shifts between releases, so treat every row above as a claim the build is about to test: `ciqualCheckMapping` turns a wrong code into a failure that names the code, and Task 8's `--report-unmapped` run supplies whatever is missing. Never add a code to this file without seeing it in the real `CONST` list.

- [ ] **Step 7: Extend the checked-in-mappings test**

In `backend/internal/foodpack/source/mapping_files_test.go`: `for _, name := range []string{"usda", "cnf", "ciqual"} {`

- [ ] **Step 8: Register CIQUAL in the build**

In `backend/cmd/foodpack/main.go`, add `"ciqual": loadCIQUALDir,` to `loaders` and:

```go
func loadCIQUALDir(dir string, sink source.UnmappedSink) ([]format.RefFood, []format.SourceInfo, error) {
	m, err := source.LoadNamedMapping("ciqual")
	if err != nil {
		return nil, nil, err
	}
	return source.LoadCIQUAL(source.CIQUALOptions{Dir: dir, Mapping: m, Unmapped: sink})
}
```

- [ ] **Step 9: Run every test**

Run: `cd backend && go test ./... && go vet ./... && gofmt -l .`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
cd /home/slynch/code/saolrian
git add backend/internal/foodpack/source/ backend/cmd/foodpack/main.go
git commit -m "feat(foodpack): CIQUAL XML adapter

First source to exercise ValueSyntax properly: French decimal commas,
'traces' for a measured negligible amount, '-' for never measured, and
'<' bounds. traces lands as a real 0 and '-' omits the key, which is the
distinction the daily coverage figures are built on.

The XML layout has moved between releases -- one combined file with
COMPO nested inside ALIM, or three sibling files -- so the adapter
streams every *.xml in the directory and takes ALIM, COMPO and CONST
wherever they appear. That is less code than a layout-specific parser and
survives the next reshuffle.

CIQUAL states a constituent's unit only inside its name, so the unit
guard parses it out of the trailing parenthesis. Without that, mapping
const_code 327 (kJ) to energy_kcal with factor 1 would ship every French
food at 4.184x its real energy and nothing before the cross-source check
would notice.

English names are displayed, French names go to search_text only.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: excelize, the sheet reader, and the CoFID adapter

The first spreadsheet source. Two things are new: a dependency, and nutrients identified by **column-header text** rather than by a code. Both spreadsheet adapters share a reader, so it is written here and reused unchanged in Task 6.

CoFID splits its nutrients across several sheets — proximates, inorganics, vitamins — keyed by food code, so one food's profile is assembled from three rows in three places. Row and column positions have shifted between releases, so every one of them is an option with a default rather than a literal buried in the code.

**Files:**
- Create: `backend/internal/foodpack/source/sheet.go`
- Create: `backend/internal/foodpack/source/sheet_test.go`
- Create: `backend/internal/foodpack/source/cofid.go`
- Create: `backend/internal/foodpack/source/mapping/cofid.csv`
- Test: `backend/internal/foodpack/source/cofid_test.go`
- Modify: `backend/go.mod`, `backend/go.sum` (add `github.com/xuri/excelize/v2`)
- Modify: `backend/internal/foodpack/source/mapping_files_test.go` (add `cofid`)
- Modify: `backend/cmd/foodpack/main.go` (register `cofid` in `loaders`)

**Interfaces:**
- Consumes: `ValueSyntax`, `unitMatches`, `unitFromLabel`, `NewBuilder`, `FoodInput`, `UnmappedSink` (Tasks 1, 3, 4); `Mapping`, `ErrMappingNotInSource` (Plan 1); `loaders` (Task 2).
- Produces:
  - `normaliseHeader(string) string`; `sheetTable{Header []string; Rows [][]string}`; `readSheet(f *excelize.File, sheet string, headerRow int) (*sheetTable, error)`; `(*sheetTable).Cell(row []string, header string) (string, bool)`; `(*sheetTable).Has(header string) bool`; `findWorkbook(dir, explicit string) (string, error)`
  - `source.SourceCoFID` (`= "cofid"`); `source.CoFIDOptions{Dir, File string; Sheets []string; HeaderRow int; CodeColumn, NameColumn string; Mapping *Mapping; Unmapped UnmappedSink}`; `source.LoadCoFID(CoFIDOptions) ([]format.RefFood, []format.SourceInfo, error)`

- [ ] **Step 1: Add the dependency**

```bash
cd backend && go get github.com/xuri/excelize/v2@latest && go mod tidy
```

- [ ] **Step 2: Prove it stays out of the server binary**

The server must not grow an xlsx parser. Run:

```bash
cd backend && go list -deps . | grep -c excelize
```

Expected: `0`. (`grep -c` prints `0` and exits 1; that non-zero exit *is* the passing result here.) Also confirm the ingest tree does pull it in:

```bash
cd backend && go list -deps ./cmd/foodpack | grep -c excelize
```

Expected: a number greater than 0.

If the first command finds excelize, something in `internal/food` or `internal/foodpack/format` has grown an import it should not have; fix that before continuing.

- [ ] **Step 3: Write the failing sheet-reader test**

Create `backend/internal/foodpack/source/sheet_test.go`:

```go
package source

import (
	"path/filepath"
	"testing"

	"github.com/xuri/excelize/v2"
)

// writeWorkbook builds a real .xlsx from a table literal. Fixtures are
// built rather than checked in so they stay diffable in review; the file is
// still read back through excelize, so the real path is exercised.
func writeWorkbook(t *testing.T, sheets map[string][][]string) string {
	t.Helper()
	f := excelize.NewFile()
	defer f.Close()

	first := true
	for name, rows := range sheets {
		if first {
			if err := f.SetSheetName(f.GetSheetName(0), name); err != nil {
				t.Fatalf("SetSheetName: %v", err)
			}
			first = false
		} else if _, err := f.NewSheet(name); err != nil {
			t.Fatalf("NewSheet %s: %v", name, err)
		}
		for r, row := range rows {
			for c, val := range row {
				cell, err := excelize.CoordinatesToCellName(c+1, r+1)
				if err != nil {
					t.Fatalf("CoordinatesToCellName: %v", err)
				}
				if err := f.SetCellStr(name, cell, val); err != nil {
					t.Fatalf("SetCellStr: %v", err)
				}
			}
		}
	}
	path := filepath.Join(t.TempDir(), "book.xlsx")
	if err := f.SaveAs(path); err != nil {
		t.Fatalf("SaveAs: %v", err)
	}
	return path
}

func TestNormaliseHeader(t *testing.T) {
	cases := map[string]string{
		"Food Code":           "food code",
		"  Vitamin C  (mg)  ": "vitamin c (mg)",
		"Energy with dietary fibre,\nequated \n(kJ)": "energy with dietary fibre, equated (kj)",
		"Sodium\u00a0(mg)": "sodium (mg)",
	}
	for in, want := range cases {
		if got := normaliseHeader(in); got != want {
			t.Errorf("normaliseHeader(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestReadSheetFindsHeaderRowAndCells(t *testing.T) {
	path := writeWorkbook(t, map[string][][]string{
		"Proximates": {
			{"McCance and Widdowson's Composition of Foods"},
			{"per 100 g edible portion"},
			{"Food Code", "Food Name", "Energy (kcal)", " Protein (g) "},
			{"13-100", "Bananas, raw", "95", "1.2"},
		},
	})
	f, err := excelize.OpenFile(path)
	if err != nil {
		t.Fatalf("OpenFile: %v", err)
	}
	defer f.Close()

	tbl, err := readSheet(f, "Proximates", 3)
	if err != nil {
		t.Fatalf("readSheet: %v", err)
	}
	if len(tbl.Rows) != 1 {
		t.Fatalf("got %d data rows, want 1", len(tbl.Rows))
	}
	if !tbl.Has("food code") || !tbl.Has("energy (kcal)") || !tbl.Has("protein (g)") {
		t.Errorf("headers = %v", tbl.Header)
	}
	if v, ok := tbl.Cell(tbl.Rows[0], "food name"); !ok || v != "Bananas, raw" {
		t.Errorf("food name = %q, ok=%v", v, ok)
	}
	if v, _ := tbl.Cell(tbl.Rows[0], "energy (kcal)"); v != "95" {
		t.Errorf("energy = %q", v)
	}
	if _, ok := tbl.Cell(tbl.Rows[0], "no such column"); ok {
		t.Error("an absent column must report ok=false, not an empty string")
	}
}

// Two columns normalising to the same header would make Cell return
// whichever won a map write. That is a different pack every build.
func TestReadSheetRejectsDuplicateHeaders(t *testing.T) {
	path := writeWorkbook(t, map[string][][]string{
		"S": {
			{"Iron (mg)", "Iron  (mg)"},
			{"1", "2"},
		},
	})
	f, err := excelize.OpenFile(path)
	if err != nil {
		t.Fatalf("OpenFile: %v", err)
	}
	defer f.Close()

	if _, err := readSheet(f, "S", 1); err == nil {
		t.Fatal("want an error for two columns with the same normalised header")
	}
}

func TestReadSheetRejectsMissingSheet(t *testing.T) {
	path := writeWorkbook(t, map[string][][]string{"S": {{"a"}, {"1"}}})
	f, err := excelize.OpenFile(path)
	if err != nil {
		t.Fatalf("OpenFile: %v", err)
	}
	defer f.Close()

	if _, err := readSheet(f, "Not There", 1); err == nil {
		t.Fatal("want an error naming the missing sheet")
	}
}

func TestFindWorkbook(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "cofid.xlsx", []byte("x"))
	got, err := findWorkbook(dir, "")
	if err != nil {
		t.Fatalf("findWorkbook: %v", err)
	}
	if filepath.Base(got) != "cofid.xlsx" {
		t.Errorf("found %q", got)
	}

	// Two workbooks is ambiguous: picking one silently would build a
	// different pack depending on directory order.
	writeFile(t, dir, "other.xlsx", []byte("x"))
	if _, err := findWorkbook(dir, ""); err == nil {
		t.Fatal("want an error when the directory holds two workbooks")
	}

	// An explicit path wins, which is how a caller resolves that.
	if got, err := findWorkbook(dir, filepath.Join(dir, "other.xlsx")); err != nil || filepath.Base(got) != "other.xlsx" {
		t.Errorf("explicit path: got %q, err %v", got, err)
	}
}
```

- [ ] **Step 4: Run it to confirm it fails**

Run: `cd backend && go test ./internal/foodpack/source/ -run 'Sheet|NormaliseHeader|FindWorkbook' -v`
Expected: FAIL — `undefined: normaliseHeader`, `undefined: readSheet`.

- [ ] **Step 5: Implement `sheet.go`**

Create `backend/internal/foodpack/source/sheet.go`:

```go
package source

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/xuri/excelize/v2"
)

// normaliseHeader turns a spreadsheet header into the form a mapping table
// keys on. CoFID and AFCD have no nutrient code column: a nutrient *is* its
// column heading. Those headings carry line breaks, non-breaking spaces,
// double spaces and inconsistent capitalisation between releases, none of
// which is a real difference, so all of it is folded away before matching.
func normaliseHeader(s string) string {
	return strings.ToLower(strings.Join(strings.Fields(s), " "))
}

// sheetTable is one worksheet reduced to a normalised header row plus the
// data rows beneath it.
type sheetTable struct {
	Sheet  string
	Header []string
	Rows   [][]string
	index  map[string]int
}

// readSheet reads one worksheet. headerRow is 1-based, matching what a
// person reads off the spreadsheet.
func readSheet(f *excelize.File, sheet string, headerRow int) (*sheetTable, error) {
	if idx, err := f.GetSheetIndex(sheet); err != nil || idx < 0 {
		return nil, fmt.Errorf("workbook has no sheet %q (has %v)", sheet, f.GetSheetList())
	}
	rows, err := f.GetRows(sheet)
	if err != nil {
		return nil, fmt.Errorf("read sheet %q: %w", sheet, err)
	}
	if headerRow < 1 || headerRow > len(rows) {
		return nil, fmt.Errorf("sheet %q has %d rows; header row %d is out of range", sheet, len(rows), headerRow)
	}

	t := &sheetTable{Sheet: sheet, index: map[string]int{}}
	for i, h := range rows[headerRow-1] {
		n := normaliseHeader(h)
		t.Header = append(t.Header, n)
		if n == "" {
			continue // trailing blank columns are ordinary in these files
		}
		if prev, dup := t.index[n]; dup {
			return nil, fmt.Errorf("sheet %q: columns %d and %d both normalise to %q; the mapping table cannot tell them apart",
				sheet, prev+1, i+1, n)
		}
		t.index[n] = i
	}
	for _, r := range rows[headerRow:] {
		if isBlankRow(r) {
			continue
		}
		t.Rows = append(t.Rows, r)
	}
	return t, nil
}

func isBlankRow(r []string) bool {
	for _, c := range r {
		if strings.TrimSpace(c) != "" {
			return false
		}
	}
	return true
}

// Has reports whether the sheet carries a column with this normalised
// header.
func (t *sheetTable) Has(header string) bool {
	_, ok := t.index[header]
	return ok
}

// Cell returns one cell of a row. ok distinguishes "this sheet has no such
// column" from "the cell is empty", which for a nutrient is the difference
// between a broken mapping and no data.
func (t *sheetTable) Cell(row []string, header string) (string, bool) {
	i, ok := t.index[header]
	if !ok {
		return "", false
	}
	if i >= len(row) {
		return "", true // short row: the column exists, this cell is empty
	}
	return row[i], true
}

// findWorkbook locates the single .xlsx in dir, or honours an explicit
// path. Two workbooks is an error rather than a guess: the download
// directory has held both a current and a superseded release before.
func findWorkbook(dir, explicit string) (string, error) {
	if explicit != "" {
		return explicit, nil
	}
	matches, err := filepath.Glob(filepath.Join(dir, "*.xlsx"))
	if err != nil {
		return "", err
	}
	switch len(matches) {
	case 0:
		return "", fmt.Errorf("no .xlsx file in %s", dir)
	case 1:
		return matches[0], nil
	default:
		return "", fmt.Errorf("%s holds %d workbooks (%v); pass an explicit file", dir, len(matches), matches)
	}
}
```

- [ ] **Step 6: Run it to confirm it passes**

Run: `cd backend && go test ./internal/foodpack/source/ -run 'Sheet|NormaliseHeader|FindWorkbook' -v`
Expected: PASS.

- [ ] **Step 7: Write the failing CoFID test**

Create `backend/internal/foodpack/source/cofid_test.go`:

```go
package source

import (
	"errors"
	"math"
	"strings"
	"testing"

	"github.com/boanntech/saolrian/backend/internal/food"
	"github.com/boanntech/saolrian/backend/internal/foodpack/format"
)

const cofidTestMapping = `source_code,canonical_key,factor,note
energy (kcal),energy_kcal,1,Energy kcal
protein (g),protein,1,Protein
fat (g),fat,1,Fat
carbohydrate (g),carbohydrate,1,Available carbohydrate
sodium (mg),sodium,1,Sodium
iron (mg),iron,1,Iron
selenium (µg),selenium,1,Selenium
vitamin c (mg),vitamin_c,1,Vitamin C
energy (kj),-,1,Energy kJ; superseded by kcal
`

// cofidFixture is the shape of the real workbook: a title block above the
// header row, nutrients split across sheets and joined on food code, and
// every sentinel CoFID uses.
func cofidFixture(t *testing.T) string {
	t.Helper()
	return writeWorkbook(t, map[string][][]string{
		"1.3 Proximates": {
			{"McCance and Widdowson's Composition of Foods Integrated Dataset"},
			{"Values per 100 g edible portion"},
			{"Food Code", "Food Name", "Energy (kcal)", "Energy (kJ)", "Protein (g)", "Fat (g)", "Carbohydrate (g)"},
			{"13-100", "Bananas, raw, flesh only", "95", "403", "1.2", "0.3", "23.2"},
			{"12-200", "Milk, whole, pasteurised", "66", "275", "3.4", "3.9", "4.5"},
			{"99-999", "Food with no data", "N", "N", "N", "N", "N"},
		},
		"1.4 Inorganics": {
			{"McCance and Widdowson's Composition of Foods Integrated Dataset"},
			{"Values per 100 g edible portion"},
			{"Food Code", "Food Name", "Sodium (mg)", "Iron (mg)", "Selenium (µg)", "Chloride (mg)"},
			{"13-100", "Bananas, raw, flesh only", "Tr", "0.3", "N", "79"},
			{"12-200", "Milk, whole, pasteurised", "42", "[0.1]", "1", "95"},
		},
		"1.5 Vitamins": {
			{"McCance and Widdowson's Composition of Foods Integrated Dataset"},
			{"Values per 100 g edible portion"},
			{"Food Code", "Food Name", "Vitamin C (mg)"},
			{"13-100", "Bananas, raw, flesh only", "11"},
			{"12-200", "Milk, whole, pasteurised", "<1"},
		},
	})
}

func loadCoFIDFixture(t *testing.T, mappingCSV string) ([]format.RefFood, []format.SourceInfo, error) {
	t.Helper()
	m, err := LoadMapping(strings.NewReader(mappingCSV))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	return LoadCoFID(CoFIDOptions{
		File:    cofidFixture(t),
		Sheets:  []string{"1.3 Proximates", "1.4 Inorganics", "1.5 Vitamins"},
		Mapping: m,
	})
}

func TestLoadCoFIDJoinsSheetsOnFoodCode(t *testing.T) {
	foods, sources, err := loadCoFIDFixture(t, cofidTestMapping)
	if err != nil {
		t.Fatalf("LoadCoFID: %v", err)
	}
	if len(foods) != 2 {
		t.Fatalf("got %d foods, want 2 (the all-N row is dropped)", len(foods))
	}

	banana := findByName(t, foods, "Bananas")
	prof := food.Decode(banana.Nutrients)
	// One food's profile is assembled from three sheets.
	for key, want := range map[string]float64{
		"energy_kcal": 95, "protein": 1.2, "fat": 0.3, "carbohydrate": 23.2,
		"iron": 0.3, "vitamin_c": 11,
	} {
		if got := prof[key]; math.Abs(got-want) > 1e-6 {
			t.Errorf("%s = %v, want %v", key, got, want)
		}
	}
	if banana.Source != SourceCoFID || banana.Region != "uk" {
		t.Errorf("provenance = %+v", banana)
	}
	if banana.SourceID != "13-100" {
		t.Errorf("SourceID = %q, want the food code", banana.SourceID)
	}
	if len(sources) != 1 || sources[0].Rows != 2 || sources[0].URL == "" {
		t.Errorf("sources = %+v; CoFID is OGL-UK and requires attribution", sources)
	}
}

func TestLoadCoFIDSentinels(t *testing.T) {
	foods, _, err := loadCoFIDFixture(t, cofidTestMapping)
	if err != nil {
		t.Fatalf("LoadCoFID: %v", err)
	}
	banana := findByName(t, foods, "Bananas")
	bp := food.Decode(banana.Nutrients)
	milk := findByName(t, foods, "Milk")
	mp := food.Decode(milk.Nutrients)

	// Tr: measured, negligible -> a real zero.
	if v, ok := bp["sodium"]; !ok || v != 0 {
		t.Errorf("banana sodium = %v, ok=%v; want a real 0 from Tr", v, ok)
	}
	// N: never measured -> absent.
	if _, ok := bp["selenium"]; ok {
		t.Error("banana selenium is present, but N means not measured")
	}
	// [0.1]: estimated, but the source vouches for it.
	if v := mp["iron"]; math.Abs(v-0.1) > 1e-9 {
		t.Errorf("milk iron = %v, want 0.1 from [0.1]", v)
	}
	// <1: the bound is the most informative number available.
	if v := mp["vitamin_c"]; math.Abs(v-1) > 1e-9 {
		t.Errorf("milk vitamin C = %v, want 1 from <1", v)
	}
}

// The mapping keys on header text, so a renamed column is a stale mapping
// and must fail exactly as a missing nutrient code does.
func TestLoadCoFIDRejectsMissingColumn(t *testing.T) {
	_, _, err := loadCoFIDFixture(t, cofidTestMapping+"biotin (µg),biotin,1,not in this release\n")
	if !errors.Is(err, ErrMappingNotInSource) {
		t.Fatalf("err = %v, want ErrMappingNotInSource", err)
	}
}

// The unit is in the header, so the same kJ-as-kcal guard applies.
func TestLoadCoFIDRejectsUnitDisagreement(t *testing.T) {
	bad := strings.Replace(cofidTestMapping, "energy (kcal),energy_kcal,1,Energy kcal", "energy (kcal),-,1,ignored", 1)
	bad = strings.Replace(bad, "energy (kj),-,1,Energy kJ; superseded by kcal", "energy (kj),energy_kcal,1,WRONG", 1)
	_, _, err := loadCoFIDFixture(t, bad)
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "kj") {
		t.Fatalf("err = %v, want a unit complaint naming the kJ column", err)
	}
}

// A configured sheet that is not in the workbook is silent data loss: a
// third of the nutrients would simply stop appearing.
func TestLoadCoFIDRejectsMissingSheet(t *testing.T) {
	m, err := LoadMapping(strings.NewReader(cofidTestMapping))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	_, _, err = LoadCoFID(CoFIDOptions{
		File:    cofidFixture(t),
		Sheets:  []string{"1.3 Proximates", "1.9 Not There"},
		Mapping: m,
	})
	if err == nil || !strings.Contains(err.Error(), "1.9 Not There") {
		t.Fatalf("err = %v, want an error naming the missing sheet", err)
	}
}

func TestLoadCoFIDReportsUnmappedColumns(t *testing.T) {
	m, err := LoadMapping(strings.NewReader(cofidTestMapping))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	c := NewUnmappedCollector()
	if _, _, err := LoadCoFID(CoFIDOptions{
		File:     cofidFixture(t),
		Sheets:   []string{"1.3 Proximates", "1.4 Inorganics", "1.5 Vitamins"},
		Mapping:  m,
		Unmapped: c.Note,
	}); err != nil {
		t.Fatalf("LoadCoFID: %v", err)
	}
	if rep := c.Report(); !strings.Contains(rep, "chloride (mg)") {
		t.Errorf("report does not name the unmapped column:\n%s", rep)
	}
}

func TestLoadCoFIDRejectsUnknownToken(t *testing.T) {
	path := writeWorkbook(t, map[string][][]string{
		"1.3 Proximates": {
			{"Food Code", "Food Name", "Energy (kcal)"},
			{"1", "Thing", "see footnote"},
		},
	})
	m, err := LoadMapping(strings.NewReader("source_code,canonical_key,factor,note\nenergy (kcal),energy_kcal,1,Energy\n"))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	_, _, err = LoadCoFID(CoFIDOptions{
		File: path, Sheets: []string{"1.3 Proximates"}, HeaderRow: 1, Mapping: m,
	})
	if !errors.Is(err, ErrUnknownToken) {
		t.Fatalf("err = %v, want ErrUnknownToken", err)
	}
}
```

- [ ] **Step 8: Run it to confirm it fails**

Run: `cd backend && go test ./internal/foodpack/source/ -run CoFID -v`
Expected: FAIL — `undefined: LoadCoFID`.

- [ ] **Step 9: Implement `cofid.go`**

Create `backend/internal/foodpack/source/cofid.go`:

```go
package source

import (
	"errors"
	"fmt"
	"strings"

	"github.com/xuri/excelize/v2"

	"github.com/boanntech/saolrian/backend/internal/food"
	"github.com/boanntech/saolrian/backend/internal/foodpack/format"
)

// SourceCoFID is McCance & Widdowson's Composition of Foods Integrated
// Dataset, as it appears in food_ref.source.
const SourceCoFID = "cofid"

const (
	cofidLicence = "ogl-uk"
	cofidRegion  = "uk"
	cofidURL     = "https://www.gov.uk/government/publications/composition-of-foods-integrated-dataset-cofid"
)

// cofidValues is CoFID's cell grammar. Tr is a measured trace, N was never
// measured, and a bracketed figure is estimated or taken from a similar
// food.
var cofidValues = ValueSyntax{
	Absent: []string{"N", "-", "n/a"},
	Trace:  []string{"Tr"},
}

// Defaults for the 2019 and 2021 releases. Every one of these has moved at
// least once between releases, which is why they are options rather than
// literals in the reading code.
var cofidDefaultSheets = []string{"1.3 Proximates", "1.4 Inorganics", "1.5 Vitamins"}

const (
	cofidDefaultHeaderRow  = 3
	cofidDefaultCodeColumn = "food code"
	cofidDefaultNameColumn = "food name"
)

// CoFIDOptions configures the CoFID adapter.
type CoFIDOptions struct {
	Dir  string // directory holding the workbook
	File string // explicit workbook path, overriding Dir
	// Sheets are read in order and joined on the food code. Defaults to
	// the proximates, inorganics and vitamins sheets.
	Sheets []string
	// HeaderRow is 1-based, as read off the spreadsheet. Defaults to 3:
	// the release title and the "per 100 g" note sit above it.
	HeaderRow  int
	CodeColumn string
	NameColumn string
	Mapping    *Mapping
	Unmapped   UnmappedSink
}

func (o *CoFIDOptions) applyDefaults() {
	if len(o.Sheets) == 0 {
		o.Sheets = cofidDefaultSheets
	}
	if o.HeaderRow == 0 {
		o.HeaderRow = cofidDefaultHeaderRow
	}
	if o.CodeColumn == "" {
		o.CodeColumn = cofidDefaultCodeColumn
	}
	if o.NameColumn == "" {
		o.NameColumn = cofidDefaultNameColumn
	}
	o.CodeColumn = normaliseHeader(o.CodeColumn)
	o.NameColumn = normaliseHeader(o.NameColumn)
}

// LoadCoFID reads the CoFID workbook, assembling each food's profile from
// however many sheets carry a row for its food code.
func LoadCoFID(o CoFIDOptions) ([]format.RefFood, []format.SourceInfo, error) {
	if o.Mapping == nil {
		return nil, nil, errors.New("cofid: mapping is required")
	}
	o.applyDefaults()

	path, err := findWorkbook(o.Dir, o.File)
	if err != nil {
		return nil, nil, fmt.Errorf("cofid: %w", err)
	}
	wb, err := excelize.OpenFile(path)
	if err != nil {
		return nil, nil, fmt.Errorf("cofid: open %s: %w", path, err)
	}
	defer wb.Close()

	tables := make([]*sheetTable, 0, len(o.Sheets))
	headers := map[string]bool{}
	for _, name := range o.Sheets {
		t, err := readSheet(wb, name, o.HeaderRow)
		if err != nil {
			return nil, nil, fmt.Errorf("cofid: %w", err)
		}
		if !t.Has(o.CodeColumn) {
			return nil, nil, fmt.Errorf("cofid: sheet %q has no %q column (headers: %v)", name, o.CodeColumn, t.Header)
		}
		for _, h := range t.Header {
			if h != "" {
				headers[h] = true
			}
		}
		tables = append(tables, t)
	}
	if err := headerMappingCheck("cofid", o.Mapping, headers, "mapping/cofid.csv"); err != nil {
		return nil, nil, err
	}

	names := map[string]string{}
	profiles := map[string]food.Profile{}
	var order []string

	for _, t := range tables {
		for _, row := range t.Rows {
			code, _ := t.Cell(row, o.CodeColumn)
			code = strings.TrimSpace(code)
			if code == "" {
				continue
			}
			if _, seen := names[code]; !seen {
				name, _ := t.Cell(row, o.NameColumn)
				name = strings.TrimSpace(name)
				if name == "" {
					continue // no name on the first sheet that mentions it
				}
				names[code] = name
				order = append(order, code)
			}
			for _, h := range t.Header {
				if h == "" || h == o.CodeColumn || h == o.NameColumn {
					continue
				}
				raw, ok := t.Cell(row, h)
				if !ok {
					continue
				}
				value, present, err := cofidValues.Parse(raw)
				if err != nil {
					return nil, nil, fmt.Errorf("cofid: sheet %q food %s column %q: %w", t.Sheet, code, h, err)
				}
				if !present {
					continue
				}
				key, out, mapped := o.Mapping.Apply(h, value)
				if !mapped {
					if !o.Mapping.Known(h) {
						noteUnmapped(o.Unmapped, h, t.Sheet)
					}
					continue
				}
				if profiles[code] == nil {
					profiles[code] = food.Profile{}
				}
				profiles[code][key] = out
			}
		}
	}

	b := NewBuilder()
	for _, code := range order {
		b.Add(FoodInput{
			Source:   SourceCoFID,
			SourceID: code,
			Region:   cofidRegion,
			Licence:  cofidLicence,
			Name:     names[code],
			Profile:  profiles[code],
			// CoFID publishes no household measures in these sheets.
		})
	}
	if err := b.Err("cofid"); err != nil {
		return nil, nil, err
	}

	rows := b.Rows()[SourceCoFID]
	if rows == 0 {
		return b.Foods(), nil, nil
	}
	return b.Foods(), []format.SourceInfo{{
		Source: SourceCoFID, Region: cofidRegion, Licence: cofidLicence,
		URL: cofidURL, Rows: rows,
	}}, nil
}

// headerMappingCheck is the spreadsheet equivalent of usdaCheckMapping: a
// mapped column header absent from the workbook is a stale mapping, and a
// factor of 1 has to agree with the unit the header states.
//
// Shared by CoFID and AFCD, which identify nutrients the same way.
func headerMappingCheck(adapter string, m *Mapping, headers map[string]bool, tablePath string) error {
	for _, code := range m.Codes() {
		unit, mapped := m.UnitFor(code)
		if !mapped {
			continue
		}
		if !headers[code] {
			return fmt.Errorf("%s: %w: column %q", adapter, ErrMappingNotInSource, code)
		}
		factor, _ := m.FactorFor(code)
		if factor != 1 {
			continue // a deliberate conversion; the factor is the assertion
		}
		srcUnit := unitFromLabel(code)
		if srcUnit == "" {
			continue // this header states no unit; nothing to check
		}
		if !unitMatches(unit, srcUnit) {
			return fmt.Errorf("%s column %q: header states unit %q but canonical unit is %q; check the factor in %s",
				adapter, code, srcUnit, unit, tablePath)
		}
	}
	return nil
}
```

- [ ] **Step 10: Run it to confirm it passes**

Run: `cd backend && go test ./internal/foodpack/source/ -run CoFID -v`
Expected: PASS.

- [ ] **Step 11: Write the checked-in mapping table**

Create `backend/internal/foodpack/source/mapping/cofid.csv`. Codes are **normalised column headers** — lowercase, single-spaced — because CoFID has no nutrient code column:

```csv
source_code,canonical_key,factor,note
energy (kcal) (kcal),energy_kcal,1,Proximates: energy in kcal
protein (g),protein,1,Proximates
fat (g),fat,1,Proximates
carbohydrate (g),carbohydrate,1,"Proximates: available carbohydrate, monosaccharide equivalents"
englyst fibre (g),fibre,1,Proximates
total sugars (g),sugars,1,Proximates
starch (g),starch,1,Proximates
satd fa /100g fa (g),fat_saturated,1,Proximates
mono fa /100g fa (g),fat_monounsaturated,1,Proximates
poly fa /100g fa (g),fat_polyunsaturated,1,Proximates
trans fa /100g fa (g),fat_trans,1,Proximates
cholesterol (mg),cholesterol,1,Proximates
alcohol (g),alcohol,1,Proximates
water (g),water,1,Proximates
sodium (mg),sodium,1,Inorganics
potassium (mg),potassium,1,Inorganics
calcium (mg),calcium,1,Inorganics
magnesium (mg),magnesium,1,Inorganics
phosphorus (mg),phosphorus,1,Inorganics
iron (mg),iron,1,Inorganics
zinc (mg),zinc,1,Inorganics
copper (mg),copper,1,Inorganics
manganese (mg),manganese,1,Inorganics
selenium (µg),selenium,1,Inorganics
iodine (µg),iodine,1,Inorganics
retinol (µg),retinol,1,Vitamins
carotene (µg),carotene_beta,1,Vitamins
vitamin a (µg),vitamin_a_rae,1,Vitamins: retinol equivalents
vitamin d (µg),vitamin_d,1,Vitamins
vitamin e (mg),vitamin_e,1,Vitamins
vitamin k1 (µg),vitamin_k,1,Vitamins
vitamin c (mg),vitamin_c,1,Vitamins
thiamin (mg),thiamin,1,Vitamins
riboflavin (mg),riboflavin,1,Vitamins
niacin (mg),niacin,1,Vitamins
vitamin b6 (mg),vitamin_b6,1,Vitamins
folate (µg),folate,1,Vitamins
vitamin b12 (µg),vitamin_b12,1,Vitamins
pantothenate (mg),pantothenate,1,Vitamins
biotin (µg),biotin,1,Vitamins
energy (kj) (kj),-,1,Proximates: energy in kJ; superseded by kcal
chloride (mg),-,1,Inorganics: outside the canonical vocabulary
tryptophan/60 (g),-,1,Proximates: a protein component
niacin equivalent (mg),-,1,Vitamins: superseded by preformed niacin
```

Same rule as CIQUAL: this is a starting table, and every row is a claim `headerMappingCheck` is about to test against the real workbook. Task 8 runs `--report-unmapped` and completes it.

- [ ] **Step 12: Extend the checked-in-mappings test**

In `backend/internal/foodpack/source/mapping_files_test.go`: `for _, name := range []string{"usda", "cnf", "ciqual", "cofid"} {`

The existing `len(m.Codes()) < 20` assertion holds for all four. The `Apply("208", 100)` assertion inside the loop is USDA-specific — move it out of the loop into `TestUSDAMapsEnergyToKcal`, which already covers it, and drop it from the loop body.

- [ ] **Step 13: Register CoFID in the build**

In `backend/cmd/foodpack/main.go`, add `"cofid": loadCoFIDDir,` to `loaders` and:

```go
func loadCoFIDDir(dir string, sink source.UnmappedSink) ([]format.RefFood, []format.SourceInfo, error) {
	m, err := source.LoadNamedMapping("cofid")
	if err != nil {
		return nil, nil, err
	}
	return source.LoadCoFID(source.CoFIDOptions{Dir: dir, Mapping: m, Unmapped: sink})
}
```

- [ ] **Step 14: Run every test and re-check the dependency boundary**

```bash
cd backend && go test ./... && go vet ./... && gofmt -l . && go list -deps . | grep -c excelize
```
Expected: tests PASS, no vet or gofmt output, and the final `grep -c` prints `0`.

- [ ] **Step 15: Commit**

```bash
cd /home/slynch/code/saolrian
git add backend/go.mod backend/go.sum backend/internal/foodpack/source/ backend/cmd/foodpack/main.go
git commit -m "feat(foodpack): CoFID xlsx adapter and the shared sheet reader

First spreadsheet source, and the first where a nutrient has no code: it
is a column heading. So the mapping table keys on normalised header text,
and normaliseHeader folds away the line breaks, non-breaking spaces and
double spaces CoFID's headings carry, none of which is a real difference.
Two columns that normalise alike is an error, not a coin flip.

CoFID splits nutrients across proximates, inorganics and vitamins sheets,
joined on food code, so one profile is assembled from three rows in three
places. A configured sheet missing from the workbook fails the build: a
third of the nutrients quietly vanishing is the worse outcome.

Sheet names, header row and key columns are options with defaults because
every one of them has moved between releases.

excelize is imported only from internal/foodpack/source; go list -deps on
the server root confirms it stays out of the server binary.

Fixtures are built in-test from Go table literals, so they are diffable
in review while still going through the real excelize read path.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: AFCD adapter

The last adapter, and the shortest: one sheet, per 100 g, no cross-sheet join, and the reader already exists. What makes it worth its own task is that **AFCD publishes energy only in kilojoules**. Its mapping table is the first with a factor that is not 1 on an energy row, which is exactly the situation Task 7's cross-source check is built to police.

**Files:**
- Create: `backend/internal/foodpack/source/afcd.go`
- Create: `backend/internal/foodpack/source/mapping/afcd.csv`
- Test: `backend/internal/foodpack/source/afcd_test.go`
- Modify: `backend/internal/foodpack/source/mapping_files_test.go` (add `afcd`)
- Modify: `backend/cmd/foodpack/main.go` (register `afcd` in `loaders`)

**Interfaces:**
- Consumes: `readSheet`, `normaliseHeader`, `findWorkbook`, `headerMappingCheck` (Task 5); `ValueSyntax`, `NewBuilder`, `FoodInput`, `UnmappedSink` (Task 1); `loaders` (Task 2).
- Produces: `source.SourceAFCD` (`= "afcd"`); `source.AFCDOptions{Dir, File, Sheet string; HeaderRow int; CodeColumn, NameColumn string; Mapping *Mapping; Unmapped UnmappedSink}`; `source.LoadAFCD(AFCDOptions) ([]format.RefFood, []format.SourceInfo, error)`.

- [ ] **Step 1: Write the failing test**

Create `backend/internal/foodpack/source/afcd_test.go`:

```go
package source

import (
	"errors"
	"math"
	"strings"
	"testing"

	"github.com/boanntech/saolrian/backend/internal/food"
	"github.com/boanntech/saolrian/backend/internal/foodpack/format"
)

// AFCD reports energy in kilojoules only, so the mapping converts. 0.239006
// is 1/4.184, the thermochemical kJ-per-kcal.
const afcdTestMapping = `source_code,canonical_key,factor,note
"energy with dietary fibre, equated (kj)",energy_kcal,0.239006,kJ to kcal
protein (g),protein,1,Protein
"fat, total (g)",fat,1,Fat
"available carbohydrate, without sugar alcohols (g)",carbohydrate,1,Carbohydrate
total dietary fibre (g),fibre,1,Fibre
sodium (na) (mg),sodium,1,Sodium
iron (fe) (mg),iron,1,Iron
vitamin c (mg),vitamin_c,1,Vitamin C
"energy, without dietary fibre, equated (kj)",-,1,superseded by the with-fibre figure
`

// afcdFixture mirrors the real workbook, including the line breaks AFCD
// puts inside its column headings.
func afcdFixture(t *testing.T) string {
	t.Helper()
	return writeWorkbook(t, map[string][][]string{
		"All solids & liquids per 100g": {
			{
				"Public Food Key", "Classification", "Food Name",
				"Energy with dietary fibre, equated \n(kJ)",
				"Energy, without dietary fibre, equated \n(kJ)",
				"Protein \n(g)", "Fat, total \n(g)",
				"Available carbohydrate, without sugar alcohols \n(g)",
				"Total dietary fibre \n(g)", "Sodium (Na) \n(mg)",
				"Iron (Fe) \n(mg)", "Vitamin C \n(mg)", "Caffeine \n(mg)",
			},
			{"F009784", "24101", "Banana, cavendish, peeled, raw", "395", "372", "1.4", "0.2", "20.3", "2.4", "1", "0.3", "9", "0"},
			{"F000885", "19101", "Milk, cow, fluid, whole", "268", "268", "3.3", "3.4", "4.6", "0", "43", "0.1", "1", "0"},
			{"F999999", "99999", "Food with no data", "", "", "", "", "", "", "", "", "", ""},
		},
	})
}

func loadAFCDFixture(t *testing.T, mappingCSV string) ([]format.RefFood, []format.SourceInfo, error) {
	t.Helper()
	m, err := LoadMapping(strings.NewReader(mappingCSV))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	return LoadAFCD(AFCDOptions{
		File:    afcdFixture(t),
		Sheet:   "All solids & liquids per 100g",
		Mapping: m,
	})
}

func TestLoadAFCDReadsNutrients(t *testing.T) {
	foods, sources, err := loadAFCDFixture(t, afcdTestMapping)
	if err != nil {
		t.Fatalf("LoadAFCD: %v", err)
	}
	if len(foods) != 2 {
		t.Fatalf("got %d foods, want 2 (the empty row is dropped)", len(foods))
	}
	banana := findByName(t, foods, "Banana")
	if banana.Source != SourceAFCD || banana.Region != "au" || banana.SourceID != "F009784" {
		t.Errorf("provenance = %+v", banana)
	}
	prof := food.Decode(banana.Nutrients)
	for key, want := range map[string]float64{
		"protein": 1.4, "fat": 0.2, "carbohydrate": 20.3, "fibre": 2.4,
		"sodium": 1, "iron": 0.3, "vitamin_c": 9,
	} {
		if got := prof[key]; math.Abs(got-want) > 1e-6 {
			t.Errorf("%s = %v, want %v", key, got, want)
		}
	}
	if len(sources) != 1 || sources[0].Rows != 2 || sources[0].URL == "" {
		t.Errorf("sources = %+v; AFCD is CC-BY 3.0 AU and requires attribution", sources)
	}
}

// AFCD publishes no kcal column. Shipping its kilojoules as kilocalories
// would put every Australian food at 4.184x its real energy — the single
// most likely mistake in this whole plan.
func TestLoadAFCDConvertsKilojoulesToKilocalories(t *testing.T) {
	foods, _, err := loadAFCDFixture(t, afcdTestMapping)
	if err != nil {
		t.Fatalf("LoadAFCD: %v", err)
	}
	banana := findByName(t, foods, "Banana")
	got := food.Decode(banana.Nutrients)["energy_kcal"]
	if math.Abs(got-94.4) > 0.5 {
		t.Errorf("energy_kcal = %v, want ~94.4 (395 kJ); a value near 395 means the factor was not applied", got)
	}
}

// The multi-line headings AFCD uses are not a real difference; the mapping
// table must not have to reproduce them.
func TestLoadAFCDMatchesHeadersAcrossLineBreaks(t *testing.T) {
	foods, _, err := loadAFCDFixture(t, afcdTestMapping)
	if err != nil {
		t.Fatalf("LoadAFCD: %v", err)
	}
	banana := findByName(t, foods, "Banana")
	if _, ok := food.Decode(banana.Nutrients)["fibre"]; !ok {
		t.Error("Total dietary fibre did not match its mapping row across the line break in the heading")
	}
}

func TestLoadAFCDRejectsMissingColumn(t *testing.T) {
	_, _, err := loadAFCDFixture(t, afcdTestMapping+"selenium (se) (µg),selenium,1,not in this fixture\n")
	if !errors.Is(err, ErrMappingNotInSource) {
		t.Fatalf("err = %v, want ErrMappingNotInSource", err)
	}
}

func TestLoadAFCDReportsUnmappedColumns(t *testing.T) {
	m, err := LoadMapping(strings.NewReader(afcdTestMapping))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}
	c := NewUnmappedCollector()
	if _, _, err := LoadAFCD(AFCDOptions{
		File:     afcdFixture(t),
		Sheet:    "All solids & liquids per 100g",
		Mapping:  m,
		Unmapped: c.Note,
	}); err != nil {
		t.Fatalf("LoadAFCD: %v", err)
	}
	if rep := c.Report(); !strings.Contains(rep, "caffeine (mg)") {
		t.Errorf("report does not name the unmapped column:\n%s", rep)
	}
}
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd backend && go test ./internal/foodpack/source/ -run AFCD -v`
Expected: FAIL — `undefined: LoadAFCD`.

- [ ] **Step 3: Implement `afcd.go`**

Create `backend/internal/foodpack/source/afcd.go`:

```go
package source

import (
	"errors"
	"fmt"
	"strings"

	"github.com/xuri/excelize/v2"

	"github.com/boanntech/saolrian/backend/internal/food"
	"github.com/boanntech/saolrian/backend/internal/foodpack/format"
)

// SourceAFCD is the Australian Food Composition Database's source value in
// food_ref.
const SourceAFCD = "afcd"

const (
	afcdLicence = "cc-by-3.0-au"
	afcdRegion  = "au"
	afcdURL     = "https://www.foodstandards.gov.au/science-data/food-composition-databases"
)

// afcdValues: AFCD leaves an unmeasured cell blank and writes a trace as 0
// already, so the only sentinel it needs is the blank. "Tr" is accepted
// because it appears in some derived releases.
var afcdValues = ValueSyntax{
	Absent: []string{"N", "-"},
	Trace:  []string{"Tr"},
}

const (
	afcdDefaultSheet      = "All solids & liquids per 100g"
	afcdDefaultHeaderRow  = 1
	afcdDefaultCodeColumn = "public food key"
	afcdDefaultNameColumn = "food name"
)

// AFCDOptions configures the Australian Food Composition Database adapter.
type AFCDOptions struct {
	Dir        string
	File       string
	Sheet      string
	HeaderRow  int
	CodeColumn string
	NameColumn string
	Mapping    *Mapping
	Unmapped   UnmappedSink
}

func (o *AFCDOptions) applyDefaults() {
	if o.Sheet == "" {
		o.Sheet = afcdDefaultSheet
	}
	if o.HeaderRow == 0 {
		o.HeaderRow = afcdDefaultHeaderRow
	}
	if o.CodeColumn == "" {
		o.CodeColumn = afcdDefaultCodeColumn
	}
	if o.NameColumn == "" {
		o.NameColumn = afcdDefaultNameColumn
	}
	o.CodeColumn = normaliseHeader(o.CodeColumn)
	o.NameColumn = normaliseHeader(o.NameColumn)
}

// LoadAFCD reads the AFCD per-100g sheet.
func LoadAFCD(o AFCDOptions) ([]format.RefFood, []format.SourceInfo, error) {
	if o.Mapping == nil {
		return nil, nil, errors.New("afcd: mapping is required")
	}
	o.applyDefaults()

	path, err := findWorkbook(o.Dir, o.File)
	if err != nil {
		return nil, nil, fmt.Errorf("afcd: %w", err)
	}
	wb, err := excelize.OpenFile(path)
	if err != nil {
		return nil, nil, fmt.Errorf("afcd: open %s: %w", path, err)
	}
	defer wb.Close()

	t, err := readSheet(wb, o.Sheet, o.HeaderRow)
	if err != nil {
		return nil, nil, fmt.Errorf("afcd: %w", err)
	}
	for _, want := range []string{o.CodeColumn, o.NameColumn} {
		if !t.Has(want) {
			return nil, nil, fmt.Errorf("afcd: sheet %q has no %q column (headers: %v)", o.Sheet, want, t.Header)
		}
	}
	headers := map[string]bool{}
	for _, h := range t.Header {
		if h != "" {
			headers[h] = true
		}
	}
	if err := headerMappingCheck("afcd", o.Mapping, headers, "mapping/afcd.csv"); err != nil {
		return nil, nil, err
	}

	b := NewBuilder()
	for _, row := range t.Rows {
		code, _ := t.Cell(row, o.CodeColumn)
		code = strings.TrimSpace(code)
		name, _ := t.Cell(row, o.NameColumn)
		name = strings.TrimSpace(name)
		if code == "" || name == "" {
			continue
		}

		prof := food.Profile{}
		for _, h := range t.Header {
			if h == "" || h == o.CodeColumn || h == o.NameColumn {
				continue
			}
			raw, ok := t.Cell(row, h)
			if !ok {
				continue
			}
			value, present, err := afcdValues.Parse(raw)
			if err != nil {
				return nil, nil, fmt.Errorf("afcd: food %s column %q: %w", code, h, err)
			}
			if !present {
				continue
			}
			key, out, mapped := o.Mapping.Apply(h, value)
			if !mapped {
				if !o.Mapping.Known(h) {
					noteUnmapped(o.Unmapped, h, o.Sheet)
				}
				continue
			}
			prof[key] = out
		}

		b.Add(FoodInput{
			Source:   SourceAFCD,
			SourceID: code,
			Region:   afcdRegion,
			Licence:  afcdLicence,
			Name:     name,
			Profile:  prof,
			// AFCD publishes measures in a separate workbook, not this one.
		})
	}
	if err := b.Err("afcd"); err != nil {
		return nil, nil, err
	}

	rows := b.Rows()[SourceAFCD]
	if rows == 0 {
		return b.Foods(), nil, nil
	}
	return b.Foods(), []format.SourceInfo{{
		Source: SourceAFCD, Region: afcdRegion, Licence: afcdLicence,
		URL: afcdURL, Rows: rows,
	}}, nil
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `cd backend && go test ./internal/foodpack/source/ -run AFCD -v`
Expected: PASS.

- [ ] **Step 5: Write the checked-in mapping table**

Create `backend/internal/foodpack/source/mapping/afcd.csv`. Note the energy row: AFCD has no kcal column, so this is the one table where the energy factor is not 1:

```csv
source_code,canonical_key,factor,note
"energy with dietary fibre, equated (kj)",energy_kcal,0.239006,AFCD publishes kJ only; 1/4.184
protein (g),protein,1,Protein
"fat, total (g)",fat,1,Total fat
"available carbohydrate, without sugar alcohols (g)",carbohydrate,1,Available carbohydrate
total dietary fibre (g),fibre,1,Total dietary fibre
total sugars (g),sugars,1,Total sugars
starch (g),starch,1,Starch
"total saturated fatty acids, equated (mg)",fat_saturated,0.001,AFCD reports fatty acids in mg; canonical is g
"total monounsaturated fatty acids, equated (mg)",fat_monounsaturated,0.001,mg to g
"total polyunsaturated fatty acids, equated (mg)",fat_polyunsaturated,0.001,mg to g
"total trans fatty acids, imputed (mg)",fat_trans,0.001,mg to g
cholesterol (mg),cholesterol,1,Cholesterol
alcohol (g),alcohol,1,Alcohol
moisture (water) (g),water,1,Moisture
ash (g),ash,1,Ash
sodium (na) (mg),sodium,1,Sodium
potassium (k) (mg),potassium,1,Potassium
calcium (ca) (mg),calcium,1,Calcium
magnesium (mg) (mg),magnesium,1,Magnesium
phosphorus (p) (mg),phosphorus,1,Phosphorus
iron (fe) (mg),iron,1,Iron
zinc (zn) (mg),zinc,1,Zinc
copper (cu) (mg),copper,1,Copper
manganese (mn) (mg),manganese,1,Manganese
selenium (se) (µg),selenium,1,Selenium
iodine (i) (µg),iodine,1,Iodine
"vitamin a retinol equivalents (µg)",vitamin_a_rae,1,Vitamin A RE
retinol (µg),retinol,1,Retinol
beta-carotene (µg),carotene_beta,1,Beta-carotene
vitamin d3 equivalents (µg),vitamin_d,1,Vitamin D
vitamin e (mg),vitamin_e,1,Vitamin E
vitamin c (mg),vitamin_c,1,Vitamin C
thiamin (b1) (mg),thiamin,1,Thiamin
riboflavin (b2) (mg),riboflavin,1,Riboflavin
niacin (b3) (mg),niacin,1,Niacin
pyridoxine (b6) (mg),vitamin_b6,1,Vitamin B6
"total folates (µg)",folate,1,Total folates
cobalamin (b12) (µg),vitamin_b12,1,Vitamin B12
pantothenic acid (b5) (mg),pantothenate,1,Pantothenic acid
biotin (b7) (µg),biotin,1,Biotin
"energy, without dietary fibre, equated (kj)",-,1,a second energy convention; superseded by the with-fibre figure
caffeine (mg),-,1,outside the canonical vocabulary
"niacin derived equivalents (mg)",-,1,superseded by preformed niacin
"dietary folate equivalents (µg)",-,1,superseded by total folates
```

A starting table, as with CIQUAL and CoFID: `headerMappingCheck` fails the build on any header that is not in the real sheet, and Task 8's `--report-unmapped` run completes it. Pay particular attention to the four `0.001` factors — AFCD reports fatty acids in milligrams while the canonical unit is grams, and the unit guard cannot check a row whose factor is deliberately not 1.

- [ ] **Step 6: Extend the checked-in-mappings test**

In `backend/internal/foodpack/source/mapping_files_test.go`: `for _, name := range []string{"usda", "cnf", "ciqual", "cofid", "afcd"} {`

- [ ] **Step 7: Register AFCD in the build**

In `backend/cmd/foodpack/main.go`, add `"afcd": loadAFCDDir,` to `loaders` and:

```go
func loadAFCDDir(dir string, sink source.UnmappedSink) ([]format.RefFood, []format.SourceInfo, error) {
	m, err := source.LoadNamedMapping("afcd")
	if err != nil {
		return nil, nil, err
	}
	return source.LoadAFCD(source.AFCDOptions{Dir: dir, Mapping: m, Unmapped: sink})
}
```

- [ ] **Step 8: Run every test**

Run: `cd backend && go test ./... && go vet ./... && gofmt -l .`
Expected: PASS. All five sources are now registered.

- [ ] **Step 9: Commit**

```bash
cd /home/slynch/code/saolrian
git add backend/internal/foodpack/source/ backend/cmd/foodpack/main.go
git commit -m "feat(foodpack): Australian Food Composition Database adapter

The shortest of the four: one per-100g sheet, no cross-sheet join, and
the reader already existed. What it does introduce is the only energy row
in any mapping table whose factor is not 1 -- AFCD publishes kilojoules
and nothing else, so every Australian food would otherwise ship at
4.184x its real energy. There is a test that names that number.

Its fatty acid columns are in milligrams against a canonical unit of
grams, so four more rows carry a deliberate 0.001. The unit guard cannot
check a row whose factor is not 1, which makes those four the rows to
read twice.

AFCD's headings wrap across lines; normaliseHeader already folds that
away, so the mapping table stays readable.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Cross-source agreement and attribution checks

Five sources means five chances at a whole-column unit error, and a golden row only watches one nutrient of one food per source. This task adds the two checks that look at the pack as a whole.

**Cross-source agreement** takes a handful of foods every national dataset carries, finds each source's version, and asserts they agree on energy and the macros within a wide band. Genuine varietal and methodological differences between national labs are real but small — a US banana and an Australian one differ by a few per cent. A source reading kilojoules as kilocalories is off by 318%. One band separates those cleanly.

**Attribution completeness** asserts that every food can be joined to a licence. Four of the five sources require attribution as a condition of use, so a food whose source has no `SourceInfo` row is a licensing problem, not a cosmetic one.

**Files:**
- Create: `backend/cmd/foodpack/crosssource.go`
- Create: `backend/cmd/foodpack/golden/anchors.csv`
- Test: `backend/cmd/foodpack/crosssource_test.go`
- Modify: `backend/cmd/foodpack/verify.go` (register both checks, add `checkAttribution`)
- Modify: `backend/cmd/foodpack/golden/nutrients.csv` (rows for the four new sources)
- Modify: `backend/cmd/foodpack/verify_test.go` (cover `checkAttribution`)

**Interfaces:**
- Consumes: `format.Pack`, `format.RefFood`, `format.SourceInfo`; `food.Decode`; `CheckResult`, `goldenFS` (Plan 1 Task 7).
- Produces: `anchorEntry{Anchor, Source string; NameRegex *regexp.Regexp; Note string}`; `loadAnchorTable() ([]anchorEntry, error)`; `parseAnchorTable(io.Reader) ([]anchorEntry, error)`; `checkCrossSource(format.Pack) CheckResult`; `evalCrossSource(format.Pack, []anchorEntry) CheckResult`; `checkAttribution(format.Pack) CheckResult`.

- [ ] **Step 1: Write the failing cross-source test**

Create `backend/cmd/foodpack/crosssource_test.go`:

```go
package main

import (
	"regexp"
	"strings"
	"testing"

	"github.com/boanntech/saolrian/backend/internal/food"
	"github.com/boanntech/saolrian/backend/internal/foodpack/format"
)

func refFood(source, id, name string, prof food.Profile) format.RefFood {
	return format.RefFood{
		Source: source, SourceID: id, Name: name, Nutrients: food.Encode(prof),
	}
}

func bananaProfile(kcal float64) food.Profile {
	return food.Profile{"energy_kcal": kcal, "protein": 1.1, "fat": 0.3, "carbohydrate": 22}
}

func packOf(sources []string, foods ...format.RefFood) format.Pack {
	p := format.Pack{NutrientKeys: food.Keys(), Foods: foods}
	for _, s := range sources {
		p.Sources = append(p.Sources, format.SourceInfo{
			Source: s, Region: "xx", Licence: "test", URL: "https://example.test", Rows: 1,
		})
	}
	return p
}

var bananaAnchors = []anchorEntry{
	{Anchor: "banana", Source: "usda_sr", NameRegex: regexp.MustCompile(`(?i)^bananas, raw$`)},
	{Anchor: "banana", Source: "cnf", NameRegex: regexp.MustCompile(`(?i)^banana, raw$`)},
	{Anchor: "banana", Source: "afcd", NameRegex: regexp.MustCompile(`(?i)^banana, cavendish`)},
}

func TestCrossSourceAcceptsNormalVariation(t *testing.T) {
	p := packOf([]string{"usda_sr", "cnf", "afcd"},
		refFood("usda_sr", "1", "Bananas, raw", bananaProfile(89)),
		refFood("cnf", "2", "Banana, raw", bananaProfile(89)),
		refFood("afcd", "3", "Banana, cavendish, peeled, raw", bananaProfile(94)),
	)
	got := evalCrossSource(p, bananaAnchors)
	if !got.Pass {
		t.Fatalf("check failed on ordinary between-lab variation: %s", got.Detail)
	}
}

// The bug this whole check exists for: kilojoules shipped as kilocalories.
func TestCrossSourceCatchesKilojouleError(t *testing.T) {
	p := packOf([]string{"usda_sr", "cnf", "afcd"},
		refFood("usda_sr", "1", "Bananas, raw", bananaProfile(89)),
		refFood("cnf", "2", "Banana, raw", bananaProfile(89)),
		refFood("afcd", "3", "Banana, cavendish, peeled, raw", bananaProfile(395)),
	)
	got := evalCrossSource(p, bananaAnchors)
	if got.Pass {
		t.Fatal("a source 4.184x out must fail")
	}
	for _, want := range []string{"afcd", "energy_kcal"} {
		if !strings.Contains(got.Detail, want) {
			t.Errorf("detail %q does not name %q", got.Detail, want)
		}
	}
}

// Two sources is enough to compare; one is not. A single-source pack is a
// legitimate state during development and must not fail the build.
func TestCrossSourceSkipsWhenOnlyOneSourceHasTheFood(t *testing.T) {
	p := packOf([]string{"usda_sr"},
		refFood("usda_sr", "1", "Bananas, raw", bananaProfile(89)),
	)
	got := evalCrossSource(p, bananaAnchors)
	if !got.Pass {
		t.Fatalf("a single-source pack must pass: %s", got.Detail)
	}
	if !strings.Contains(got.Detail, "1 source") {
		t.Errorf("detail should say why nothing was compared: %q", got.Detail)
	}
}

// An anchor whose source is in the pack but whose regex matches nothing is
// a drifted anchor. Passing silently would let the check quietly compare
// nothing at all.
func TestCrossSourceFailsOnDriftedAnchor(t *testing.T) {
	p := packOf([]string{"usda_sr", "cnf"},
		refFood("usda_sr", "1", "Bananas, raw", bananaProfile(89)),
		refFood("cnf", "2", "Banane crue", bananaProfile(89)), // name moved
	)
	got := evalCrossSource(p, bananaAnchors)
	if got.Pass {
		t.Fatal("an anchor matching no food in a present source must fail")
	}
	if !strings.Contains(got.Detail, "cnf") {
		t.Errorf("detail %q does not name the drifted source", got.Detail)
	}
}

// Near zero a relative comparison is meaningless: 0.1 g and 0.3 g of fat
// differ by 200% and both are "no fat".
func TestCrossSourceIgnoresNearZeroValues(t *testing.T) {
	lean := func(fat float64) food.Profile {
		return food.Profile{"energy_kcal": 110, "protein": 23, "fat": fat, "carbohydrate": 0}
	}
	anchors := []anchorEntry{
		{Anchor: "chicken", Source: "usda_sr", NameRegex: regexp.MustCompile(`(?i)^chicken`)},
		{Anchor: "chicken", Source: "cnf", NameRegex: regexp.MustCompile(`(?i)^chicken`)},
	}
	p := packOf([]string{"usda_sr", "cnf"},
		refFood("usda_sr", "1", "Chicken breast, raw", lean(0.1)),
		refFood("cnf", "2", "Chicken breast, raw", lean(0.4)),
	)
	if got := evalCrossSource(p, anchors); !got.Pass {
		t.Fatalf("near-zero values must not fail the check: %s", got.Detail)
	}
}

// A regex matching several foods must resolve the same way on every run.
func TestCrossSourceIsDeterministic(t *testing.T) {
	anchors := []anchorEntry{
		{Anchor: "banana", Source: "usda_sr", NameRegex: regexp.MustCompile(`(?i)banana`)},
		{Anchor: "banana", Source: "cnf", NameRegex: regexp.MustCompile(`(?i)banana`)},
	}
	p := packOf([]string{"usda_sr", "cnf"},
		refFood("usda_sr", "9", "Bananas, dehydrated", bananaProfile(346)),
		refFood("usda_sr", "1", "Bananas, raw", bananaProfile(89)),
		refFood("cnf", "2", "Banana, raw", bananaProfile(89)),
	)
	for i := 0; i < 5; i++ {
		// SourceID 1 sorts below 9, so the raw banana is always chosen and
		// the dehydrated one never decides the outcome.
		if got := evalCrossSource(p, anchors); !got.Pass {
			t.Fatalf("run %d: %s", i, got.Detail)
		}
	}
}

func TestCheckedInAnchorTableParses(t *testing.T) {
	entries, err := loadAnchorTable()
	if err != nil {
		t.Fatalf("loadAnchorTable: %v", err)
	}
	byAnchor := map[string]int{}
	for _, e := range entries {
		byAnchor[e.Anchor]++
	}
	if len(byAnchor) < 3 {
		t.Errorf("got %d anchor foods, want at least 3", len(byAnchor))
	}
	for anchor, n := range byAnchor {
		// An anchor naming one source can never compare anything.
		if n < 2 {
			t.Errorf("anchor %q names only %d source(s)", anchor, n)
		}
	}
}

func TestParseAnchorTableRejectsBadRows(t *testing.T) {
	for name, body := range map[string]string{
		"empty anchor": "anchor,source,name_regex,note\n,usda_sr,x,\n",
		"empty source": "anchor,source,name_regex,note\nbanana,,x,\n",
		"bad regex":    "anchor,source,name_regex,note\nbanana,usda_sr,[unclosed,\n",
		"duplicate":    "anchor,source,name_regex,note\nbanana,usda_sr,a,\nbanana,usda_sr,b,\n",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseAnchorTable(strings.NewReader(body)); err == nil {
				t.Fatal("want an error")
			}
		})
	}
}
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd backend && go test ./cmd/foodpack/ -run 'CrossSource|AnchorTable' -v`
Expected: FAIL — `undefined: anchorEntry`, `undefined: evalCrossSource`.

- [ ] **Step 3: Write the anchor table**

Create `backend/cmd/foodpack/golden/anchors.csv`:

```csv
anchor,source,name_regex,note
banana,usda_sr,"(?i)^bananas, raw$",SR Legacy NDB 09040
banana,cnf,"(?i)^banana, raw$",CNF FoodID 2
banana,ciqual,"(?i)^banana, pulp, raw$",CIQUAL alim_code 13000
banana,cofid,"(?i)^bananas,.*raw",CoFID names the flesh-only preparation
banana,afcd,"(?i)^banana, cavendish, peeled, raw$",AFCD names the cultivar
milk_whole,usda_foundation,"(?i)^milk, whole, 3\.25% milkfat",Foundation Foods
milk_whole,cnf,"(?i)^milk, fluid, whole, 3\.25%",CNF
milk_whole,ciqual,"(?i)^milk, whole, UHT",CIQUAL
milk_whole,cofid,"(?i)^milk, whole, pasteurised",CoFID
milk_whole,afcd,"(?i)^milk, cow, fluid, whole",AFCD
spinach_raw,usda_sr,"(?i)^spinach, raw$",SR Legacy NDB 11457
spinach_raw,cnf,"(?i)^spinach, raw$",CNF
spinach_raw,ciqual,"(?i)^spinach, raw$",CIQUAL
spinach_raw,cofid,"(?i)^spinach, raw$",CoFID
spinach_raw,afcd,"(?i)^spinach, raw$",AFCD
chicken_breast_raw,usda_sr,"(?i)^chicken, broilers or fryers, breast, meat only, raw$",SR Legacy
chicken_breast_raw,cnf,"(?i)^chicken, broiler, breast, meat only, raw$",CNF
chicken_breast_raw,cofid,"(?i)^chicken, breast, meat only, raw$",CoFID
chicken_breast_raw,afcd,"(?i)^chicken, breast, lean flesh, raw$",AFCD
```

These regexes are anchored on names as each source publishes them, and **Task 8 corrects every one of them against the real data** — a regex that matches nothing in a present source is a hard failure, which is what makes that correction pass loud rather than silent.

- [ ] **Step 4: Implement `crosssource.go`**

Create `backend/cmd/foodpack/crosssource.go`:

```go
package main

import (
	"encoding/csv"
	"fmt"
	"io"
	"math"
	"regexp"
	"sort"
	"strings"

	"github.com/boanntech/saolrian/backend/internal/food"
	"github.com/boanntech/saolrian/backend/internal/foodpack/format"
)

// crossSourceTolerance is how far one source's figure for an anchor food
// may sit from the median of the sources that carry it.
//
// Deliberately wide. Composition genuinely differs between countries —
// cultivar, soil, fortification policy, and each lab's own methods — and
// none of that is an error. What this check is looking for is an entire
// column read in the wrong unit: kilojoules as kilocalories is 318% out,
// milligrams as grams is 99,900% out. Both clear this band by an order of
// magnitude, while no real banana does.
const crossSourceTolerance = 0.25

// crossSourceKeys are the nutrients every source measures for every food,
// so a disagreement is about units rather than coverage.
var crossSourceKeys = []string{"energy_kcal", "protein", "fat", "carbohydrate"}

// crossSourceFloor is the value below which a relative comparison stops
// meaning anything: 0.1 g and 0.4 g of fat differ by 300% and both mean
// "no fat". Anchors include lean meat, so this is load-bearing.
var crossSourceFloor = map[string]float64{
	"energy_kcal":  20,
	"protein":      1,
	"fat":          1,
	"carbohydrate": 1,
}

// anchorEntry names one source's spelling of one anchor food.
type anchorEntry struct {
	Anchor    string
	Source    string
	NameRegex *regexp.Regexp
	Note      string
}

// loadAnchorTable reads the checked-in anchor table. It lives beside the
// golden table and is edited the same way: by a human, in a CSV, when a
// source renames a food.
func loadAnchorTable() ([]anchorEntry, error) {
	f, err := goldenFS.Open("golden/anchors.csv")
	if err != nil {
		return nil, fmt.Errorf("open anchor table: %w", err)
	}
	defer f.Close()
	return parseAnchorTable(f)
}

func parseAnchorTable(r io.Reader) ([]anchorEntry, error) {
	cr := csv.NewReader(r)
	cr.FieldsPerRecord = -1
	rows, err := cr.ReadAll()
	if err != nil {
		return nil, fmt.Errorf("read anchor csv: %w", err)
	}
	if len(rows) < 2 {
		return nil, fmt.Errorf("anchor csv has no rows")
	}

	var out []anchorEntry
	seen := map[string]bool{}
	for i, row := range rows[1:] { // skip header
		line := i + 2
		if len(row) < 3 {
			return nil, fmt.Errorf("line %d: want at least 3 columns, got %d", line, len(row))
		}
		e := anchorEntry{
			Anchor: strings.TrimSpace(row[0]),
			Source: strings.TrimSpace(row[1]),
		}
		if e.Anchor == "" || e.Source == "" {
			return nil, fmt.Errorf("line %d: anchor and source are both required", line)
		}
		key := e.Anchor + "\x00" + e.Source
		if seen[key] {
			return nil, fmt.Errorf("line %d: %s already has a regex for %s", line, e.Anchor, e.Source)
		}
		seen[key] = true
		e.NameRegex, err = regexp.Compile(strings.TrimSpace(row[2]))
		if err != nil {
			return nil, fmt.Errorf("line %d: bad name_regex: %w", line, err)
		}
		if len(row) > 3 {
			e.Note = strings.TrimSpace(row[3])
		}
		out = append(out, e)
	}
	return out, nil
}

func checkCrossSource(p format.Pack) CheckResult {
	entries, err := loadAnchorTable()
	if err != nil {
		return CheckResult{"cross_source", false, fmt.Sprintf("load anchor table: %v", err)}
	}
	return evalCrossSource(p, entries)
}

// evalCrossSource compares each anchor food across every source that
// carries it.
//
// The comparison is against the median rather than the mean: with three or
// more sources, one wildly wrong value drags a mean far enough to put the
// correct sources outside the band and report the wrong culprit.
func evalCrossSource(p format.Pack, entries []anchorEntry) CheckResult {
	present := map[string]bool{}
	for _, s := range p.Sources {
		present[s.Source] = true
	}

	// Anchor order follows first appearance in the table so the report is
	// stable between runs.
	var anchors []string
	byAnchor := map[string][]anchorEntry{}
	for _, e := range entries {
		if _, seen := byAnchor[e.Anchor]; !seen {
			anchors = append(anchors, e.Anchor)
		}
		byAnchor[e.Anchor] = append(byAnchor[e.Anchor], e)
	}

	var failures []string
	compared := 0

	for _, anchor := range anchors {
		matches := map[string]food.Profile{}
		var sourcesInOrder []string
		for _, e := range byAnchor[anchor] {
			if !present[e.Source] {
				continue // this pack has no rows from that source at all
			}
			m := matchAnchor(p, e)
			if m == nil {
				failures = append(failures, fmt.Sprintf(
					"%s: source %s is present but no food name matched %q",
					anchor, e.Source, e.NameRegex.String()))
				continue
			}
			matches[e.Source] = food.Decode(m.Nutrients)
			sourcesInOrder = append(sourcesInOrder, e.Source)
		}
		if len(matches) < 2 {
			continue // nothing to compare
		}

		for _, key := range crossSourceKeys {
			var values []float64
			have := map[string]float64{}
			for _, s := range sourcesInOrder {
				v, ok := matches[s][key]
				if !ok {
					continue
				}
				have[s] = v
				values = append(values, v)
			}
			if len(values) < 2 {
				continue
			}
			med := median(values)
			if med < crossSourceFloor[key] {
				continue // relative agreement is meaningless down here
			}
			compared++
			for _, s := range sourcesInOrder {
				v, ok := have[s]
				if !ok {
					continue
				}
				if dev := math.Abs(v-med) / med; dev > crossSourceTolerance {
					failures = append(failures, fmt.Sprintf(
						"%s/%s: %s = %g but the median across %d sources is %g (%.0f%% out)",
						anchor, s, key, v, len(values), med, dev*100))
				}
			}
		}
	}

	switch {
	case len(failures) > 0:
		return CheckResult{"cross_source", false,
			fmt.Sprintf("%d disagreement(s): %s", len(failures), strings.Join(failures, "; "))}
	case compared == 0:
		return CheckResult{"cross_source", true,
			fmt.Sprintf("%d source(s) in this pack; nothing to compare across", len(p.Sources))}
	default:
		return CheckResult{"cross_source", true,
			fmt.Sprintf("%d nutrient comparisons agree within %.0f%%", compared, crossSourceTolerance*100)}
	}
}

// matchAnchor picks the food a regex names, resolving several matches by
// the lowest SourceID so the same pack always yields the same answer.
func matchAnchor(p format.Pack, e anchorEntry) *format.RefFood {
	var best *format.RefFood
	for i := range p.Foods {
		f := &p.Foods[i]
		if f.Source != e.Source || !e.NameRegex.MatchString(f.Name) {
			continue
		}
		if best == nil || f.SourceID < best.SourceID {
			best = f
		}
	}
	return best
}

func median(v []float64) float64 {
	s := append([]float64(nil), v...)
	sort.Float64s(s)
	n := len(s)
	if n%2 == 1 {
		return s[n/2]
	}
	return (s[n/2-1] + s[n/2]) / 2
}
```

- [ ] **Step 5: Run it to confirm it passes**

Run: `cd backend && go test ./cmd/foodpack/ -run 'CrossSource|AnchorTable' -v`
Expected: PASS.

- [ ] **Step 6: Write the failing attribution test**

Append to `backend/cmd/foodpack/verify_test.go`:

```go
// Four of the five sources require attribution as a condition of use, so a
// food that cannot be joined to a licence row is a licensing defect.
func TestCheckAttributionRequiresASourceRow(t *testing.T) {
	p := format.Pack{
		NutrientKeys: food.Keys(),
		Sources: []format.SourceInfo{
			{Source: "cnf", Region: "ca", Licence: "ogl-canada", URL: "https://example.test", Rows: 1},
		},
		Foods: []format.RefFood{
			refFood("cnf", "1", "Banana, raw", food.Profile{"energy_kcal": 89}),
			refFood("ciqual", "2", "Banane", food.Profile{"energy_kcal": 90}),
		},
	}
	got := checkAttribution(p)
	if got.Pass {
		t.Fatal("a food whose source has no attribution row must fail")
	}
	if !strings.Contains(got.Detail, "ciqual") {
		t.Errorf("detail %q does not name the unattributed source", got.Detail)
	}
}

func TestCheckAttributionRequiresLicenceAndURL(t *testing.T) {
	p := format.Pack{
		NutrientKeys: food.Keys(),
		Sources: []format.SourceInfo{
			{Source: "cnf", Region: "ca", Licence: "", URL: "https://example.test", Rows: 1},
		},
		Foods: []format.RefFood{refFood("cnf", "1", "Banana, raw", food.Profile{"energy_kcal": 89})},
	}
	if got := checkAttribution(p); got.Pass {
		t.Fatal("a source row with no licence must fail")
	}
}

// A Rows count that disagrees with the pack is how an attribution screen
// ends up quoting a number nobody can reproduce.
func TestCheckAttributionRequiresAccurateRowCounts(t *testing.T) {
	p := format.Pack{
		NutrientKeys: food.Keys(),
		Sources: []format.SourceInfo{
			{Source: "cnf", Region: "ca", Licence: "ogl-canada", URL: "https://example.test", Rows: 99},
		},
		Foods: []format.RefFood{refFood("cnf", "1", "Banana, raw", food.Profile{"energy_kcal": 89})},
	}
	if got := checkAttribution(p); got.Pass {
		t.Fatal("a Rows count that disagrees with the pack must fail")
	}
}

func TestCheckAttributionPasses(t *testing.T) {
	p := format.Pack{
		NutrientKeys: food.Keys(),
		Sources: []format.SourceInfo{
			{Source: "cnf", Region: "ca", Licence: "ogl-canada", URL: "https://example.test", Rows: 1},
		},
		Foods: []format.RefFood{refFood("cnf", "1", "Banana, raw", food.Profile{"energy_kcal": 89})},
	}
	if got := checkAttribution(p); !got.Pass {
		t.Fatalf("well-formed pack failed: %s", got.Detail)
	}
}
```

Add `strings` to `verify_test.go`'s imports if it is not already there. `refFood` comes from `crosssource_test.go` in the same package.

- [ ] **Step 7: Implement `checkAttribution` and register both checks**

Append to `backend/cmd/foodpack/verify.go`:

```go
// checkAttribution proves every food can be joined to a licence.
//
// USDA is public domain, but CNF, CIQUAL, CoFID and AFCD are all open
// licences with an attribution condition. The attribution screen is built
// from p.Sources, so a food whose Source has no row there ships
// unattributed — a licensing defect, not a display one.
func checkAttribution(p format.Pack) CheckResult {
	counted := map[string]int{}
	for _, f := range p.Foods {
		counted[f.Source]++
	}
	declared := map[string]format.SourceInfo{}
	for _, s := range p.Sources {
		declared[s.Source] = s
	}

	var problems []string
	// Sorted so a pack with several problems reports them the same way
	// every run.
	for _, name := range sortedKeys(counted) {
		s, ok := declared[name]
		if !ok {
			problems = append(problems, fmt.Sprintf("%d food(s) from %q have no attribution row", counted[name], name))
			continue
		}
		if s.Licence == "" || s.URL == "" || s.Region == "" {
			problems = append(problems, fmt.Sprintf("%q is missing licence, region or url", name))
		}
		if s.Rows != counted[name] {
			problems = append(problems, fmt.Sprintf("%q claims %d rows but the pack holds %d", name, s.Rows, counted[name]))
		}
	}
	for _, s := range p.Sources {
		if counted[s.Source] == 0 {
			problems = append(problems, fmt.Sprintf("%q is attributed but contributed no foods", s.Source))
		}
	}

	if len(problems) > 0 {
		return CheckResult{"attribution", false, strings.Join(problems, "; ")}
	}
	return CheckResult{"attribution", true,
		fmt.Sprintf("%d source(s) attributed, every food joined", len(p.Sources))}
}

func sortedKeys(m map[string]int) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
```

Add `sort` and `strings` to `verify.go`'s imports. Then register both checks in `runChecks`:

```go
func runChecks(p format.Pack) []CheckResult {
	return []CheckResult{
		checkNonEmpty(p),
		checkVocabulary(p),
		checkEnergyPresent(p),
		checkRanges(p),
		checkMacroSum(p),
		checkAtwater(p),
		checkGolden(p),
		checkCrossSource(p),
		checkAttribution(p),
	}
}
```

- [ ] **Step 8: Add golden rows for the four new sources**

Append to `backend/cmd/foodpack/golden/nutrients.csv`:

```csv
cnf,"(?i)^banana, raw$",energy_kcal,89,15,"CNF ""Banana, raw""; anchor food"
cnf,"(?i)^spinach, raw$",iron,2.7,30,"CNF ""Spinach, raw""; mg-unit anchor"
ciqual,"(?i)^banana, pulp, raw$",energy_kcal,90,20,"CIQUAL alim_code 13000; kcal comes from const_code 328, not the kJ column"
ciqual,"(?i)^banana, pulp, raw$",carbohydrate,20,25,"CIQUAL carbohydrate is available carbohydrate, so lower than USDA's by-difference figure"
cofid,"(?i)^bananas,.*raw",energy_kcal,95,25,"CoFID flesh-only banana; kcal column, not kJ"
cofid,"(?i)^bananas,.*raw",vitamin_c,11,50,"CoFID vitamin C; wide tolerance, ascorbic acid varies with storage"
afcd,"(?i)^banana, cavendish, peeled, raw$",energy_kcal,94,25,"AFCD publishes kJ only; a value near 395 means the 0.239006 factor was not applied"
afcd,"(?i)^banana, cavendish, peeled, raw$",protein,1.4,40,AFCD protein; g-unit anchor
```

Tolerances here are wide on purpose. A golden row's job is to catch a factor error, not to police between-lab variation, and these expected values are read off published tables rather than the archives themselves. **Task 8 replaces every expected value with the figure the real build produces and tightens the tolerances.**

- [ ] **Step 9: Run every test**

Run: `cd backend && go test ./... && go vet ./... && gofmt -l .`
Expected: PASS. Note that `checkGolden` skips entries whose source is not in the pack, so the four new rows are inert until Task 8's real build.

- [ ] **Step 10: Commit**

```bash
cd /home/slynch/code/saolrian
git add backend/cmd/foodpack/
git commit -m "feat(foodpack): cross-source agreement and attribution checks

A golden row watches one nutrient of one food per source. With five
sources that leaves most of a mapping table unwatched, and the mistake
that matters -- a whole column read in the wrong unit -- shows up
everywhere at once rather than in the one food a golden row looks at.

cross_source takes four foods every national dataset carries, finds each
source's version through a checked-in regex table, and compares energy
and macros against the median of the sources that have them. The 25% band
is wide enough that real between-country variation passes and narrow
enough that kJ-as-kcal (318% out) or mg-as-g cannot. Comparison is
against the median, not the mean, so one wrong source does not drag the
band far enough to accuse the correct ones. Values below a per-nutrient
floor are skipped: 0.1 g and 0.4 g of fat differ by 300% and both mean
none.

An anchor whose source is present but whose regex matches nothing is a
failure, not a skip, so the check can never pass by comparing nothing.

attribution proves every food joins to a licence row with a licence,
region, URL and an accurate row count. Four of the five sources require
attribution as a condition of use, so this is a licensing check.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: The real-data gate

Everything up to here was proven against fixtures written by the same person who wrote the parser, which proves the parser reads the fixture. This task is the one that finds out whether the mapping tables are right.

**It also closes Plan 1's gate**, which was never run: the USDA food count and pack size that Plan 3's `go:embed` budget depends on come out of this build.

Unlike Tasks 1–7 this is not a TDD cycle. It is an investigation with a known shape, and the loop in Step 4 may run many times. **The rule throughout: when a check fails, fix the mapping table. Never widen a tolerance to make a check pass.** A tolerance is only adjusted after the underlying number has been confirmed correct against the source's own published documentation.

**Files:**
- Modify: `backend/internal/foodpack/source/manifest/sources.csv` (real URLs, pinned hashes)
- Modify: `backend/internal/foodpack/source/mapping/{cnf,ciqual,cofid,afcd}.csv` (correct codes and factors)
- Modify: `backend/cmd/foodpack/golden/nutrients.csv` (real expected values, tightened tolerances)
- Modify: `backend/cmd/foodpack/golden/anchors.csv` (regexes that match the real names)
- Modify: `README.md` (binary size, datasets, attribution)

- [ ] **Step 1: Fetch everything**

```bash
cd backend && go run ./cmd/foodpack fetch --work ./work
```

Add `backend/work/` to `.gitignore` if it is not already ignored — these archives are hundreds of megabytes and must never be committed.

Expect some of the six URLs to 404: all four national sites have moved their downloads before. For each failure, find the current URL on the source's download page, update `manifest/sources.csv`, and re-run with `--source <name>`. If a site requires a click-through that a plain GET cannot satisfy, download by hand into the directory the error names and re-run `build` — the manifest keeps the URL for the record and `build` warns about the unrecorded provenance rather than refusing.

- [ ] **Step 2: Pin every hash**

Each successful fetch prints `UNPINNED — paste this into manifest/sources.csv: <sha256>`. Paste each one into its row, replacing `unpinned`. Then re-run:

```bash
cd backend && go run ./cmd/foodpack fetch --work ./work
```

Expected: every source reports `cached` and `ready`, with no `UNPINNED` lines left. That second run is the proof that the pinning is correct — a mistyped hash fails here rather than six months from now.

- [ ] **Step 3: Complete the mapping tables, one source at a time**

For each of `cnf`, `ciqual`, `cofid`, `afcd` in turn:

```bash
cd backend && go run ./cmd/foodpack build --work ./work --version dev --out /tmp/pack.bin.zst --report-unmapped
```

The first failures will be `ErrMappingNotInSource` — a code or column header in the starter table that the real dataset does not have. Each error names the offending code. Open the source's own nutrient list (`NUTRIENT NAME.csv` for CNF, the `CONST` elements for CIQUAL, the header row for CoFID and AFCD), find the real code, and correct the row. Delete rows for nutrients the source genuinely does not publish.

Once the build gets past the mapping check, read the `--report-unmapped` output. It prints every uncovered code in `source_code,-,1,label` form, ready to paste. For each: either map it to a canonical key, or paste it in as an explicit `-` ignore. **Leave nothing from these four sources unlisted** — the spec's testing section wants every source code to either map or be explicitly ignored, so that a nutrient silently going missing is impossible. CNF, CIQUAL, CoFID and AFCD each publish somewhere between fifty and a couple of hundred nutrients, which makes that achievable.

USDA is the deliberate exception. FDC's `nutrient.csv` carries several hundred entries — individual fatty acids, individual amino acids, isoflavones — that the canonical vocabulary will never hold, and listing them all as ignores would bury the forty rows that matter. Leave `mapping/usda.csv` as it is.

The acceptance criterion for this step: `--report-unmapped` names nothing from `cnf`, `ciqual`, `cofid` or `afcd`.

Watch for these specifically:
- Any nutrient whose canonical unit differs from the source's. The unit guard catches this only when the factor is 1; a row you write with a factor already in it is unguarded, so check it by hand.
- AFCD's four fatty-acid rows at `0.001` and its energy row at `0.239006`. These are the unguarded rows most likely to be wrong.
- Two source codes competing for one canonical key. `LoadMapping` rejects that outright and names both lines; pick the one the source documents as its primary figure.

- [ ] **Step 4: Build and verify, and fix what fails**

```bash
cd backend
go run ./cmd/foodpack build --work ./work --version 2026.09 --out ./work/pack.bin.zst
go run ./cmd/foodpack verify --pack ./work/pack.bin.zst
```

Work through the failures in this order, because each one makes the next easier to read:

1. **ranges** — a value past a nutrient's plausible maximum is almost always a missing unit factor. The message names the food and the nutrient; the fix is in that source's mapping table.
2. **macro_sum** — components summing past 105 g per 100 g usually means a column was mapped to the wrong canonical key (fibre onto carbohydrate, say).
3. **atwater** — the hard per-food gate fires on a single food 100% out. Read the food; the cause is normally an energy row or a macro row with a wrong factor.
4. **cross_source** — a whole source out on `energy_kcal` is a kJ/kcal factor. A source failing "no food name matched" means its anchor regex is wrong: find the food's real name in the pack and correct `golden/anchors.csv`. Correcting a regex is expected here; loosening one until it matches something arbitrary is not.
5. **golden** — with the mapping right, remaining golden failures are the expected values themselves, which were read from published tables rather than these archives.
6. **attribution** — should pass from the start. If it does not, an adapter is returning `SourceInfo` that disagrees with the foods it emitted.

- [ ] **Step 5: Replace the golden expectations with real values**

Once every check passes, go back through `golden/nutrients.csv` and, for each of the eight rows added in Task 7, replace the expected value with the figure this build actually produced and tighten the tolerance to the smallest band that still leaves room for a dataset refresh — 5–10% for a well-measured macro, more for a vitamin that genuinely varies.

This is the step that converts the golden table from "roughly plausible" into a regression test. Record in each row's note where the value came from.

Re-run `verify` and confirm everything still passes.

- [ ] **Step 6: Record the numbers**

```bash
cd backend && ls -la ./work/pack.bin.zst && go run ./cmd/foodpack verify --pack ./work/pack.bin.zst
```

Note the per-source food counts, the total, and the file size in bytes. The design predicts roughly 21,000 foods and 3–5 MB. **If the pack is materially larger than 5 MB, say so in the commit message** — Plan 3 budgets a `go:embed` of this file against a ~15 MB server binary, and that budget needs to know before Plan 3 starts, not during it.

Compare the per-source counts against the design's table (§ Sources): USDA ~7,800, CNF ~5,600, AFCD ~1,600, CIQUAL ~3,200, CoFID ~3,000. A count far below its estimate means foods are being dropped — most likely by `Builder` skipping empty profiles because a mapping table is thin, or by a name column that is empty in the real file.

- [ ] **Step 7: Update the README**

Three edits:

1. Line 11's "a single ~15 MB Go binary" becomes the real post-embed figure. Plan 3 is what embeds the pack, so if that has not happened yet, leave the number and add the pack's size as a note in the commit rather than changing the README prematurely.
2. The food-logging feature line currently credits only Open Food Facts. It should also name the bundled generic-foods pack and the five datasets behind it.
3. Add the attribution the licences require: CNF under OGL-Canada, AFCD under CC-BY 3.0 AU, CIQUAL under Licence Ouverte, CoFID under OGL-UK, USDA public domain. §8 of the design makes this a requirement, not a nicety. The in-app attribution screen is Plan 4's job; the README is the part that is due now.

- [ ] **Step 8: Commit**

```bash
cd /home/slynch/code/saolrian
git add backend/internal/foodpack/source/manifest/ backend/internal/foodpack/source/mapping/ backend/cmd/foodpack/golden/ README.md .gitignore
git commit -m "fix(foodpack): pin and correct the five sources against real data

Replace <these> with the real figures before committing:

Built <N> foods from five sources into a <S> MB pack:
  usda_foundation <n>, usda_sr <n>, cnf <n>, ciqual <n>, cofid <n>, afcd <n>

This also closes Plan 1's gate, which was never run: the USDA counts and
the pack size Plan 3's go:embed budget depends on are the ones above.

Every manifest hash is now pinned, and every mapping table has been
completed against the dataset's own nutrient list, so no source code is
left unlisted -- each one either maps or is an explicit ignore. <Describe
the factor errors the checks caught, and which check caught each.>

Golden expected values are now the figures this build produces rather
than numbers read off published tables, with tolerances tightened to
match. Anchor regexes match the names the sources actually publish.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Verification for the whole plan

```bash
cd backend
go test ./...
go vet ./...
gofmt -l .
go list -deps . | grep -c excelize   # must print 0

go run ./cmd/foodpack fetch  --work ./work
go run ./cmd/foodpack build  --work ./work --version 2026.09 --out ./work/pack.bin.zst --report-unmapped
go run ./cmd/foodpack verify --pack ./work/pack.bin.zst
```

Done means:

- All nine `verify` checks pass over a pack built from all five real datasets.
- Roughly 21,000 foods in 3–5 MB, with each source's count in the neighbourhood the design predicts.
- Every manifest row pinned, and a second `fetch` reports everything cached with no `UNPINNED` lines.
- `--report-unmapped` names no code from `cnf`, `ciqual`, `cofid` or `afcd`.
- `go list -deps .` does not mention `excelize`.

## Follow-on plans

- **Plan 3** — schema migrations, provider layer, cache, aggregator, API, search UI. Its `go:embed` budget starts from the pack size Task 8 records.
- **Plan 4** — micronutrients through diary, recipes, reference values, daily nutrients view, and the in-app attribution screen the four attribution-requiring licences need.

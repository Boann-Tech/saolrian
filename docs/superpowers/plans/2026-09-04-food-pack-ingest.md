# Food Pack Ingest Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the offline `foodpack` tool that turns raw national food-composition datasets into one compressed, verified pack file, and the canonical nutrient vocabulary the whole feature is built on — proven end-to-end on USDA FoodData Central.

**Architecture:** A canonical nutrient vocabulary in `internal/food` defines ~42 keys, each with one unit and a plausible maximum. Nutrient profiles are *sparse* maps (absent means "no data", never zero) that encode to a positional `[]float32` with NaN in absent slots. `internal/foodpack/format` defines the on-disk pack (gob + zstd) and is the only ingest package the server will ever import. `internal/foodpack/source` holds per-source adapters driven by checked-in CSV mapping tables. `cmd/foodpack` is a standalone CLI — never linked into the server binary, so its heavy parsing dependencies cost the server nothing.

**Tech Stack:** Go 1.27, `encoding/csv` + `encoding/gob` (stdlib), `github.com/klauspost/compress/zstd` (new direct dependency), `go test`.

**Spec:** `docs/superpowers/specs/2026-09-04-food-datasources-design.md` (§1 Canonical nutrient model, §3 Ingest pipeline)

## Global Constraints

- Go **1.27**, module `github.com/boanntech/saolrian/backend`. PocketBase pinned at **v0.40.2** — do not upgrade it in this plan.
- **Absent is not zero.** A nutrient with no data is omitted from the profile. Never write `0` to mean "unknown". This rule outranks convenience everywhere.
- All stored values are **per 100 g edible portion**.
- Each canonical nutrient has **exactly one** unit: `kcal`, `g`, `mg`, or `ug`. Conversion happens once, in an adapter, never later.
- **No Go tests exist in this repo yet.** This plan creates the first ones. Run backend tests with `cd backend && go test ./...`.
- Only one new *server-reachable* dependency is permitted: `github.com/klauspost/compress`. Parsing libraries for later adapters (e.g. `excelize`) must be imported only from `cmd/foodpack` or `internal/foodpack/source`, never from packages the server imports.
- Commit after every task. Branch: `feat/multi-source-food-data`.

## File Structure

| File | Responsibility |
|---|---|
| `backend/internal/food/nutrients.go` | Canonical vocabulary: keys, units, groups, plausible maxima, ordering |
| `backend/internal/food/profile.go` | Sparse `Profile`, positional codec, `Scale`, `Validate` |
| `backend/internal/foodpack/format/pack.go` | On-disk pack types + `Read`/`Write`. Server-importable |
| `backend/internal/foodpack/source/mapping.go` | Mapping-table loader: source code → canonical key + factor |
| `backend/internal/foodpack/source/usda.go` | USDA FDC CSV adapter |
| `backend/internal/foodpack/source/mapping/usda.csv` | Checked-in, human-auditable USDA nutrient mapping (under the package so `go:embed` can reach it) |
| `backend/cmd/foodpack/main.go` | CLI: `build`, `verify` |
| `backend/cmd/foodpack/verify.go` | Structural + spot checks over a built pack |

---

### Task 1: Canonical nutrient vocabulary

**Files:**
- Create: `backend/internal/food/nutrients.go`
- Test: `backend/internal/food/nutrients_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `food.Unit` (string type, constants `UnitKcal`, `UnitG`, `UnitMg`, `UnitUg`); `food.Group` (constants `GroupEnergy`, `GroupMacro`, `GroupMineral`, `GroupVitamin`); `food.Nutrient{Key, Label string; Unit Unit; Group Group; Max float64}`; `food.Nutrients []Nutrient` (ordered, stable); `food.Index(key string) (int, bool)`; `food.Lookup(key string) (Nutrient, bool)`; `food.Keys() []string`.

- [ ] **Step 1: Write the failing test**

Create `backend/internal/food/nutrients_test.go`:

```go
package food

import "testing"

func TestVocabularyKeysAreUniqueAndNonEmpty(t *testing.T) {
	seen := map[string]bool{}
	for i, n := range Nutrients {
		if n.Key == "" {
			t.Fatalf("nutrient %d has an empty key", i)
		}
		if seen[n.Key] {
			t.Fatalf("duplicate nutrient key %q", n.Key)
		}
		seen[n.Key] = true
		if n.Max <= 0 {
			t.Errorf("%s: Max must be positive, got %v", n.Key, n.Max)
		}
		switch n.Unit {
		case UnitKcal, UnitG, UnitMg, UnitUg:
		default:
			t.Errorf("%s: unknown unit %q", n.Key, n.Unit)
		}
	}
}

func TestIndexRoundTrips(t *testing.T) {
	for want, n := range Nutrients {
		got, ok := Index(n.Key)
		if !ok {
			t.Fatalf("Index(%q) not found", n.Key)
		}
		if got != want {
			t.Errorf("Index(%q) = %d, want %d", n.Key, got, want)
		}
	}
	if _, ok := Index("not_a_nutrient"); ok {
		t.Error("Index returned ok for an unknown key")
	}
}

func TestEnergyIsFirst(t *testing.T) {
	// Encoding order is part of the pack format; energy staying at slot 0
	// is a cheap canary for an accidental reordering.
	if Nutrients[0].Key != "energy_kcal" {
		t.Fatalf("slot 0 = %q, want energy_kcal", Nutrients[0].Key)
	}
}

func TestKeysMatchNutrientOrder(t *testing.T) {
	ks := Keys()
	if len(ks) != len(Nutrients) {
		t.Fatalf("Keys() len = %d, want %d", len(ks), len(Nutrients))
	}
	for i, k := range ks {
		if k != Nutrients[i].Key {
			t.Errorf("Keys()[%d] = %q, want %q", i, k, Nutrients[i].Key)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/food/ -v`
Expected: FAIL — `undefined: Nutrients`, `undefined: Index`.

- [ ] **Step 3: Write the implementation**

Create `backend/internal/food/nutrients.go`:

```go
// Package food defines the canonical nutrient vocabulary shared by the
// ingest pipeline, the provider layer and the API.
//
// The order of Nutrients is part of the on-disk pack format: packs store
// values positionally. Appending is safe; reordering or removing is not,
// and requires a pack rebuild.
package food

// Unit is a canonical measurement unit. Every nutrient has exactly one.
type Unit string

const (
	UnitKcal Unit = "kcal"
	UnitG    Unit = "g"
	UnitMg   Unit = "mg"
	UnitUg   Unit = "ug"
)

// Group is the display grouping used by the nutrient panel.
type Group string

const (
	GroupEnergy  Group = "energy"
	GroupMacro   Group = "macro"
	GroupMineral Group = "mineral"
	GroupVitamin Group = "vitamin"
)

// Nutrient describes one canonical nutrient.
//
// Max is a deliberately generous per-100g plausible maximum: it exists to
// catch unit errors (a 1000x factor mistake), not to police unusual foods.
// The minimum is always 0.
type Nutrient struct {
	Key   string
	Label string
	Unit  Unit
	Group Group
	Max   float64
}

// Nutrients is the canonical vocabulary in encoding order.
var Nutrients = []Nutrient{
	{"energy_kcal", "Energy", UnitKcal, GroupEnergy, 950},

	{"protein", "Protein", UnitG, GroupMacro, 100},
	{"fat", "Fat", UnitG, GroupMacro, 100},
	{"carbohydrate", "Carbohydrate", UnitG, GroupMacro, 100},
	{"fibre", "Fibre", UnitG, GroupMacro, 100},
	{"sugars", "Sugars", UnitG, GroupMacro, 100},
	{"starch", "Starch", UnitG, GroupMacro, 100},
	{"fat_saturated", "Saturated fat", UnitG, GroupMacro, 100},
	{"fat_monounsaturated", "Monounsaturated fat", UnitG, GroupMacro, 100},
	{"fat_polyunsaturated", "Polyunsaturated fat", UnitG, GroupMacro, 100},
	{"fat_trans", "Trans fat", UnitG, GroupMacro, 100},
	{"cholesterol", "Cholesterol", UnitMg, GroupMacro, 3000},
	{"alcohol", "Alcohol", UnitG, GroupMacro, 100},
	{"water", "Water", UnitG, GroupMacro, 100},
	{"ash", "Ash", UnitG, GroupMacro, 100},
	{"salt", "Salt", UnitG, GroupMacro, 100},

	{"sodium", "Sodium", UnitMg, GroupMineral, 40000},
	{"potassium", "Potassium", UnitMg, GroupMineral, 20000},
	{"calcium", "Calcium", UnitMg, GroupMineral, 20000},
	{"magnesium", "Magnesium", UnitMg, GroupMineral, 5000},
	{"phosphorus", "Phosphorus", UnitMg, GroupMineral, 5000},
	{"iron", "Iron", UnitMg, GroupMineral, 500},
	{"zinc", "Zinc", UnitMg, GroupMineral, 500},
	{"copper", "Copper", UnitMg, GroupMineral, 100},
	{"manganese", "Manganese", UnitMg, GroupMineral, 100},
	{"selenium", "Selenium", UnitUg, GroupMineral, 6000},
	{"iodine", "Iodine", UnitUg, GroupMineral, 10000},

	{"vitamin_a_rae", "Vitamin A (RAE)", UnitUg, GroupVitamin, 40000},
	{"retinol", "Retinol", UnitUg, GroupVitamin, 40000},
	{"carotene_beta", "Beta-carotene", UnitUg, GroupVitamin, 100000},
	{"vitamin_d", "Vitamin D", UnitUg, GroupVitamin, 500},
	{"vitamin_e", "Vitamin E", UnitMg, GroupVitamin, 500},
	{"vitamin_k", "Vitamin K", UnitUg, GroupVitamin, 5000},
	{"vitamin_c", "Vitamin C", UnitMg, GroupVitamin, 3000},
	{"thiamin", "Thiamin (B1)", UnitMg, GroupVitamin, 100},
	{"riboflavin", "Riboflavin (B2)", UnitMg, GroupVitamin, 100},
	{"niacin", "Niacin (B3)", UnitMg, GroupVitamin, 500},
	{"vitamin_b6", "Vitamin B6", UnitMg, GroupVitamin, 100},
	{"folate", "Folate", UnitUg, GroupVitamin, 5000},
	{"vitamin_b12", "Vitamin B12", UnitUg, GroupVitamin, 500},
	{"pantothenate", "Pantothenic acid (B5)", UnitMg, GroupVitamin, 100},
	{"biotin", "Biotin (B7)", UnitUg, GroupVitamin, 1000},
}

var byKey = func() map[string]int {
	m := make(map[string]int, len(Nutrients))
	for i, n := range Nutrients {
		m[n.Key] = i
	}
	return m
}()

// Index returns the encoding slot for key.
func Index(key string) (int, bool) {
	i, ok := byKey[key]
	return i, ok
}

// Lookup returns the nutrient definition for key.
func Lookup(key string) (Nutrient, bool) {
	i, ok := byKey[key]
	if !ok {
		return Nutrient{}, false
	}
	return Nutrients[i], true
}

// Keys returns the canonical keys in encoding order.
func Keys() []string {
	out := make([]string, len(Nutrients))
	for i, n := range Nutrients {
		out[i] = n.Key
	}
	return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/food/ -v`
Expected: PASS — four tests.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/food/nutrients.go backend/internal/food/nutrients_test.go
git commit -m "feat(food): canonical nutrient vocabulary"
```

---

### Task 2: Sparse nutrient profile and positional codec

**Files:**
- Create: `backend/internal/food/profile.go`
- Test: `backend/internal/food/profile_test.go`

**Interfaces:**
- Consumes: `food.Nutrients`, `food.Index`, `food.Lookup` from Task 1.
- Produces: `food.Profile map[string]float64`; `food.Encode(Profile) []float32`; `food.Decode([]float32) Profile`; `food.Scale(Profile, float64) Profile`; `food.Validate(Profile) error`.

- [ ] **Step 1: Write the failing test**

Create `backend/internal/food/profile_test.go`:

```go
package food

import (
	"math"
	"testing"
)

func TestEncodeDecodeRoundTripsAndPreservesAbsence(t *testing.T) {
	// iron is deliberately absent; carbohydrate is deliberately a real zero.
	p := Profile{"energy_kcal": 89, "protein": 1.1, "carbohydrate": 0}

	got := Decode(Encode(p))

	if len(got) != len(p) {
		t.Fatalf("round trip changed key count: got %d, want %d", len(got), len(p))
	}
	if v, ok := got["carbohydrate"]; !ok || v != 0 {
		t.Error("a real zero must survive the round trip as a present zero")
	}
	if _, ok := got["iron"]; ok {
		t.Error("an absent nutrient must not appear after the round trip")
	}
	if math.Abs(got["energy_kcal"]-89) > 0.01 {
		t.Errorf("energy_kcal = %v, want 89", got["energy_kcal"])
	}
}

func TestEncodeUsesNaNForAbsentSlots(t *testing.T) {
	vals := Encode(Profile{"energy_kcal": 100})
	if len(vals) != len(Nutrients) {
		t.Fatalf("encoded length = %d, want %d", len(vals), len(Nutrients))
	}
	ironAt, _ := Index("iron")
	if !math.IsNaN(float64(vals[ironAt])) {
		t.Errorf("absent iron encoded as %v, want NaN", vals[ironAt])
	}
}

func TestDecodeIgnoresUnknownTrailingSlots(t *testing.T) {
	// A pack built with a longer vocabulary must not panic on decode.
	vals := Encode(Profile{"energy_kcal": 100})
	vals = append(vals, 42)
	if got := Decode(vals); got["energy_kcal"] != 100 {
		t.Errorf("energy_kcal = %v, want 100", got["energy_kcal"])
	}
}

func TestScaleKeepsAbsentAbsent(t *testing.T) {
	got := Scale(Profile{"energy_kcal": 89, "protein": 1.1}, 1.5)
	if math.Abs(got["energy_kcal"]-133.5) > 0.001 {
		t.Errorf("energy_kcal = %v, want 133.5", got["energy_kcal"])
	}
	if _, ok := got["iron"]; ok {
		t.Error("Scale invented a nutrient that was absent")
	}
}

func TestValidate(t *testing.T) {
	tests := []struct {
		name    string
		p       Profile
		wantErr bool
	}{
		{"ok", Profile{"energy_kcal": 89, "iron": 0.3}, false},
		{"real zero ok", Profile{"iron": 0}, false},
		{"unknown key", Profile{"unobtainium": 1}, true},
		{"negative", Profile{"iron": -1}, true},
		{"NaN", Profile{"iron": math.NaN()}, true},
		{"unit error looks like over-max", Profile{"iron": 300000}, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := Validate(tc.p)
			if (err != nil) != tc.wantErr {
				t.Errorf("Validate() error = %v, wantErr %v", err, tc.wantErr)
			}
		})
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/food/ -run 'TestEncode|TestDecode|TestScale|TestValidate' -v`
Expected: FAIL — `undefined: Profile`, `undefined: Encode`.

- [ ] **Step 3: Write the implementation**

Create `backend/internal/food/profile.go`:

```go
package food

import (
	"fmt"
	"math"
)

// Profile is a sparse per-100g nutrient profile keyed by canonical key.
//
// Sparseness is semantic, not an optimisation: a key that is absent means
// "this source has no figure for this nutrient". A key present with value
// 0 means "measured, and it is zero". Collapsing the two makes every
// downstream total under-report.
type Profile map[string]float64

// Encode flattens p into a positional slice in canonical order, writing
// NaN into the slots of absent nutrients.
func Encode(p Profile) []float32 {
	out := make([]float32, len(Nutrients))
	nan := float32(math.NaN())
	for i, n := range Nutrients {
		if v, ok := p[n.Key]; ok {
			out[i] = float32(v)
		} else {
			out[i] = nan
		}
	}
	return out
}

// Decode rebuilds a sparse Profile from a positional slice, dropping NaN
// slots. Slots beyond the current vocabulary are ignored so a pack built
// with a longer vocabulary degrades instead of panicking.
func Decode(vals []float32) Profile {
	p := make(Profile)
	for i, v := range vals {
		if i >= len(Nutrients) {
			break
		}
		if math.IsNaN(float64(v)) {
			continue
		}
		p[Nutrients[i].Key] = float64(v)
	}
	return p
}

// Scale returns p multiplied by factor (typically grams/100). Absent
// nutrients stay absent.
func Scale(p Profile, factor float64) Profile {
	out := make(Profile, len(p))
	for k, v := range p {
		out[k] = v * factor
	}
	return out
}

// Validate reports the first value that is not a plausible per-100g figure:
// an unknown key, a negative or non-finite value, or one above the
// nutrient's generous maximum (which almost always means a unit error).
func Validate(p Profile) error {
	for k, v := range p {
		n, ok := Lookup(k)
		if !ok {
			return fmt.Errorf("unknown nutrient key %q", k)
		}
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return fmt.Errorf("%s: value is not finite (%v)", k, v)
		}
		if v < 0 {
			return fmt.Errorf("%s: negative value %v", k, v)
		}
		if v > n.Max {
			return fmt.Errorf("%s: %v %s exceeds plausible maximum %v (unit error?)",
				k, v, n.Unit, n.Max)
		}
	}
	return nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/food/ -v`
Expected: PASS — all tests from Tasks 1 and 2.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/food/profile.go backend/internal/food/profile_test.go
git commit -m "feat(food): sparse nutrient profile with positional codec"
```

---

### Task 3: Pack file format

**Files:**
- Create: `backend/internal/foodpack/format/pack.go`
- Test: `backend/internal/foodpack/format/pack_test.go`
- Modify: `backend/go.mod` (add `github.com/klauspost/compress`)

**Interfaces:**
- Consumes: `food.Keys()` from Task 1.
- Produces: `format.Portion{Label string; Grams float64}`; `format.RefFood{Source, SourceID, Region, Licence, Name, NameLocale, SearchText string; Nutrients []float32; Portions []Portion; DefaultServingG float64}`; `format.SourceInfo{Source, Region, Licence, URL string; Rows int}`; `format.Pack{Version string; BuiltAt time.Time; NutrientKeys []string; Sources []SourceInfo; Foods []RefFood}`; `format.Write(io.Writer, Pack) error`; `format.Read(io.Reader) (Pack, error)`; `format.ErrVocabularyMismatch`.

- [ ] **Step 1: Add the compression dependency**

Run:

```bash
cd backend && go get github.com/klauspost/compress@latest && go mod tidy
```

Expected: `go.mod` gains `github.com/klauspost/compress` as a direct require.

- [ ] **Step 2: Write the failing test**

Create `backend/internal/foodpack/format/pack_test.go`:

```go
package format

import (
	"bytes"
	"errors"
	"testing"
	"time"

	"github.com/boanntech/saolrian/backend/internal/food"
)

func samplePack() Pack {
	return Pack{
		Version:      "2026.09-test",
		BuiltAt:      time.Date(2026, 9, 4, 12, 0, 0, 0, time.UTC),
		NutrientKeys: food.Keys(),
		Sources: []SourceInfo{
			{Source: "usda_sr", Region: "us", Licence: "public-domain",
				URL: "https://fdc.nal.usda.gov/", Rows: 1},
		},
		Foods: []RefFood{{
			Source: "usda_sr", SourceID: "09040", Region: "us",
			Licence: "public-domain", Name: "Bananas, raw",
			SearchText: "bananas raw",
			Nutrients:  food.Encode(food.Profile{"energy_kcal": 89, "protein": 1.09}),
			Portions:   []Portion{{Label: "1 medium", Grams: 118}},
			DefaultServingG: 118,
		}},
	}
}

func TestWriteReadRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	if err := Write(&buf, samplePack()); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if buf.Len() == 0 {
		t.Fatal("Write produced no bytes")
	}

	got, err := Read(&buf)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if got.Version != "2026.09-test" {
		t.Errorf("Version = %q", got.Version)
	}
	if len(got.Foods) != 1 {
		t.Fatalf("Foods len = %d, want 1", len(got.Foods))
	}
	f := got.Foods[0]
	if f.Name != "Bananas, raw" || f.SourceID != "09040" {
		t.Errorf("food round trip wrong: %+v", f)
	}
	if len(f.Portions) != 1 || f.Portions[0].Grams != 118 {
		t.Errorf("portions round trip wrong: %+v", f.Portions)
	}
	prof := food.Decode(f.Nutrients)
	if prof["energy_kcal"] != 89 {
		t.Errorf("energy_kcal = %v, want 89", prof["energy_kcal"])
	}
	if _, ok := prof["iron"]; ok {
		t.Error("absent nutrient survived the pack round trip")
	}
}

func TestReadRejectsVocabularyMismatch(t *testing.T) {
	p := samplePack()
	p.NutrientKeys = []string{"energy_kcal", "protein"} // stale vocabulary

	var buf bytes.Buffer
	if err := Write(&buf, p); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if _, err := Read(&buf); !errors.Is(err, ErrVocabularyMismatch) {
		t.Fatalf("Read error = %v, want ErrVocabularyMismatch", err)
	}
}

func TestReadRejectsGarbage(t *testing.T) {
	if _, err := Read(bytes.NewReader([]byte("not a pack"))); err == nil {
		t.Fatal("Read accepted garbage input")
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && go test ./internal/foodpack/format/ -v`
Expected: FAIL — `undefined: Pack`, `undefined: Write`.

- [ ] **Step 4: Write the implementation**

Create `backend/internal/foodpack/format/pack.go`:

```go
// Package format defines the on-disk food pack: a gob stream compressed
// with zstd.
//
// This is the ONLY foodpack package the server binary imports. Adapters
// and their heavyweight parsers live in sibling packages so they are never
// linked into the server.
package format

import (
	"encoding/gob"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/klauspost/compress/zstd"

	"github.com/boanntech/saolrian/backend/internal/food"
)

// ErrVocabularyMismatch means the pack was built against a different
// canonical nutrient order, so its positional values cannot be trusted.
var ErrVocabularyMismatch = errors.New("pack was built with a different nutrient vocabulary")

// Portion is a household measure for a food.
type Portion struct {
	Label string
	Grams float64
}

// RefFood is one reference food, ready to seed into food_ref.
type RefFood struct {
	Source          string
	SourceID        string
	Region          string
	Licence         string
	Name            string
	NameLocale      string
	SearchText      string
	Nutrients       []float32 // positional, food.Encode order
	Portions        []Portion
	DefaultServingG float64
}

// SourceInfo records provenance and attribution for one dataset.
type SourceInfo struct {
	Source  string
	Region  string
	Licence string
	URL     string
	Rows    int
}

// Pack is a complete built pack.
type Pack struct {
	Version      string
	BuiltAt      time.Time
	NutrientKeys []string // vocabulary the positional values were encoded with
	Sources      []SourceInfo
	Foods        []RefFood
}

// Write encodes p as zstd-compressed gob.
func Write(w io.Writer, p Pack) error {
	zw, err := zstd.NewWriter(w, zstd.WithEncoderLevel(zstd.SpeedBestCompression))
	if err != nil {
		return fmt.Errorf("zstd writer: %w", err)
	}
	if err := gob.NewEncoder(zw).Encode(p); err != nil {
		zw.Close()
		return fmt.Errorf("encode pack: %w", err)
	}
	return zw.Close()
}

// Read decodes a pack and verifies it was built with the current
// vocabulary.
func Read(r io.Reader) (Pack, error) {
	zr, err := zstd.NewReader(r)
	if err != nil {
		return Pack{}, fmt.Errorf("zstd reader: %w", err)
	}
	defer zr.Close()

	var p Pack
	if err := gob.NewDecoder(zr).Decode(&p); err != nil {
		return Pack{}, fmt.Errorf("decode pack: %w", err)
	}

	want := food.Keys()
	if len(p.NutrientKeys) != len(want) {
		return Pack{}, fmt.Errorf("%w: pack has %d keys, binary has %d",
			ErrVocabularyMismatch, len(p.NutrientKeys), len(want))
	}
	for i, k := range want {
		if p.NutrientKeys[i] != k {
			return Pack{}, fmt.Errorf("%w: slot %d is %q in pack, %q in binary",
				ErrVocabularyMismatch, i, p.NutrientKeys[i], k)
		}
	}
	return p, nil
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && go test ./internal/foodpack/... -v`
Expected: PASS — three tests.

- [ ] **Step 6: Commit**

```bash
git add backend/go.mod backend/go.sum backend/internal/foodpack/format/
git commit -m "feat(foodpack): zstd+gob pack format with vocabulary guard"
```

---

### Task 4: Mapping table loader

**Files:**
- Create: `backend/internal/foodpack/source/mapping.go`
- Test: `backend/internal/foodpack/source/mapping_test.go`

**Interfaces:**
- Consumes: `food.Lookup` from Task 1.
- Produces: `source.Mapping`; `source.LoadMapping(io.Reader) (*Mapping, error)`; `(*Mapping).Apply(code string, value float64) (key string, out float64, ok bool)`; `(*Mapping).Known(code string) bool`; `(*Mapping).Codes() []string`; `(*Mapping).UnitFor(code string) (food.Unit, bool)`.

Mapping CSV columns are `source_code,canonical_key,factor,note`. A `canonical_key` of `-` marks a code as deliberately ignored — this is what stops "unmapped" and "intentionally dropped" from looking the same.

- [ ] **Step 1: Write the failing test**

Create `backend/internal/foodpack/source/mapping_test.go`:

```go
package source

import (
	"strings"
	"testing"
)

const goodCSV = `source_code,canonical_key,factor,note
208,energy_kcal,1,kcal
303,iron,1,mg
318,-,1,vitamin A IU superseded by RAE
999,calcium,0.001,source reports ug; canonical is mg
`

func TestLoadMappingApplies(t *testing.T) {
	m, err := LoadMapping(strings.NewReader(goodCSV))
	if err != nil {
		t.Fatalf("LoadMapping: %v", err)
	}

	key, v, ok := m.Apply("208", 89)
	if !ok || key != "energy_kcal" || v != 89 {
		t.Errorf("Apply(208, 89) = %q, %v, %v", key, v, ok)
	}

	key, v, ok = m.Apply("999", 2000)
	if !ok || key != "calcium" || v != 2 {
		t.Errorf("Apply(999, 2000) = %q, %v, %v; want calcium, 2, true", key, v, ok)
	}
}

func TestIgnoredCodesAreKnownButNotApplied(t *testing.T) {
	m, _ := LoadMapping(strings.NewReader(goodCSV))
	if !m.Known("318") {
		t.Error("an explicitly ignored code must count as known")
	}
	if _, _, ok := m.Apply("318", 5); ok {
		t.Error("an ignored code must not produce a value")
	}
	if m.Known("12345") {
		t.Error("an unlisted code must not count as known")
	}
}

func TestLoadMappingRejectsUnknownCanonicalKey(t *testing.T) {
	_, err := LoadMapping(strings.NewReader(
		"source_code,canonical_key,factor,note\n1,unobtainium,1,\n"))
	if err == nil {
		t.Fatal("expected an error for an unknown canonical key")
	}
}

func TestLoadMappingRejectsDuplicateSourceCode(t *testing.T) {
	_, err := LoadMapping(strings.NewReader(
		"source_code,canonical_key,factor,note\n208,energy_kcal,1,\n208,protein,1,\n"))
	if err == nil {
		t.Fatal("expected an error for a duplicate source_code")
	}
}

func TestLoadMappingRejectsZeroFactor(t *testing.T) {
	_, err := LoadMapping(strings.NewReader(
		"source_code,canonical_key,factor,note\n208,energy_kcal,0,\n"))
	if err == nil {
		t.Fatal("expected an error for a zero factor")
	}
}

func TestUnitFor(t *testing.T) {
	m, _ := LoadMapping(strings.NewReader(goodCSV))
	u, ok := m.UnitFor("303")
	if !ok || string(u) != "mg" {
		t.Errorf("UnitFor(303) = %q, %v; want mg, true", u, ok)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/foodpack/source/ -v`
Expected: FAIL — `undefined: LoadMapping`.

- [ ] **Step 3: Write the implementation**

Create `backend/internal/foodpack/source/mapping.go`:

```go
// Package source holds the per-dataset adapters that turn raw downloads
// into canonical reference foods.
//
// Nothing here is imported by the server binary.
package source

import (
	"encoding/csv"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/boanntech/saolrian/backend/internal/food"
)

type mapped struct {
	key    string
	factor float64
}

// Mapping translates one dataset's nutrient codes into canonical keys.
type Mapping struct {
	byCode  map[string]mapped
	ignored map[string]bool
	order   []string
}

// LoadMapping parses a mapping CSV with header
// source_code,canonical_key,factor,note.
//
// A canonical_key of "-" marks the code as deliberately ignored, so an
// unmapped code and a dropped one are distinguishable.
func LoadMapping(r io.Reader) (*Mapping, error) {
	cr := csv.NewReader(r)
	cr.FieldsPerRecord = -1
	rows, err := cr.ReadAll()
	if err != nil {
		return nil, fmt.Errorf("read mapping csv: %w", err)
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("mapping csv is empty")
	}

	m := &Mapping{byCode: map[string]mapped{}, ignored: map[string]bool{}}

	for i, row := range rows[1:] { // skip header
		line := i + 2
		if len(row) < 3 {
			return nil, fmt.Errorf("line %d: want at least 3 columns, got %d", line, len(row))
		}
		code := strings.TrimSpace(row[0])
		key := strings.TrimSpace(row[1])
		if code == "" {
			return nil, fmt.Errorf("line %d: empty source_code", line)
		}
		if _, dup := m.byCode[code]; dup || m.ignored[code] {
			return nil, fmt.Errorf("line %d: duplicate source_code %q", line, code)
		}

		if key == "-" {
			m.ignored[code] = true
			m.order = append(m.order, code)
			continue
		}
		if _, ok := food.Lookup(key); !ok {
			return nil, fmt.Errorf("line %d: unknown canonical key %q", line, key)
		}
		factor, err := strconv.ParseFloat(strings.TrimSpace(row[2]), 64)
		if err != nil {
			return nil, fmt.Errorf("line %d: bad factor: %w", line, err)
		}
		if factor == 0 {
			return nil, fmt.Errorf("line %d: factor must not be zero", line)
		}
		m.byCode[code] = mapped{key: key, factor: factor}
		m.order = append(m.order, code)
	}
	return m, nil
}

// Apply converts a raw source value into a canonical key and value.
// ok is false for ignored and unmapped codes.
func (m *Mapping) Apply(code string, value float64) (string, float64, bool) {
	e, ok := m.byCode[code]
	if !ok {
		return "", 0, false
	}
	return e.key, value * e.factor, true
}

// Known reports whether the code appears in the mapping at all, mapped or
// explicitly ignored.
func (m *Mapping) Known(code string) bool {
	if _, ok := m.byCode[code]; ok {
		return true
	}
	return m.ignored[code]
}

// Codes returns every code in the mapping, in file order.
func (m *Mapping) Codes() []string { return m.order }

// UnitFor returns the canonical unit a mapped code produces.
func (m *Mapping) UnitFor(code string) (food.Unit, bool) {
	e, ok := m.byCode[code]
	if !ok {
		return "", false
	}
	n, ok := food.Lookup(e.key)
	if !ok {
		return "", false
	}
	return n.Unit, true
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/foodpack/source/ -v`
Expected: PASS — six tests.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/foodpack/source/mapping.go backend/internal/foodpack/source/mapping_test.go
git commit -m "feat(foodpack): mapping table loader with explicit-ignore support"
```

---

### Task 5: USDA mapping table

**Files:**
- Create: `backend/internal/foodpack/source/mapping/usda.csv`
- Test: `backend/internal/foodpack/source/mapping_files_test.go`

**Interfaces:**
- Consumes: `source.LoadMapping` from Task 4.
- Produces: the embedded mapping file set. `source.MappingFS` (an `embed.FS` rooted at `backend/internal/foodpack/mapping`) and `source.LoadNamedMapping(name string) (*Mapping, error)`.

Codes are USDA **`nutrient_nbr`** values (the classic stable USDA numbers), not FDC internal `nutrient.id`, because `nutrient_nbr` is stable across releases.

- [ ] **Step 1: Write the failing test**

Create `backend/internal/foodpack/source/mapping_files_test.go`:

```go
package source

import "testing"

func TestCheckedInMappingsLoad(t *testing.T) {
	for _, name := range []string{"usda"} {
		t.Run(name, func(t *testing.T) {
			m, err := LoadNamedMapping(name)
			if err != nil {
				t.Fatalf("LoadNamedMapping(%q): %v", name, err)
			}
			if len(m.Codes()) < 20 {
				t.Errorf("%s mapping has only %d codes; expected a full profile", name, len(m.Codes()))
			}
			if _, _, ok := m.Apply("208", 100); !ok {
				t.Error("usda mapping is missing energy (208)")
			}
		})
	}
}

func TestUSDAMapsEnergyToKcal(t *testing.T) {
	m, err := LoadNamedMapping("usda")
	if err != nil {
		t.Fatalf("LoadNamedMapping: %v", err)
	}
	key, v, ok := m.Apply("208", 89)
	if !ok || key != "energy_kcal" || v != 89 {
		t.Errorf("Apply(208, 89) = %q, %v, %v", key, v, ok)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/foodpack/source/ -run TestCheckedInMappings -v`
Expected: FAIL — `undefined: LoadNamedMapping`.

- [ ] **Step 3: Create the mapping file**

Create `backend/internal/foodpack/source/mapping/usda.csv` (it must live
under the package directory, because `go:embed` cannot reach outside it):

```bash
mkdir -p backend/internal/foodpack/source/mapping
```

```csv
source_code,canonical_key,factor,note
208,energy_kcal,1,Energy (kcal)
203,protein,1,Protein
204,fat,1,Total lipid (fat)
205,carbohydrate,1,Carbohydrate by difference
291,fibre,1,Fiber total dietary
269,sugars,1,Sugars total
209,starch,1,Starch
606,fat_saturated,1,Fatty acids total saturated
645,fat_monounsaturated,1,Fatty acids total monounsaturated
646,fat_polyunsaturated,1,Fatty acids total polyunsaturated
605,fat_trans,1,Fatty acids total trans
601,cholesterol,1,Cholesterol (mg)
221,alcohol,1,Alcohol ethyl
255,water,1,Water
207,ash,1,Ash
307,sodium,1,Sodium (mg)
306,potassium,1,Potassium (mg)
301,calcium,1,Calcium (mg)
304,magnesium,1,Magnesium (mg)
305,phosphorus,1,Phosphorus (mg)
303,iron,1,Iron (mg)
309,zinc,1,Zinc (mg)
312,copper,1,Copper (mg)
315,manganese,1,Manganese (mg)
317,selenium,1,Selenium (ug)
314,iodine,1,Iodine (ug); sparse in SR Legacy
320,vitamin_a_rae,1,Vitamin A RAE (ug)
319,retinol,1,Retinol (ug)
321,carotene_beta,1,Carotene beta (ug)
328,vitamin_d,1,Vitamin D D2+D3 (ug)
323,vitamin_e,1,Vitamin E alpha-tocopherol (mg)
430,vitamin_k,1,Vitamin K phylloquinone (ug)
401,vitamin_c,1,Vitamin C total ascorbic acid (mg)
404,thiamin,1,Thiamin (mg)
405,riboflavin,1,Riboflavin (mg)
406,niacin,1,Niacin (mg)
415,vitamin_b6,1,Vitamin B-6 (mg)
417,folate,1,Folate total (ug)
418,vitamin_b12,1,Vitamin B-12 (ug)
410,pantothenate,1,Pantothenic acid (mg)
318,-,1,Vitamin A IU; superseded by 320 RAE
435,-,1,Folate DFE; superseded by 417 total
```

Note: `salt` and `biotin` are absent from this mapping because USDA reports sodium rather than salt, and biotin is not present in Foundation/SR Legacy. Absent is correct — do not synthesise salt from sodium here.

- [ ] **Step 4: Write the embed loader**

Create `backend/internal/foodpack/source/embed.go`:

```go
package source

import (
	"embed"
	"fmt"
)

// MappingFS holds the checked-in, human-auditable nutrient mapping tables.
// These are the files to open when a number looks wrong.
//
//go:embed all:mapping
var MappingFS embed.FS

// LoadNamedMapping loads the mapping table for one dataset, e.g. "usda".
func LoadNamedMapping(name string) (*Mapping, error) {
	f, err := MappingFS.Open("mapping/" + name + ".csv")
	if err != nil {
		return nil, fmt.Errorf("open mapping %q: %w", name, err)
	}
	defer f.Close()
	return LoadMapping(f)
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && go test ./internal/foodpack/source/ -v`
Expected: PASS — the two new tests plus Task 4's six.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/foodpack/source/
git commit -m "feat(foodpack): checked-in USDA nutrient mapping table"
```

---

### Task 6: USDA adapter

**Files:**
- Create: `backend/internal/foodpack/source/usda.go`
- Test: `backend/internal/foodpack/source/usda_test.go`
- Test fixtures: `backend/internal/foodpack/source/testdata/usda/{food,nutrient,food_nutrient,food_portion,measure_unit}.csv`

**Interfaces:**
- Consumes: `source.Mapping` (Task 4), `format.RefFood`/`format.Portion` (Task 3), `food.Profile`/`food.Encode`/`food.Validate` (Tasks 1–2).
- Produces: `source.USDAOptions{Dir string; DataTypes []string; Mapping *Mapping}`; `source.LoadUSDA(USDAOptions) ([]format.RefFood, error)`; `source.ErrMappingNotInSource`.

The unit guard is the important part: `LoadUSDA` cross-checks each mapped code's `unit_name` in the dataset's own `nutrient.csv` against the canonical unit, so a wrong factor fails the build instead of shipping values off by 1000.

- [ ] **Step 1: Create the test fixtures**

```bash
mkdir -p backend/internal/foodpack/source/testdata/usda
cd backend/internal/foodpack/source/testdata/usda

cat > food.csv <<'CSV'
"fdc_id","data_type","description","food_category_id","publication_date"
"1105314","sr_legacy_food","Bananas, raw","0900","2019-04-01"
"1103648","sr_legacy_food","Spinach, raw","1100","2019-04-01"
"9999999","branded_food","Someone's Cereal","","2019-04-01"
CSV

cat > nutrient.csv <<'CSV'
"id","name","unit_name","nutrient_nbr","rank"
"1008","Energy","KCAL","208","300"
"1003","Protein","G","203","600"
"1089","Iron, Fe","MG","303","5400"
"1162","Vitamin C","MG","401","6300"
"1104","Vitamin A, IU","IU","318","7500"
CSV

cat > food_nutrient.csv <<'CSV'
"id","fdc_id","nutrient_id","amount"
"1","1105314","1008","89.0"
"2","1105314","1003","1.09"
"3","1105314","1162","8.7"
"4","1103648","1008","23.0"
"5","1103648","1089","2.71"
"6","1103648","1104","9377.0"
"7","9999999","1008","400.0"
CSV

cat > measure_unit.csv <<'CSV'
"id","name"
"1000","cup"
"9999","undetermined"
CSV

cat > food_portion.csv <<'CSV'
"id","fdc_id","seq_num","amount","measure_unit_id","portion_description","modifier","gram_weight"
"1","1105314","1","1","9999","","medium (7\" to 7-7/8\" long)","118.0"
"2","1105314","2","1","1000","","sliced","150.0"
"3","1103648","1","1","1000","","","30.0"
CSV
cd -
```

- [ ] **Step 2: Write the failing test**

Create `backend/internal/foodpack/source/usda_test.go`:

```go
package source

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/boanntech/saolrian/backend/internal/food"
)

func TestLoadUSDAFiltersByDataType(t *testing.T) {
	m, _ := LoadNamedMapping("usda")
	foods, err := LoadUSDA(USDAOptions{
		Dir:       filepath.Join("testdata", "usda"),
		DataTypes: []string{"sr_legacy_food"},
		Mapping:   m,
	})
	if err != nil {
		t.Fatalf("LoadUSDA: %v", err)
	}
	if len(foods) != 2 {
		t.Fatalf("got %d foods, want 2 (branded must be excluded)", len(foods))
	}
	for _, f := range foods {
		if f.SourceID == "9999999" {
			t.Error("branded_food row was not filtered out")
		}
	}
}

func TestLoadUSDAMapsNutrientsAndKeepsAbsenceAbsent(t *testing.T) {
	m, _ := LoadNamedMapping("usda")
	foods, _ := LoadUSDA(USDAOptions{
		Dir: filepath.Join("testdata", "usda"), DataTypes: []string{"sr_legacy_food"}, Mapping: m,
	})

	for _, f := range foods {
		if f.SourceID != "1105314" {
			continue
		}
		if f.Name != "Bananas, raw" {
			t.Errorf("Name = %q", f.Name)
		}
		if f.Source != "usda_sr" || f.Region != "us" {
			t.Errorf("Source/Region = %q/%q, want usda_sr/us", f.Source, f.Region)
		}
		p := food.Decode(f.Nutrients)
		if p["energy_kcal"] != 89 {
			t.Errorf("energy_kcal = %v, want 89", p["energy_kcal"])
		}
		if p["vitamin_c"] != 8.7 {
			t.Errorf("vitamin_c = %v, want 8.7", p["vitamin_c"])
		}
		if _, ok := p["iron"]; ok {
			t.Error("banana has no iron row in the fixture; it must be absent, not zero")
		}
		return
	}
	t.Fatal("banana not found in output")
}

func TestLoadUSDASkipsIgnoredCodes(t *testing.T) {
	m, _ := LoadNamedMapping("usda")
	foods, _ := LoadUSDA(USDAOptions{
		Dir: filepath.Join("testdata", "usda"), DataTypes: []string{"sr_legacy_food"}, Mapping: m,
	})
	for _, f := range foods {
		if f.SourceID != "1103648" {
			continue
		}
		p := food.Decode(f.Nutrients)
		// nutrient_nbr 318 (Vitamin A IU) is mapped to "-" and must be dropped.
		if _, ok := p["vitamin_a_rae"]; ok {
			t.Error("ignored code 318 leaked into the profile")
		}
		if p["iron"] != 2.71 {
			t.Errorf("iron = %v, want 2.71", p["iron"])
		}
		return
	}
	t.Fatal("spinach not found in output")
}

func TestLoadUSDAExtractsPortions(t *testing.T) {
	m, _ := LoadNamedMapping("usda")
	foods, _ := LoadUSDA(USDAOptions{
		Dir: filepath.Join("testdata", "usda"), DataTypes: []string{"sr_legacy_food"}, Mapping: m,
	})
	for _, f := range foods {
		if f.SourceID != "1105314" {
			continue
		}
		if len(f.Portions) != 2 {
			t.Fatalf("got %d portions, want 2: %+v", len(f.Portions), f.Portions)
		}
		if f.Portions[0].Grams != 118 {
			t.Errorf("first portion grams = %v, want 118", f.Portions[0].Grams)
		}
		if f.Portions[0].Label == "" {
			t.Error("portion label must not be empty")
		}
		if f.DefaultServingG != 118 {
			t.Errorf("DefaultServingG = %v, want 118 (first portion)", f.DefaultServingG)
		}
		return
	}
	t.Fatal("banana not found in output")
}

func TestLoadUSDARejectsMappedCodeMissingFromSource(t *testing.T) {
	// A mapping referencing a nutrient_nbr the dataset does not define is a
	// stale mapping; the build must fail loudly rather than drop data.
	dir := t.TempDir()
	for _, name := range []string{"food.csv", "nutrient.csv", "food_nutrient.csv", "food_portion.csv", "measure_unit.csv"} {
		b, err := os.ReadFile(filepath.Join("testdata", "usda", name))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, name), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// Strip energy from the dataset's nutrient table.
	if err := os.WriteFile(filepath.Join(dir, "nutrient.csv"),
		[]byte("\"id\",\"name\",\"unit_name\",\"nutrient_nbr\",\"rank\"\n\"1003\",\"Protein\",\"G\",\"203\",\"600\"\n"),
		0o644); err != nil {
		t.Fatal(err)
	}

	m, _ := LoadNamedMapping("usda")
	_, err := LoadUSDA(USDAOptions{Dir: dir, DataTypes: []string{"sr_legacy_food"}, Mapping: m})
	if !errors.Is(err, ErrMappingNotInSource) {
		t.Fatalf("error = %v, want ErrMappingNotInSource", err)
	}
}

func TestLoadUSDARejectsUnitMismatch(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"food.csv", "food_nutrient.csv", "food_portion.csv", "measure_unit.csv"} {
		b, _ := os.ReadFile(filepath.Join("testdata", "usda", name))
		os.WriteFile(filepath.Join(dir, name), b, 0o644)
	}
	// Claim iron is in grams while the canonical unit is mg and the factor is 1.
	os.WriteFile(filepath.Join(dir, "nutrient.csv"), []byte(
		"\"id\",\"name\",\"unit_name\",\"nutrient_nbr\",\"rank\"\n"+
			"\"1008\",\"Energy\",\"KCAL\",\"208\",\"300\"\n"+
			"\"1089\",\"Iron, Fe\",\"G\",\"303\",\"5400\"\n"), 0o644)

	m, _ := LoadNamedMapping("usda")
	_, err := LoadUSDA(USDAOptions{Dir: dir, DataTypes: []string{"sr_legacy_food"}, Mapping: m})
	if err == nil {
		t.Fatal("expected a unit mismatch error")
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && go test ./internal/foodpack/source/ -run TestLoadUSDA -v`
Expected: FAIL — `undefined: LoadUSDA`.

- [ ] **Step 4: Add the shared search-text normaliser**

`LoadUSDA` calls this in the next step, so it lands first — otherwise the
package will not compile mid-task.

Create `backend/internal/foodpack/source/searchtext.go`:

```go
package source

import "strings"

// SearchText normalises a food name for substring matching: lowercased,
// punctuation collapsed to spaces, whitespace squeezed.
func SearchText(name string) string {
	var b strings.Builder
	b.Grow(len(name))
	prevSpace := true
	for _, r := range strings.ToLower(name) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			prevSpace = false
		case r > 127:
			// Keep non-ASCII letters (é, ü) so locale names stay searchable.
			b.WriteRune(r)
			prevSpace = false
		default:
			if !prevSpace {
				b.WriteByte(' ')
				prevSpace = true
			}
		}
	}
	return strings.TrimSpace(b.String())
}
```

Add `backend/internal/foodpack/source/searchtext_test.go`:

```go
package source

import "testing"

func TestSearchText(t *testing.T) {
	tests := map[string]string{
		"Bananas, raw":                  "bananas raw",
		"Cheese,  cheddar (mature)":     "cheese cheddar mature",
		"  Spinach, raw  ":              "spinach raw",
		"Crème fraîche":                 "crème fraîche",
	}
	for in, want := range tests {
		if got := SearchText(in); got != want {
			t.Errorf("SearchText(%q) = %q, want %q", in, got, want)
		}
	}
}
```

- [ ] **Step 5: Write the adapter**

Create `backend/internal/foodpack/source/usda.go`:

```go
package source

import (
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/boanntech/saolrian/backend/internal/food"
	"github.com/boanntech/saolrian/backend/internal/foodpack/format"
)

// ErrMappingNotInSource means the mapping table references a nutrient code
// the dataset does not define — a stale mapping that would silently drop
// data.
var ErrMappingNotInSource = errors.New("mapped nutrient code absent from source dataset")

const (
	usdaLicence = "public-domain"
	usdaRegion  = "us"
)

// USDAOptions configures the FoodData Central adapter.
type USDAOptions struct {
	Dir       string   // directory of extracted FDC CSVs
	DataTypes []string // e.g. "foundation_food", "sr_legacy_food"
	Mapping   *Mapping
}

// LoadUSDA reads the FDC CSV export and returns canonical reference foods.
func LoadUSDA(o USDAOptions) ([]format.RefFood, error) {
	if o.Mapping == nil {
		return nil, errors.New("usda: mapping is required")
	}

	nutrients, err := usdaNutrients(o.Dir)
	if err != nil {
		return nil, err
	}
	if err := usdaCheckMapping(o.Mapping, nutrients); err != nil {
		return nil, err
	}

	foods, order, err := usdaFoods(o.Dir, o.DataTypes)
	if err != nil {
		return nil, err
	}

	profiles := map[string]food.Profile{}
	if err := usdaEachRow(filepath.Join(o.Dir, "food_nutrient.csv"),
		[]string{"fdc_id", "nutrient_id", "amount"},
		func(get func(string) string) error {
			fdcID := get("fdc_id")
			if _, ok := foods[fdcID]; !ok {
				return nil // a food we filtered out
			}
			n, ok := nutrients[get("nutrient_id")]
			if !ok {
				return nil // nutrient not in this release's table
			}
			amount, err := strconv.ParseFloat(strings.TrimSpace(get("amount")), 64)
			if err != nil {
				return nil // blank amounts are common and simply mean no data
			}
			key, value, ok := o.Mapping.Apply(n.number, amount)
			if !ok {
				return nil // unmapped or explicitly ignored
			}
			if profiles[fdcID] == nil {
				profiles[fdcID] = food.Profile{}
			}
			profiles[fdcID][key] = value
			return nil
		}); err != nil {
		return nil, err
	}

	portions, err := usdaPortions(o.Dir, foods)
	if err != nil {
		return nil, err
	}

	out := make([]format.RefFood, 0, len(order))
	for _, fdcID := range order {
		f := foods[fdcID]
		prof := profiles[fdcID]
		if prof == nil {
			continue // no nutrient data at all: not worth shipping
		}
		if err := food.Validate(prof); err != nil {
			return nil, fmt.Errorf("usda %s (%s): %w", fdcID, f.name, err)
		}
		p := portions[fdcID]
		var defaultServing float64
		if len(p) > 0 {
			defaultServing = p[0].Grams
		}
		out = append(out, format.RefFood{
			Source:          f.source,
			SourceID:        fdcID,
			Region:          usdaRegion,
			Licence:         usdaLicence,
			Name:            f.name,
			SearchText:      SearchText(f.name),
			Nutrients:       food.Encode(prof),
			Portions:        p,
			DefaultServingG: defaultServing,
		})
	}
	return out, nil
}

type usdaNutrient struct {
	number string
	unit   string
}

type usdaFood struct {
	name   string
	source string
}

// usdaNutrients maps FDC internal nutrient id -> stable nutrient_nbr + unit.
func usdaNutrients(dir string) (map[string]usdaNutrient, error) {
	out := map[string]usdaNutrient{}
	err := usdaEachRow(filepath.Join(dir, "nutrient.csv"),
		[]string{"id", "unit_name", "nutrient_nbr"},
		func(get func(string) string) error {
			out[get("id")] = usdaNutrient{
				number: strings.TrimSpace(get("nutrient_nbr")),
				unit:   strings.ToUpper(strings.TrimSpace(get("unit_name"))),
			}
			return nil
		})
	return out, err
}

// usdaCheckMapping fails the build when the mapping is stale or its factor
// disagrees with the dataset's declared unit.
func usdaCheckMapping(m *Mapping, nutrients map[string]usdaNutrient) error {
	byNumber := map[string]usdaNutrient{}
	for _, n := range nutrients {
		byNumber[n.number] = n
	}
	for _, code := range m.Codes() {
		n, present := byNumber[code]
		unit, mapped := m.UnitFor(code)
		if !mapped {
			continue // explicitly ignored codes need not exist
		}
		if !present {
			return fmt.Errorf("%w: nutrient_nbr %s", ErrMappingNotInSource, code)
		}
		if want := usdaUnitFor(unit); want != "" && n.unit != want {
			return fmt.Errorf("usda nutrient_nbr %s: source unit %q but canonical unit is %q; check the factor in mapping/usda.csv",
				code, n.unit, unit)
		}
	}
	return nil
}

// usdaUnitFor is the FDC spelling of a canonical unit, or "" when the
// mapping deliberately converts between units (factor != 1).
func usdaUnitFor(u food.Unit) string {
	switch u {
	case food.UnitKcal:
		return "KCAL"
	case food.UnitG:
		return "G"
	case food.UnitMg:
		return "MG"
	case food.UnitUg:
		return "UG"
	}
	return ""
}

func usdaFoods(dir string, dataTypes []string) (map[string]usdaFood, []string, error) {
	want := map[string]bool{}
	for _, dt := range dataTypes {
		want[dt] = true
	}
	foods := map[string]usdaFood{}
	var order []string

	err := usdaEachRow(filepath.Join(dir, "food.csv"),
		[]string{"fdc_id", "data_type", "description"},
		func(get func(string) string) error {
			dt := strings.TrimSpace(get("data_type"))
			if !want[dt] {
				return nil
			}
			name := strings.TrimSpace(get("description"))
			if name == "" {
				return nil
			}
			id := get("fdc_id")
			src := "usda_sr"
			if dt == "foundation_food" {
				src = "usda_foundation"
			}
			foods[id] = usdaFood{name: name, source: src}
			order = append(order, id)
			return nil
		})
	return foods, order, err
}

func usdaPortions(dir string, foods map[string]usdaFood) (map[string][]format.Portion, error) {
	units := map[string]string{}
	if err := usdaEachRow(filepath.Join(dir, "measure_unit.csv"),
		[]string{"id", "name"},
		func(get func(string) string) error {
			units[get("id")] = strings.TrimSpace(get("name"))
			return nil
		}); err != nil {
		return nil, err
	}

	type seqPortion struct {
		seq int
		p   format.Portion
	}
	acc := map[string][]seqPortion{}

	err := usdaEachRow(filepath.Join(dir, "food_portion.csv"),
		[]string{"fdc_id", "seq_num", "amount", "measure_unit_id", "modifier", "gram_weight"},
		func(get func(string) string) error {
			id := get("fdc_id")
			if _, ok := foods[id]; !ok {
				return nil
			}
			grams, err := strconv.ParseFloat(strings.TrimSpace(get("gram_weight")), 64)
			if err != nil || grams <= 0 {
				return nil
			}
			label := usdaPortionLabel(get("amount"), units[get("measure_unit_id")], get("modifier"))
			if label == "" {
				return nil
			}
			seq, _ := strconv.Atoi(strings.TrimSpace(get("seq_num")))
			acc[id] = append(acc[id], seqPortion{seq: seq, p: format.Portion{Label: label, Grams: grams}})
			return nil
		})
	if err != nil {
		return nil, err
	}

	out := make(map[string][]format.Portion, len(acc))
	for id, ps := range acc {
		sort.SliceStable(ps, func(i, j int) bool { return ps[i].seq < ps[j].seq })
		list := make([]format.Portion, 0, len(ps))
		for _, sp := range ps {
			list = append(list, sp.p)
		}
		out[id] = list
	}
	return out, nil
}

// usdaPortionLabel builds "1 medium" / "1 cup, sliced" from FDC's split
// amount / measure unit / modifier columns. "undetermined" is FDC's
// placeholder unit and contributes nothing.
func usdaPortionLabel(amount, unit, modifier string) string {
	amount = strings.TrimSpace(amount)
	unit = strings.TrimSpace(unit)
	modifier = strings.TrimSpace(modifier)
	if unit == "undetermined" {
		unit = ""
	}
	head := strings.TrimSpace(amount + " " + unit)
	switch {
	case head != "" && modifier != "":
		return head + " " + modifier
	case head != "":
		return head
	case modifier != "":
		return modifier
	}
	return ""
}

// usdaEachRow streams a CSV, calling fn with a column accessor. It fails
// fast if any required column is missing from the header.
func usdaEachRow(path string, required []string, fn func(get func(string) string) error) error {
	f, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open %s: %w", filepath.Base(path), err)
	}
	defer f.Close()

	r := csv.NewReader(f)
	r.FieldsPerRecord = -1
	r.ReuseRecord = true
	r.LazyQuotes = true

	header, err := r.Read()
	if err != nil {
		return fmt.Errorf("read header of %s: %w", filepath.Base(path), err)
	}
	col := map[string]int{}
	for i, h := range header {
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
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && go test ./internal/foodpack/... ./internal/food/ -v`
Expected: PASS — all tests, including the two failure-mode tests proving a stale mapping and a unit mismatch both fail the build.

- [ ] **Step 7: Commit**

```bash
git add backend/internal/foodpack/source/
git commit -m "feat(foodpack): USDA FDC adapter with mapping and unit guards"
```

---

### Task 7: foodpack CLI with build and verify

**Files:**
- Create: `backend/cmd/foodpack/main.go`
- Create: `backend/cmd/foodpack/verify.go`
- Test: `backend/cmd/foodpack/verify_test.go`

**Interfaces:**
- Consumes: `source.LoadUSDA`, `source.LoadNamedMapping`, `format.Write`, `format.Read`, `food.Decode`.
- Produces: the `foodpack` binary with `build` and `verify` subcommands, and `runChecks(format.Pack) []CheckResult` / `CheckResult{Name string; Pass bool; Detail string}`.

Verification is structural rather than id-based, so it does not depend on record ids that change between releases. The Atwater check is the strongest of them: it catches a mis-scaled macro without knowing anything about any specific food.

- [ ] **Step 1: Write the failing test**

Create `backend/cmd/foodpack/verify_test.go`:

```go
package main

import (
	"testing"

	"github.com/boanntech/saolrian/backend/internal/food"
	"github.com/boanntech/saolrian/backend/internal/foodpack/format"
)

func packOf(profiles ...food.Profile) format.Pack {
	p := format.Pack{Version: "test", NutrientKeys: food.Keys()}
	for i, prof := range profiles {
		p.Foods = append(p.Foods, format.RefFood{
			Source: "usda_sr", SourceID: string(rune('a' + i)),
			Name: "Test food", Nutrients: food.Encode(prof),
		})
	}
	p.Sources = []format.SourceInfo{{Source: "usda_sr", Rows: len(p.Foods)}}
	return p
}

func result(t *testing.T, p format.Pack, name string) CheckResult {
	t.Helper()
	for _, r := range runChecks(p) {
		if r.Name == name {
			return r
		}
	}
	t.Fatalf("check %q was not run", name)
	return CheckResult{}
}

func TestEnergyPresentCheck(t *testing.T) {
	ok := packOf(food.Profile{"energy_kcal": 89, "protein": 1})
	if !result(t, ok, "energy_present").Pass {
		t.Error("energy_present failed on a pack where every food has energy")
	}

	bad := packOf(food.Profile{"protein": 1})
	if result(t, bad, "energy_present").Pass {
		t.Error("energy_present passed on a food with no energy value")
	}
}

func TestRangesCheckCatchesUnitError(t *testing.T) {
	bad := packOf(food.Profile{"energy_kcal": 89, "iron": 300000})
	if result(t, bad, "ranges").Pass {
		t.Error("ranges passed on an implausible iron value")
	}
}

func TestAtwaterCheck(t *testing.T) {
	// 4*1.09 + 4*22.8 + 9*0.33 = 98.5 kcal vs a declared 89: ~10% off, fine.
	ok := packOf(food.Profile{
		"energy_kcal": 89, "protein": 1.09, "carbohydrate": 22.8, "fat": 0.33,
	})
	if !result(t, ok, "atwater").Pass {
		t.Error("atwater failed on a plausible banana")
	}

	// Fat scaled by 10 — the classic unit slip Atwater is here to catch.
	bad := packOf(food.Profile{
		"energy_kcal": 89, "protein": 1.09, "carbohydrate": 22.8, "fat": 33,
	})
	if result(t, bad, "atwater").Pass {
		t.Error("atwater passed on a food whose macros cannot produce its energy")
	}
}

func TestMacroSumCheck(t *testing.T) {
	bad := packOf(food.Profile{
		"energy_kcal": 89, "protein": 60, "carbohydrate": 60, "fat": 60, "water": 60,
	})
	if result(t, bad, "macro_sum").Pass {
		t.Error("macro_sum passed on components totalling far more than 100 g")
	}
}

func TestVocabularyCheck(t *testing.T) {
	bad := packOf(food.Profile{"energy_kcal": 89})
	bad.NutrientKeys = []string{"energy_kcal"}
	if result(t, bad, "vocabulary").Pass {
		t.Error("vocabulary passed on a pack built with a stale key list")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./cmd/foodpack/ -v`
Expected: FAIL — `undefined: runChecks`, `undefined: CheckResult`.

- [ ] **Step 3: Write the checks**

Create `backend/cmd/foodpack/verify.go`:

```go
package main

import (
	"fmt"
	"math"

	"github.com/boanntech/saolrian/backend/internal/food"
	"github.com/boanntech/saolrian/backend/internal/foodpack/format"
)

// CheckResult is the outcome of one verification check.
type CheckResult struct {
	Name   string
	Pass   bool
	Detail string
}

// atwaterTolerance is the fraction by which a food's declared energy may
// differ from its macro-derived estimate before it counts as suspect.
// Fibre, polyols and organic acids make a tight bound impossible.
const atwaterTolerance = 0.30

// atwaterMaxSuspectFraction is how many suspect foods the pack may contain
// before the check fails outright.
const atwaterMaxSuspectFraction = 0.10

// runChecks runs every structural check over a built pack.
func runChecks(p format.Pack) []CheckResult {
	return []CheckResult{
		checkVocabulary(p),
		checkEnergyPresent(p),
		checkRanges(p),
		checkMacroSum(p),
		checkAtwater(p),
	}
}

func checkVocabulary(p format.Pack) CheckResult {
	want := food.Keys()
	if len(p.NutrientKeys) != len(want) {
		return CheckResult{"vocabulary", false,
			fmt.Sprintf("pack has %d keys, binary has %d", len(p.NutrientKeys), len(want))}
	}
	for i, k := range want {
		if p.NutrientKeys[i] != k {
			return CheckResult{"vocabulary", false,
				fmt.Sprintf("slot %d is %q in pack, %q in binary", i, p.NutrientKeys[i], k)}
		}
	}
	return CheckResult{"vocabulary", true, fmt.Sprintf("%d keys match", len(want))}
}

func checkEnergyPresent(p format.Pack) CheckResult {
	missing := 0
	for _, f := range p.Foods {
		if _, ok := food.Decode(f.Nutrients)["energy_kcal"]; !ok {
			missing++
		}
	}
	return CheckResult{"energy_present", missing == 0,
		fmt.Sprintf("%d of %d foods have no energy value", missing, len(p.Foods))}
}

func checkRanges(p format.Pack) CheckResult {
	for _, f := range p.Foods {
		if err := food.Validate(food.Decode(f.Nutrients)); err != nil {
			return CheckResult{"ranges", false,
				fmt.Sprintf("%s/%s (%s): %v", f.Source, f.SourceID, f.Name, err)}
		}
	}
	return CheckResult{"ranges", true, fmt.Sprintf("%d foods within plausible ranges", len(p.Foods))}
}

func checkMacroSum(p format.Pack) CheckResult {
	// Components of 100 g cannot sum to much more than 100 g. 105 allows for
	// independent rounding across a dataset's own columns.
	const limit = 105.0
	for _, f := range p.Foods {
		prof := food.Decode(f.Nutrients)
		sum := 0.0
		for _, k := range []string{"protein", "fat", "carbohydrate", "water", "ash", "alcohol"} {
			sum += prof[k] // absent reads as 0, which only makes the check laxer
		}
		if sum > limit {
			return CheckResult{"macro_sum", false,
				fmt.Sprintf("%s/%s (%s): components sum to %.1f g per 100 g", f.Source, f.SourceID, f.Name, sum)}
		}
	}
	return CheckResult{"macro_sum", true, "no food exceeds 105 g of components per 100 g"}
}

func checkAtwater(p format.Pack) CheckResult {
	checked, suspect := 0, 0
	var worst string
	worstDev := 0.0

	for _, f := range p.Foods {
		prof := food.Decode(f.Nutrients)
		kcal, okE := prof["energy_kcal"]
		pro, okP := prof["protein"]
		carb, okC := prof["carbohydrate"]
		fat, okF := prof["fat"]
		if !okE || !okP || !okC || !okF || kcal < 20 {
			continue // too little energy for a ratio to mean anything
		}
		checked++
		est := 4*pro + 4*carb + 9*fat + 7*prof["alcohol"]
		dev := math.Abs(est-kcal) / kcal
		if dev > atwaterTolerance {
			suspect++
			if dev > worstDev {
				worstDev, worst = dev, fmt.Sprintf("%s/%s (%s): declared %.0f kcal, macros imply %.0f", f.Source, f.SourceID, f.Name, kcal, est)
			}
		}
	}

	if checked == 0 {
		return CheckResult{"atwater", true, "no food had all three macros; nothing to check"}
	}
	frac := float64(suspect) / float64(checked)
	detail := fmt.Sprintf("%d of %d checked foods (%.1f%%) deviate over %.0f%%",
		suspect, checked, frac*100, atwaterTolerance*100)
	if worst != "" {
		detail += "; worst: " + worst
	}
	return CheckResult{"atwater", frac <= atwaterMaxSuspectFraction, detail}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./cmd/foodpack/ -v`
Expected: PASS — five tests.

- [ ] **Step 5: Write the CLI**

Create `backend/cmd/foodpack/main.go`:

```go
// Command foodpack builds and verifies the bundled food reference pack.
//
// It is never linked into the server binary: the server imports only
// internal/foodpack/format.
//
//	foodpack build  --usda ./work/usda --version 2026.09 --out ./pack.bin.zst
//	foodpack verify --pack ./pack.bin.zst
package main

import (
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/boanntech/saolrian/backend/internal/food"
	"github.com/boanntech/saolrian/backend/internal/foodpack/format"
	"github.com/boanntech/saolrian/backend/internal/foodpack/source"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: foodpack <build|verify> [flags]")
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "build":
		err = buildCmd(os.Args[2:])
	case "verify":
		err = verifyCmd(os.Args[2:])
	default:
		err = fmt.Errorf("unknown subcommand %q", os.Args[1])
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "foodpack:", err)
		os.Exit(1)
	}
}

func buildCmd(args []string) error {
	fs := flag.NewFlagSet("build", flag.ExitOnError)
	usdaDir := fs.String("usda", "", "directory of extracted USDA FDC CSVs")
	version := fs.String("version", "", "pack version, e.g. 2026.09")
	out := fs.String("out", "", "output pack path")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *version == "" || *out == "" {
		return fmt.Errorf("--version and --out are required")
	}

	pack := format.Pack{
		Version:      *version,
		BuiltAt:      time.Now().UTC(),
		NutrientKeys: food.Keys(),
	}

	if *usdaDir != "" {
		m, err := source.LoadNamedMapping("usda")
		if err != nil {
			return err
		}
		foods, err := source.LoadUSDA(source.USDAOptions{
			Dir:       *usdaDir,
			DataTypes: []string{"foundation_food", "sr_legacy_food"},
			Mapping:   m,
		})
		if err != nil {
			return fmt.Errorf("usda: %w", err)
		}
		pack.Foods = append(pack.Foods, foods...)
		pack.Sources = append(pack.Sources, format.SourceInfo{
			Source: "usda", Region: "us", Licence: "public-domain",
			URL: "https://fdc.nal.usda.gov/", Rows: len(foods),
		})
		fmt.Printf("usda: %d foods\n", len(foods))
	}

	if len(pack.Foods) == 0 {
		return fmt.Errorf("no sources produced any foods; pass at least one source directory")
	}

	f, err := os.Create(*out)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := format.Write(f, pack); err != nil {
		return err
	}

	st, err := f.Stat()
	if err != nil {
		return err
	}
	fmt.Printf("wrote %s: %d foods, %.1f MB\n", *out, len(pack.Foods), float64(st.Size())/(1<<20))
	return nil
}

func verifyCmd(args []string) error {
	fs := flag.NewFlagSet("verify", flag.ExitOnError)
	packPath := fs.String("pack", "", "pack file to verify")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *packPath == "" {
		return fmt.Errorf("--pack is required")
	}

	f, err := os.Open(*packPath)
	if err != nil {
		return err
	}
	defer f.Close()

	pack, err := format.Read(f)
	if err != nil {
		return err
	}

	failed := false
	for _, r := range runChecks(pack) {
		status := "PASS"
		if !r.Pass {
			status, failed = "FAIL", true
		}
		fmt.Printf("%-16s %s  %s\n", r.Name, status, r.Detail)
	}
	if failed {
		return fmt.Errorf("verification failed")
	}
	fmt.Printf("\n%s: %d foods from %d sources, all checks passed\n",
		pack.Version, len(pack.Foods), len(pack.Sources))
	return nil
}
```

- [ ] **Step 6: Verify the CLI compiles and the whole suite is green**

Run:

```bash
cd backend && go vet ./... && go build ./... && go test ./... -v
```

Expected: no vet findings, clean build, all tests PASS.

- [ ] **Step 7: Prove the pipeline end-to-end on the fixture data**

Run:

```bash
cd backend
go run ./cmd/foodpack build --usda ./internal/foodpack/source/testdata/usda \
  --version 0.0.0-fixture --out /tmp/fixture-pack.bin.zst
go run ./cmd/foodpack verify --pack /tmp/fixture-pack.bin.zst
```

Expected: `build` reports `usda: 2 foods` and writes the file; `verify` prints five PASS lines and exits 0.

- [ ] **Step 8: Commit**

```bash
git add backend/cmd/foodpack/
git commit -m "feat(foodpack): build and verify CLI with structural checks"
```

---

## Verification for the whole plan

Before considering Plan 1 done, run against the **real** USDA download (not fixtures):

```bash
# Download "Foundation Foods" and "SR Legacy" CSV exports from
# https://fdc.nal.usda.gov/download-datasets.html and extract both into
# ./work/usda so the CSVs share one directory.
cd backend
go run ./cmd/foodpack build --usda ./work/usda --version 2026.09 --out ./work/pack.bin.zst
go run ./cmd/foodpack verify --pack ./work/pack.bin.zst
```

Expected: roughly 7,000–8,500 foods, a pack of a few MB, all five checks passing. Record the actual food count and file size in the commit message — Plan 3's `go:embed` binary-size budget depends on them.

If `ranges` or `atwater` fails on real data, that is the pipeline working. Read the reported food, open `internal/foodpack/source/mapping/usda.csv`, and fix the factor — do not widen the tolerances to make the check pass.

## Follow-on plans

- **Plan 2** — CNF, CIQUAL, CoFID and AFCD adapters, each a self-contained task against this same `Mapping` + `LoadX` shape. `excelize` enters here, imported only by `internal/foodpack/source`.
- **Plan 3** — schema migrations, provider layer, cache, aggregator, API, search UI.
- **Plan 4** — micronutrients through diary, recipes, reference values, daily nutrients view, attribution screen.

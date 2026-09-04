# Multi-source food data layer with micronutrient tracking

Date: 2026-09-04
Status: Approved design, pending implementation plan

## Goal

Give Saolrian real coverage of *generic whole foods* ("1 medium banana",
"150 g ribeye") alongside the branded/barcode coverage Open Food Facts
already provides, by bundling the open national food-composition datasets
into the binary; put every source behind one provider interface with a
caching layer; and carry the full micronutrient profile those datasets
contain all the way through to a daily nutrients view in the UI.

## Why now

Open Food Facts is excellent for packaged goods with a barcode and poor
for unpackaged staples — the foods people eat most. Today
`backend/internal/routes/food.go` is a single OFF-specific file with no
abstraction and, notably, **no cache read path**: `cacheOFFProduct` writes
rows into `foods` that nothing ever reads back, so every search is a live
network round trip. Adding a second source means either duplicating that
file or building the seam properly now.

## Decisions

These were settled during brainstorming and are not open questions:

| Decision | Choice |
|---|---|
| Data delivery | Bundled generic-foods pack, seeded by migration |
| Nutrient scope | Full micronutrient profile, surfaced in UI |
| Spec structure | One combined spec (data layer + UI) |
| Pack storage | New `food_ref` collection inside `pb_data` |
| Cross-source duplicates | Keep all rows, rank by user region |
| Diary micronutrients | Sparse `nutrients` JSON snapshot per entry |
| Reference values | Both US DRI and EU NRV, selected by region |
| Architecture | Provider registry + cache decorator |
| Recipes | Included, with per-nutrient completeness tracking |

### Sources

| Source | Region | Approx. rows | Format | Licence |
|---|---|---|---|---|
| USDA FDC (Foundation + SR Legacy) | us | ~7,800 | CSV | Public domain |
| Canadian Nutrient File | ca | ~5,600 | CSV | OGL-Canada |
| Australian Food Composition DB | au | ~1,600 | XLSX | CC-BY 3.0 AU |
| CIQUAL (ANSES) | fr | ~3,200 | XML/CSV | Licence Ouverte |
| CoFID (McCance & Widdowson) | uk | ~3,000 | XLSX | OGL-UK |

Row counts are approximate and must be asserted by the ingest build once
the real archives are downloaded. **USDA Branded is explicitly excluded** —
OFF already covers that ground.

## Non-goals

- USDA Branded ingestion (multi-GB, redundant with OFF).
- A live USDA FDC API provider. The interface must make it a one-file
  addition; the implementation is a stub left unregistered.
- Micronutrient history, trends, or week-level aggregation. Day-level only.
- Any interpretation of the numbers. Bars and percentages against
  published reference values; no "you are low on iron" advice.
- Full-text search ranking via FTS5. ~21k rows scan fast enough with
  `LIKE`; revisit only if measurement says otherwise.

---

## 1. Canonical nutrient model

A fixed vocabulary of canonical nutrient keys defined in Go
(`backend/internal/food/nutrients.go`), EuroFIR-aligned where the mapping
is clean. Roughly 40 keys across four groups:

- **Energy**: `energy_kcal`
- **Macro & proximate**: `protein`, `fat`, `carbohydrate`, `fibre`,
  `sugars`, `starch`, `fat_saturated`, `fat_monounsaturated`,
  `fat_polyunsaturated`, `fat_trans`, `cholesterol`, `alcohol`, `water`,
  `ash`, `salt`
- **Minerals**: `sodium`, `potassium`, `calcium`, `magnesium`,
  `phosphorus`, `iron`, `zinc`, `copper`, `manganese`, `selenium`,
  `iodine`
- **Vitamins**: `vitamin_a_rae`, `retinol`, `carotene_beta`, `vitamin_d`,
  `vitamin_e`, `vitamin_k`, `vitamin_c`, `thiamin`, `riboflavin`,
  `niacin`, `vitamin_b6`, `folate`, `vitamin_b12`, `pantothenate`,
  `biotin`

Each key declares exactly one canonical unit (`kcal`, `g`, `mg`, `ug`) and
a plausible-range pair used for build-time assertions. All values are
stored **per 100 g edible portion**.

### Absent is not zero

This is a load-bearing rule, not a detail. If CoFID carries no selenium
figure for a food, the stored profile must omit the key entirely rather
than record `0`. Consequences that follow from it:

- `nutrients` is a **sparse** map — present keys only.
- Daily totals carry **two distinct coverage figures**, and the spec uses
  the terms consistently throughout:
  - *Per-nutrient coverage* — for a given nutrient, how many of the day's
    entries contributed a value. Shown on each bar.
  - *Entry coverage* — how many of the day's entries carry any nutrient
    data at all. Shown once as a headline above the bars.
- The UI renders a missing nutrient as an em-dash, never `0`.

Violating this makes every daily total under-report, which reads to a user
as a deficiency that does not exist.

### Unit normalization

The main correctness hazard. CoFID reports some values in µg where CIQUAL
uses mg; USDA carries per-nutrient units in its own `nutrient.csv`.
Conversion happens exactly once, in the ingest pipeline, and every
converted value is range-asserted before it reaches the pack.

---

## 2. Schema

### New: `food_ref` (shared reference data)

Seeded from the embedded pack by an idempotent migration. Read-only to
users; served only through the custom routes, like today's OFF cache rows.

| Field | Type | Notes |
|---|---|---|
| `name` | text | required; English/normalized |
| `name_locale` | text | original-language name (CIQUAL French, CNF French) |
| `source` | select | `usda_foundation`, `usda_sr`, `cnf`, `afcd`, `ciqual`, `cofid` |
| `source_id` | text | source's own identifier |
| `region` | select | `us`, `ca`, `au`, `fr`, `uk` |
| `licence` | text | licence identifier for attribution |
| `kcal_per_100g` | number | denormalized for fast list rendering |
| `protein_per_100g` | number | " |
| `carbs_per_100g` | number | " |
| `fat_per_100g` | number | " |
| `nutrients` | json | sparse canonical profile |
| `portions` | json | household measures, see below |
| `default_serving_g` | number | |
| `search_text` | text | lowercased, accent-stripped |
| `pack_version` | text | seed idempotency key |

Indexes: unique `(source, source_id)`; non-unique on `pack_version`.

`portions` is what makes "1 medium banana" work:

```json
[{"label": "1 medium", "grams": 118},
 {"label": "1 cup, sliced", "grams": 150}]
```

USDA `food_portion.csv` and CNF conversion factors provide these; CoFID
and CIQUAL largely do not, and their rows simply carry an empty array.

### New: `food_cache` (live provider rows)

| Field | Type | Notes |
|---|---|---|
| `provider` | select | `off`, `usda` |
| `provider_id` | text | barcode or FDC id |
| `barcode` | text | indexed |
| `name`, `brand` | text | |
| four macros | number | denormalized |
| `nutrients` | json | sparse |
| `default_serving_g` | number | |
| `search_text` | text | see below |
| `fetched_at` | date | TTL basis |

`search_text` on cached rows exists so a *novel* query — one with no
`food_query_cache` entry — can still match previously-cached branded
products locally and return them immediately, ahead of the live OFF
results merged in when they arrive. That is the local-first ordering the
aggregator promises in §4.

Indexes: unique `(provider, provider_id)`; non-unique on `fetched_at`.

### New: `food_query_cache`

Maps a normalized query string to the provider result set. Without this,
caching product rows alone does not speed up repeated *text* searches,
because OFF's ranking cannot be reproduced locally.

| Field | Type | Notes |
|---|---|---|
| `provider` | select | `off`, `usda` |
| `query_norm` | text | lowercased, trimmed, collapsed whitespace |
| `result_ids` | json | ordered `provider_id` list |
| `fetched_at` | date | TTL basis |

Index: unique `(provider, query_norm)`.

### Changed collections

- **`diary_entries`**: add `nutrients` (json, sparse, scaled to the logged
  grams) and `nutrient_coverage` (json — canonical keys the source could
  have supplied, so partial recipe entries are distinguishable from
  complete ones). Existing rows have null, treated as macros-only.
- **`foods`**: add `nutrients` (json) so custom foods may carry micros.
  The `off` value in `source` becomes legacy after migration (§10).
- **`recipes`**: add `total_nutrients` (json) and
  `nutrient_completeness` (json). See §6.
- **`recipe_ingredients`**: add `nutrients` (json).
- **`profiles`**: add `region` (text, ISO country code) and
  `nutrient_reference` (select: `dri`, `nrv`, `auto`; default `auto`).

### Region resolution

`profiles.region` stores an ISO country code, defaulted from browser
locale during onboarding rather than asked as a new question. A Go table
maps country → ordered dataset preference and reference system:

```go
"IE": {Datasets: []string{"cofid", "ciqual", "usda_foundation", ...},
       Reference: "nrv"}
"US": {Datasets: []string{"usda_foundation", "usda_sr", "cnf", ...},
       Reference: "dri"}
```

Unknown countries fall back to a default order with `nrv`.

---

## 3. Ingest pipeline

A separate command, `backend/cmd/foodpack/`, with its adapters, mapping
tables and pack encoder in `backend/internal/foodpack/`. **Never compiled
into the server binary** — the server imports only the pack format
decoder, not the adapters. Run by hand or in CI when datasets update (roughly
yearly). Four stages:

1. **fetch** — download raw archives to a work directory. URLs and SHA-256
   checksums are pinned in a checked-in manifest, so a silently changed
   upstream file fails loudly.
2. **normalize** — per-source adapters map raw rows to canonical
   `RefFood` structs: unit conversion, name normalization, `search_text`
   generation, portion extraction, range assertions.
3. **build** — emit `foodpack.<version>.bin.zst` plus a manifest
   recording per-source row counts, checksums and licences.
4. **verify** — golden assertions against known foods (banana kcal,
   spinach iron, salmon vitamin D, whole milk calcium) within tolerance.

### Adapters are not equal work

- **USDA** and **CNF**: clean multi-file CSV joins.
- **AFCD** and **CoFID**: `.xlsx`, needing a reader such as `excelize`.
- **CIQUAL**: XML.

### Nutrient mapping tables

The genuinely reviewable artifact per source is its mapping table:
source nutrient code → canonical key → conversion factor. These live as
checked-in CSVs under `backend/internal/foodpack/mapping/<source>.csv`,
not as Go maps, because that is the file a human will open when a number
looks wrong.

### Pack encoding and size

Naive named-JSON encoding of ~21k rows × ~40 nutrients is roughly 30 MB.
The pack instead stores nutrients as a **positional float array in
canonical key order** with a NaN sentinel for absent values, expanded to a
named sparse JSON object at seed time. With zstd this should land around
3–5 MB.

**Accepted trade-off:** `go:embed` of that pack takes the server binary
from ~15 MB to roughly 20 MB. The README's "single ~15 MB Go binary" line
must be updated. Self-hosting gains: no API keys, no rate limits, no
network requirement for generic foods.

---

## 4. Provider layer and cache

New package `backend/internal/food/`.

```go
type Query struct {
    Text    string
    Barcode string
    Region  string
    Limit   int
}

type Result struct {
    Ref       string             // "pack:cofid:1234"
    Name      string
    Brand     string
    Source    string
    Region    string
    Kcal100   float64
    Protein100, Carbs100, Fat100 float64
    Nutrients map[string]float64 // sparse; nil in search results
    Portions  []Portion
    Score     float64
}

type Provider interface {
    Name() string
    Search(ctx context.Context, q Query) ([]Result, error)
    Lookup(ctx context.Context, ref string) (*Result, error)
}
```

`Ref` encodes origin (`pack:<source>:<id>`, `cache:off:<barcode>`,
`food:<pbId>`) so the frontend has one opaque identifier to pass back when
logging, and the aggregator routes a lookup without a type switch.

### Implementations

- `userProvider` — today's `searchLocalFoods` over `foods`, behaviour
  unchanged.
- `packProvider` — SQL over `food_ref`, region-aware.
- `offProvider` — today's `offSearch`/`offBarcode`, lifted out of
  `routes/food.go` unchanged in behaviour.
- `usdaProvider` — stub, unregistered. Its existence proves the seam.

### Cache decorator

Wraps *any* live provider rather than being built into OFF:

- **Search**: normalize query, consult `food_query_cache`. A hit newer
  than **30 days** returns the referenced `food_cache` rows with no
  network call. Otherwise call through, then upsert both the rows and the
  query mapping.
- **Lookup**: consult `food_cache` on `(provider, provider_id)`. Fresh
  returns directly. **Stale returns immediately and refreshes in the
  background** — a month-old barcode should not make the user wait on a
  network round trip for macros that almost certainly have not changed.
  Missing fetches synchronously.
- A provider error never evicts good cached data.

### Aggregator

Runs registered providers concurrently under `errgroup` with per-provider
deadlines (local ~2 s, remote ~6 s). Local providers resolve first and
always appear in the response even when OFF is unreachable — today's
graceful degradation, generalized. Per-provider failures are collected
into a `warnings` array; the request itself does not fail.

Ranking multiplies text-match quality (exact > prefix > token > substring)
by a source weight: user foods highest, then region-preferred datasets,
then remaining datasets, then OFF branded. Barcode queries bypass ranking
and go straight to `Lookup`.

Near-duplicates across datasets (same normalized name, different source)
are grouped into one cluster in the response; the UI shows the
region-preferred member with the others expandable. No averaging, no
merging of values.

### Cache pruning

A PocketBase cron (`app.Cron()`) prunes `food_cache` rows older than 90
days that no `diary_entries.food` relation references, and
`food_query_cache` rows older than 90 days. Without this the cache grows
without bound.

---

## 5. API contract

`GET /api/saolrian/food/search?q=&region=&limit=`

```json
{
  "results": [
    { "ref": "pack:cofid:14-123", "name": "Banana, flesh only, raw",
      "brand": "", "source": "cofid", "region": "uk",
      "kcal_per_100g": 79, "protein_per_100g": 1.2,
      "carbs_per_100g": 20.3, "fat_per_100g": 0.3,
      "portions": [{"label": "1 medium", "grams": 118}],
      "has_micros": true, "local": false,
      "duplicates": ["pack:usda_sr:09040"] }
  ],
  "warnings": ["Open Food Facts unreachable: timeout"],
  "attribution": [{"source": "cofid", "licence": "OGL-UK", "url": "..."}]
}
```

Search results deliberately **omit** the ~40-value nutrient map to keep
list payloads small; `has_micros` tells the UI whether a detail fetch is
worthwhile.

**Compatibility.** `AddFood.tsx` already types the response as
`{ results?: Food[]; local?: Food[]; remote?: Food[] }`, so a flat
`results` array is already tolerated. `local` and `remote` stay populated
alongside `results` for one release so a stale cached PWA shell keeps
working, then are dropped.

New and changed endpoints:

- `GET /api/saolrian/food/{ref}` — full nutrient profile and portions for
  one item.
- `GET /api/saolrian/attribution` — the licence list the CC-BY and
  open-government sources require.
- `GET /api/saolrian/food/barcode/{code}` — shape unchanged, gains
  `nutrients`.
- `GET /api/saolrian/summary?date=` — gains `nutrients` day-totals,
  `nutrient_targets` (resolved DRI or NRV), and `coverage`, carrying both
  figures from §1:

```json
"coverage": {
  "entries": {"with_nutrients": 8, "total": 11},
  "per_nutrient": {"iron": {"contributed": 8, "total": 11},
                   "selenium": {"contributed": 3, "total": 11}}
}
```

---

## 6. Recipes

Recipes already use the exact snapshot pattern this design extends:
`recipe_ingredients` denormalizes per-ingredient macros, `recipes`
denormalizes totals, and `sumIngredients` keeps them in sync on save from
the frontend (`frontend/src/lib/recipes.ts`). The micronutrient change is
the same plumbing, one level wider.

- `recipe_ingredients.nutrients` — sparse, scaled to the ingredient's
  grams, captured when the ingredient is picked from search.
- `recipes.total_nutrients` — sparse sum across ingredients.
- `recipes.nutrient_completeness` — per canonical key, how many
  ingredients contributed a value out of how many ingredients have any
  nutrient data at all.
- `sumIngredients` in `frontend/src/lib/nutrition.ts` extends to sparse
  summing and completeness computation.
- Logging N servings scales `total_nutrients / servings × N` into the
  diary entry's `nutrients`, and propagates completeness into
  `nutrient_coverage`.

**Why this is in scope rather than deferred:** without it, every
recipe-sourced diary entry contributes zero micronutrients, so the daily
nutrients view systematically under-reports for anyone who cooks — in the
direction that reads as a deficiency. The feature would ship knowingly
wrong for its most engaged users.

---

## 7. UI

**Search results** (`AddFood.tsx`) gain a source chip — "CoFID", "USDA",
"Open Food Facts" — with region-preferred results first. Where a food
carries `portions`, the quantity input offers household measures
("1 medium, 118 g") alongside grams. Duplicate clusters render under one
heading, expandable to show each source's values.

**Food detail** gains a nutrient panel in three groups (macros, minerals,
vitamins), each row showing amount and % of the resolved reference value.
Nutrients the source lacks render as "—".

**Daily nutrients view** — a section on Today that expands to a full
screen. Bars against DRI or NRV per the resolved region, sorted with
shortfalls at the top since that is the actionable end. Above the bars, a
entry-coverage line: "based on 8 of 11 items logged", with each bar
carrying its own per-nutrient coverage. Quick-add entries and
pre-migration diary rows have no micronutrient data, and without that line
the totals read as deficiencies that are not real.

**Profile** gains region and reference-system selectors.

**Attribution screen**, reachable from Profile, listing each dataset with
its licence and link.

### Reference value tables

Static Go data in `backend/internal/food/reference.go`:

- **US DRI/RDA** — banded by age and sex, reusing `profiles.birth_year`
  and `profiles.sex` already collected for TDEE.
- **EU NRV** — the flat 13-nutrient adult set from Reg. 1169/2011.

`nutrient_reference: auto` resolves from region; `dri`/`nrv` override.

---

## 8. Licensing and attribution

All five sources are open, but not identically:

- USDA FDC — US Government work, public domain. No attribution required.
- CNF — Open Government Licence Canada. Attribution required.
- AFCD — CC-BY 3.0 AU. Attribution required.
- CIQUAL — Licence Ouverte / Open Licence. Attribution required.
- CoFID — Open Government Licence UK. Attribution required.

Therefore `food_ref` carries a per-row `licence`, the build emits an
attribution manifest, `GET /attribution` serves it, and the UI has a
screen that displays it. This is a requirement, not a nicety.

---

## 9. Testing

TDD throughout, per the project's normal workflow.

- **Ingest**: golden-value tests per source with tolerances, plus the
  range assertions in the build. A source changing its column layout must
  fail the build, not ship bad data.
- **Mapping tables**: assert every canonical key referenced by a mapping
  exists, and every source nutrient code either maps or is explicitly
  listed as ignored — no silent drops.
- **Providers**: `httptest` fakes for OFF covering success, 404,
  malformed JSON, and timeout.
- **Cache**: injectable clock. Fresh hit, stale serve-and-refresh, miss,
  and that a provider error does not evict good data.
- **Aggregator**: partial failure — OFF down still returns pack and user
  results plus a warning.
- **Recipes**: sparse summing and completeness, including the case where
  some ingredients have no nutrient data at all.
- **Migration**: fixture DB proving existing `source='off'` rows move to
  `food_cache` with `diary_entries.food` relations intact. Getting this
  wrong orphans real diary history.
- **Frontend**: extend `AddFood.test.tsx`; add coverage for absent-vs-zero
  rendering, the portion picker, and the coverage line.

---

## 10. Rollout and migration

A single upgrade, no user action, no API keys, no network required.

1. Schema migration adds the new collections and fields.
2. Data migration moves existing ownerless `foods` rows with
   `source='off'` into `food_cache`, preserving `diary_entries.food`
   relations (entries already carry macro snapshots, so history is safe
   even if a relation is dropped).
3. Seed migration inserts the pack into `food_ref`, keyed on
   `pack_version` so restarts are cheap and re-seeds are idempotent.
   First boot after upgrade takes a few seconds for ~21k rows.
4. README updated: binary size, the datasets used, and attribution.

## Open risks

- **Ingest is the long pole.** Five adapters across three file formats,
  each with its own nutrient vocabulary. The mapping tables are where bugs
  will hide, which is why they are checked-in CSVs with golden tests.
- **Duplicate clustering by normalized name is heuristic.** Grouping is
  presentation-only and never merges values, so a wrong cluster is a
  cosmetic problem, not a data-correctness one.
- **Coverage honesty depends on discipline.** Every path that writes a
  `nutrients` map must also write coverage. A single path that forgets
  makes the daily view lie.

# Food Provider Layer, Cache and Search API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the 21,833-food reference pack in front of users — seeded into the database, served through a provider layer that merges it with custom foods and Open Food Facts, behind one search endpoint the app already almost speaks.

**Architecture:** A new `backend/internal/foodsearch` package owns a `Provider` interface with four implementations (user foods, the embedded pack, Open Food Facts, and an unregistered USDA stub that proves the seam). A cache decorator wraps any *live* provider — not OFF specifically — backed by two new collections, and an aggregator runs the registered providers concurrently with per-provider deadlines so a slow or dead OFF never blocks local results. `routes/food.go` shrinks to a thin handler over the aggregator.

**Tech Stack:** Go 1.27, PocketBase v0.40.2 (`core.NewBaseCollection`, `app.Cron().MustAdd`), `golang.org/x/sync/errgroup`, `go:embed`, React + TypeScript + Vitest on the frontend.

**Spec:** `docs/superpowers/specs/2026-09-04-food-datasources-design.md` — §2 Schema, §4 Provider layer and cache, §5 API contract, §7 UI (search results only), §9 Testing, §10 Rollout.

**Predecessors:** `docs/superpowers/plans/2026-09-04-food-pack-ingest.md` (Plan 1) and `docs/superpowers/plans/2026-09-05-food-pack-sources.md` (Plan 2), both complete. Plan 2 produced a verified pack: 21,833 foods from 6 sources in **1.8 MB** compressed.

## Global Constraints

- Go 1.27; PocketBase v0.40.2. Do not upgrade either in this plan.
- **The ingest tool must not gain runtime dependencies.** `go list -deps ./cmd/foodpack | grep -c pocketbase` must stay `0`, and `go list -deps . | grep -c excelize` must stay `0`. This is why the provider layer is a new package rather than an addition to `internal/food` — `cmd/foodpack` imports that package, and PocketBase must not follow it in.
- All user-scoped collections use `ownerRule = "user = @request.auth.id"` (`internal/migrations/migrations.go:204`). The three collections added here are **not** user-scoped: they are shared reference and cache data with `nil` rules, reachable only through the custom routes, exactly as today's `source='off'` rows in `foods` are.
- Absent is not zero. A nutrient the source never measured must be absent from the map, never `0`. `food.Profile` and the pack's NaN sentinel already encode this; do not introduce a path that writes zeros.
- No averaging or merging of values across sources, ever. Duplicate clustering is presentation-only.
- New Go files carry a package or type doc comment explaining *why*, matching the density already in `internal/foodpack/source`.
- `gofmt -l` must be clean for every file this plan touches. Four files were already unformatted before this plan (`internal/bootstrap/bootstrap.go`, `internal/routes/food.go`, `internal/routes/summary.go`, `internal/tdee/tdee.go`); `routes/food.go` is rewritten here and must come out formatted.

## Scope

**In this plan:** the three new collections, `profiles.region`, the data migration for existing OFF rows, the pack embed and seed, the provider layer, the cache decorator, the aggregator, cache pruning, the search/lookup/barcode/attribution endpoints, and the search-results UI.

**Deliberately deferred to Plan 4**, because nothing here consumes them: `nutrients` columns on `diary_entries`, `foods`, `recipes` and `recipe_ingredients`; the DRI/NRV reference tables; the daily nutrients view; the food-detail nutrient panel; the in-app attribution screen; `profiles.nutrient_reference`; and the `nutrients`, `nutrient_targets` and `coverage` additions to `GET /api/saolrian/summary` (§5), which cannot be computed until diary entries carry nutrient snapshots. `profiles.region` *is* added here because ranking needs it. Adding unused columns now would be schema debt with no reader.

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `backend/internal/migrations/food_ref.go` | The three new collections and `profiles.region` |
| `backend/internal/migrations/off_to_cache.go` | Moves existing `foods` rows with `source='off'` into `food_cache` |
| `backend/internal/migrations/food_seed.go` | Idempotent seed of the embedded pack into `food_ref` |
| `backend/internal/foodpack/embed.go` | `go:embed` of `pack.bin.zst` plus `Load()` |
| `backend/internal/foodsearch/provider.go` | `Query`, `Result`, `Portion`, `Provider`, `Ref` encoding |
| `backend/internal/foodsearch/user.go` | `userProvider` over the `foods` collection |
| `backend/internal/foodsearch/pack.go` | `packProvider` over `food_ref`, region-aware |
| `backend/internal/foodsearch/off.go` | `offProvider`, lifted from `routes/food.go` |
| `backend/internal/foodsearch/usda.go` | `usdaProvider` stub, unregistered |
| `backend/internal/foodsearch/cache.go` | Cache decorator over any live provider |
| `backend/internal/foodsearch/aggregate.go` | Concurrent fan-out, ranking, clustering, warnings |
| `backend/internal/foodsearch/region.go` | Country → dataset preference table |
| `backend/internal/foodsearch/prune.go` | Cron job pruning both cache collections |
| `frontend/src/lib/foodSearch.ts` | Response types and the clustering helpers the screen needs |

**Modified**

| File | Change |
|---|---|
| `backend/internal/routes/food.go` | Rewritten as thin handlers over the aggregator |
| `backend/internal/routes/summary.go:17-28` | Register `/food/{ref}` and `/attribution` |
| `backend/main.go` | Register the prune cron |
| `frontend/src/lib/types.ts:36-46` | `Food` gains `ref`, `source`, `region`, `portions`, `has_micros` |
| `frontend/src/screens/AddFood.tsx` | Source chips, portion picker, duplicate clusters |

---

### Task 1: The three collections and `profiles.region`

**Files:**
- Create: `backend/internal/migrations/food_ref.go`
- Create: `backend/internal/migrations/food_ref_test.go`

**Interfaces:**
- Consumes: `ownerRule` (`internal/migrations/migrations.go:204`), PocketBase field types.
- Produces: collections `food_ref`, `food_cache`, `food_query_cache`; field `profiles.region`. Every later task reads or writes these by name.

- [ ] **Step 1: Write the failing test**

`backend/internal/migrations/food_ref_test.go`. Follow the existing harness in `trend_cards_test.go` for how a test app is stood up.

```go
package migrations

import "testing"

// The three collections are shared reference and cache data, not user
// rows: nil rules mean they are unreachable through the generated REST
// API and served only by the custom routes, which is how today's
// source='off' rows already behave.
func TestFoodCollectionsExist(t *testing.T) {
	app := testApp(t)

	for _, name := range []string{"food_ref", "food_cache", "food_query_cache"} {
		c, err := app.FindCollectionByNameOrId(name)
		if err != nil {
			t.Fatalf("collection %q missing: %v", name, err)
		}
		if c.ListRule != nil || c.ViewRule != nil {
			t.Errorf("%s is directly listable; it must be served only through custom routes", name)
		}
	}
}

func TestFoodRefHasUniqueSourceIndex(t *testing.T) {
	app := testApp(t)
	c, err := app.FindCollectionByNameOrId("food_ref")
	if err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, idx := range c.Indexes {
		if strings.Contains(idx, "source") && strings.Contains(idx, "source_id") && strings.Contains(idx, "UNIQUE") {
			found = true
		}
	}
	if !found {
		t.Errorf("food_ref has no unique (source, source_id) index; a re-seed would duplicate every row. indexes: %v", c.Indexes)
	}
}

func TestProfilesHasRegion(t *testing.T) {
	app := testApp(t)
	c, err := app.FindCollectionByNameOrId("profiles")
	if err != nil {
		t.Fatal(err)
	}
	if c.Fields.GetByName("region") == nil {
		t.Error("profiles.region missing; ranking cannot resolve a dataset preference without it")
	}
}
```

Add the import for `strings`. If `testApp` does not already exist in this package, copy the pattern from `trend_cards_test.go` verbatim rather than inventing a new harness.

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd backend && go test ./internal/migrations/ -run 'FoodCollections|FoodRefHas|ProfilesHasRegion' -v`
Expected: FAIL, `collection "food_ref" missing`.

- [ ] **Step 3: Implement the migration**

`backend/internal/migrations/food_ref.go`:

```go
// Reference and cache collections for the multi-source food layer.
//
// None of the three is user-scoped. food_ref is shared reference data
// seeded from the embedded pack; food_cache and food_query_cache are a
// shared cache of live provider results. All three have nil rules, so
// PocketBase's generated REST API will not serve them and they are
// reachable only through /api/saolrian routes -- the same arrangement the
// existing source='off' rows in `foods` have today.
package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
	"github.com/pocketbase/pocketbase/tools/types"
)

func init() {
	m.Register(func(app core.App) error {
		// -------------------------------------------------------------
		// food_ref
		// -------------------------------------------------------------
		ref := core.NewBaseCollection("food_ref")
		ref.Fields.Add(
			&core.TextField{Name: "name", Required: true},
			&core.TextField{Name: "name_locale"},
			&core.SelectField{Name: "source", MaxSelect: 1, Values: []string{
				"usda_foundation", "usda_sr", "cnf", "afcd", "ciqual", "cofid",
			}},
			&core.TextField{Name: "source_id", Required: true},
			&core.SelectField{Name: "region", MaxSelect: 1, Values: []string{
				"us", "ca", "au", "fr", "uk",
			}},
			&core.TextField{Name: "licence"},
			// The four macros are denormalized out of `nutrients` so a
			// search result list renders without decoding 40-key JSON per
			// row. Everything else stays in the sparse map.
			&core.NumberField{Name: "kcal_per_100g"},
			&core.NumberField{Name: "protein_per_100g"},
			&core.NumberField{Name: "carbs_per_100g"},
			&core.NumberField{Name: "fat_per_100g"},
			&core.JSONField{Name: "nutrients", MaxSize: 4096},
			&core.JSONField{Name: "portions", MaxSize: 4096},
			&core.NumberField{Name: "default_serving_g"},
			&core.TextField{Name: "search_text"},
			&core.TextField{Name: "pack_version"},
			&core.AutodateField{Name: "created", OnCreate: true},
			&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
		)
		ref.AddIndex("idx_food_ref_source_sourceId", true, "source, source_id", "")
		ref.AddIndex("idx_food_ref_packVersion", false, "pack_version", "")
		ref.AddIndex("idx_food_ref_searchText", false, "search_text", "")
		if err := app.Save(ref); err != nil {
			return err
		}

		// -------------------------------------------------------------
		// food_cache
		// -------------------------------------------------------------
		cache := core.NewBaseCollection("food_cache")
		cache.Fields.Add(
			&core.SelectField{Name: "provider", MaxSelect: 1, Values: []string{"off", "usda"}},
			&core.TextField{Name: "provider_id", Required: true},
			&core.TextField{Name: "barcode"},
			&core.TextField{Name: "name", Required: true},
			&core.TextField{Name: "brand"},
			&core.NumberField{Name: "kcal_per_100g"},
			&core.NumberField{Name: "protein_per_100g"},
			&core.NumberField{Name: "carbs_per_100g"},
			&core.NumberField{Name: "fat_per_100g"},
			&core.JSONField{Name: "nutrients", MaxSize: 4096},
			&core.NumberField{Name: "default_serving_g"},
			// search_text lets a novel query still match a product some
			// earlier search already cached, so local results appear
			// before the network answers.
			&core.TextField{Name: "search_text"},
			&core.DateField{Name: "fetched_at", Required: true},
			&core.AutodateField{Name: "created", OnCreate: true},
			&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
		)
		cache.AddIndex("idx_food_cache_provider_providerId", true, "provider, provider_id", "")
		cache.AddIndex("idx_food_cache_barcode", false, "barcode", "")
		cache.AddIndex("idx_food_cache_fetchedAt", false, "fetched_at", "")
		cache.AddIndex("idx_food_cache_searchText", false, "search_text", "")
		if err := app.Save(cache); err != nil {
			return err
		}

		// -------------------------------------------------------------
		// food_query_cache
		// -------------------------------------------------------------
		// Caching product rows alone does not speed up repeated *text*
		// searches: OFF's ranking cannot be reproduced locally, so the
		// query -> ordered result list mapping has to be stored too.
		qc := core.NewBaseCollection("food_query_cache")
		qc.Fields.Add(
			&core.SelectField{Name: "provider", MaxSelect: 1, Values: []string{"off", "usda"}},
			&core.TextField{Name: "query_norm", Required: true},
			&core.JSONField{Name: "result_ids", MaxSize: 8192},
			&core.DateField{Name: "fetched_at", Required: true},
			&core.AutodateField{Name: "created", OnCreate: true},
			&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
		)
		qc.AddIndex("idx_food_query_cache_provider_queryNorm", true, "provider, query_norm", "")
		qc.AddIndex("idx_food_query_cache_fetchedAt", false, "fetched_at", "")
		if err := app.Save(qc); err != nil {
			return err
		}

		// -------------------------------------------------------------
		// profiles.region
		// -------------------------------------------------------------
		// An ISO country code, defaulted from browser locale during
		// onboarding rather than asked as a new question. Ranking uses it
		// to order datasets; an empty value falls back to the default
		// order, so existing profiles need no backfill.
		profiles, err := app.FindCollectionByNameOrId("profiles")
		if err != nil {
			return err
		}
		if profiles.Fields.GetByName("region") == nil {
			profiles.Fields.Add(&core.TextField{Name: "region", Max: 2})
			if err := app.Save(profiles); err != nil {
				return err
			}
		}
		return nil
	}, nil)
}
```

Note `types` is imported only if a field needs `types.Pointer`; drop the import if the compiler says it is unused.

- [ ] **Step 4: Run it to confirm it passes**

Run: `cd backend && go test ./internal/migrations/ -v`
Expected: PASS, all tests including the pre-existing ones.

- [ ] **Step 5: Commit**

```bash
cd backend && gofmt -l internal/migrations && go vet ./internal/migrations/
git add backend/internal/migrations/food_ref.go backend/internal/migrations/food_ref_test.go
git commit -m "feat: add food_ref, food_cache and food_query_cache collections"
```

---

### Task 2: Move existing Open Food Facts rows into `food_cache`

**Files:**
- Create: `backend/internal/migrations/off_to_cache.go`
- Create: `backend/internal/migrations/off_to_cache_test.go`

**Interfaces:**
- Consumes: `food_cache` from Task 1.
- Produces: nothing other tasks call. It must run *after* Task 1's migration and before the app serves traffic.

**Why this is its own task:** getting it wrong orphans real diary history. `diary_entries.food` is a relation to `foods`; those rows carry macro snapshots so a dropped relation loses provenance but not the user's numbers. The migration copies rather than moves for exactly that reason.

- [ ] **Step 1: Write the failing test**

```go
// Existing installs have ownerless foods rows with source='off' that
// diary_entries reference. Those rows must appear in food_cache so the
// new cache layer sees them, and must NOT be deleted, because deleting
// them would break every diary_entries.food relation pointing at them.
func TestOFFRowsCopiedToCacheAndLeftInPlace(t *testing.T) {
	app := testApp(t)

	foods, err := app.FindCollectionByNameOrId("foods")
	if err != nil {
		t.Fatal(err)
	}
	rec := core.NewRecord(foods)
	rec.Set("name", "Test Bar")
	rec.Set("brand", "Testco")
	rec.Set("source", "off")
	rec.Set("source_id", "0123456789012")
	rec.Set("barcode", "0123456789012")
	rec.Set("kcal_per_100g", 400.0)
	rec.Set("protein_per_100g", 8.0)
	rec.Set("carbs_per_100g", 60.0)
	rec.Set("fat_per_100g", 14.0)
	if err := app.Save(rec); err != nil {
		t.Fatal(err)
	}

	if err := copyOFFFoodsToCache(app); err != nil {
		t.Fatalf("copyOFFFoodsToCache: %v", err)
	}

	cached, err := app.FindFirstRecordByFilter("food_cache",
		"provider = 'off' && provider_id = '0123456789012'", nil)
	if err != nil {
		t.Fatalf("row not copied into food_cache: %v", err)
	}
	if cached.GetString("name") != "Test Bar" || cached.GetFloat("kcal_per_100g") != 400 {
		t.Errorf("copied row lost data: %+v", cached)
	}
	if cached.GetString("search_text") == "" {
		t.Error("search_text empty; a novel query will never match this cached product")
	}

	if _, err := app.FindRecordById("foods", rec.Id); err != nil {
		t.Errorf("original foods row was removed, orphaning diary_entries.food relations: %v", err)
	}
}

// Re-running must not duplicate, because migrations re-run on a fresh
// database built from an existing one.
func TestOFFCopyIsIdempotent(t *testing.T) {
	app := testApp(t)
	seedOFFFood(t, app, "0123456789012", "Test Bar")

	for i := 0; i < 2; i++ {
		if err := copyOFFFoodsToCache(app); err != nil {
			t.Fatal(err)
		}
	}
	rows, err := app.FindRecordsByFilter("food_cache", "provider = 'off'", "", 0, 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Errorf("got %d cache rows after two runs, want 1", len(rows))
	}
}
```

Write `seedOFFFood(t, app, barcode, name)` as a helper in the same file, containing the record-creation block from the first test.

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd backend && go test ./internal/migrations/ -run OFF -v`
Expected: FAIL, `undefined: copyOFFFoodsToCache`.

- [ ] **Step 3: Implement it**

`backend/internal/migrations/off_to_cache.go`:

```go
// Data migration: existing Open Food Facts rows live in `foods` with
// source='off'. The cache layer reads food_cache, so those rows are
// copied across.
//
// Copied, not moved. diary_entries.food is a relation into `foods`, and
// deleting a row would break every entry that references it. Entries
// carry their own macro snapshots so the user's numbers survive either
// way, but the link to what they logged does not, and that link is worth
// more than the duplicated row.
package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"

	"github.com/boanntech/saolrian/backend/internal/foodsearch"
)

func init() {
	m.Register(func(app core.App) error {
		return copyOFFFoodsToCache(app)
	}, nil)
}

func copyOFFFoodsToCache(app core.App) error {
	cache, err := app.FindCollectionByNameOrId("food_cache")
	if err != nil {
		return err
	}
	rows, err := app.FindRecordsByFilter("foods", "source = 'off'", "", 0, 0, nil)
	if err != nil {
		return err
	}
	for _, r := range rows {
		id := r.GetString("source_id")
		if id == "" {
			continue // nothing to key on; leave it where it is
		}
		// The unique (provider, provider_id) index makes this idempotent,
		// but checking first keeps the log quiet on re-runs.
		if _, err := app.FindFirstRecordByFilter("food_cache",
			"provider = 'off' && provider_id = {:id}", map[string]any{"id": id}); err == nil {
			continue
		}
		out := core.NewRecord(cache)
		out.Set("provider", "off")
		out.Set("provider_id", id)
		out.Set("barcode", r.GetString("barcode"))
		out.Set("name", r.GetString("name"))
		out.Set("brand", r.GetString("brand"))
		out.Set("kcal_per_100g", r.GetFloat("kcal_per_100g"))
		out.Set("protein_per_100g", r.GetFloat("protein_per_100g"))
		out.Set("carbs_per_100g", r.GetFloat("carbs_per_100g"))
		out.Set("fat_per_100g", r.GetFloat("fat_per_100g"))
		out.Set("default_serving_g", r.GetFloat("default_serving_g"))
		out.Set("search_text", foodsearch.NormalizeText(r.GetString("name")+" "+r.GetString("brand")))
		// These rows predate the cache and have no real fetch time. Their
		// created date is the closest honest answer, and it makes them
		// look stale, which is correct: they should be refreshed on next
		// touch rather than trusted indefinitely.
		out.Set("fetched_at", r.GetDateTime("created"))
		if err := app.Save(out); err != nil {
			return err
		}
	}
	return nil
}
```

This depends on `foodsearch.NormalizeText`, which Task 4 creates. Implement Task 4's `provider.go` first if you are working strictly in order, or write this task's `search_text` line as `strings.ToLower(...)` and change it in Task 4 — the test only asserts the field is non-empty.

- [ ] **Step 4: Run it to confirm it passes**

Run: `cd backend && go test ./internal/migrations/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/migrations/off_to_cache.go backend/internal/migrations/off_to_cache_test.go
git commit -m "feat: copy existing Open Food Facts rows into food_cache"
```

---

### Task 3: Embed the pack and seed `food_ref`

**Files:**
- Create: `backend/internal/foodpack/embed.go`
- Create: `backend/internal/foodpack/embed_test.go`
- Create: `backend/internal/migrations/food_seed.go`
- Create: `backend/internal/migrations/food_seed_test.go`
- Modify: `backend/.gitignore` or repo `.gitignore` — the pack binary IS committed; make sure no rule excludes it

**Interfaces:**
- Consumes: `format.Read` and `format.Pack` (`internal/foodpack/format/pack.go:84`), `food.Keys`, `food.Decode`.
- Produces: `foodpack.Load() (format.Pack, error)`; `food_ref` rows keyed on `pack_version`.

**On the embed:** Plan 2 measured the pack at **1.8 MB**, well under the design's 3–5 MB estimate, so the binary grows by under 2 MB rather than the ~5 MB the spec's "accepted trade-off" budgeted for. The README's "~15 MB" line does not need revisiting.

- [ ] **Step 1: Build and commit the pack**

```bash
cd backend
go run ./cmd/foodpack fetch --work ./work
go run ./cmd/foodpack build --work ./work --version 2026.09 --out ./internal/foodpack/pack.bin.zst
go run ./cmd/foodpack verify --pack ./internal/foodpack/pack.bin.zst
git add -f internal/foodpack/pack.bin.zst
```

`backend/work/` is gitignored; `internal/foodpack/pack.bin.zst` must not be. Confirm with `git check-ignore -v backend/internal/foodpack/pack.bin.zst` printing nothing.

Expected from `verify`: `2026.09: 21833 foods from 6 sources, all checks passed`.

- [ ] **Step 2: Write the failing embed test**

`backend/internal/foodpack/embed_test.go`:

```go
package foodpack

import "testing"

// The embedded pack is the product. If the binary ships without it, or
// with one built against a different nutrient vocabulary, every generic
// food silently disappears from search -- so this is a build-time gate,
// not a runtime nicety.
func TestEmbeddedPackLoads(t *testing.T) {
	p, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(p.Foods) < 20000 {
		t.Errorf("embedded pack has %d foods, expected ~21.8k; is pack.bin.zst stale?", len(p.Foods))
	}
	if p.Version == "" {
		t.Error("pack has no version; the seed migration keys idempotency on it")
	}
	if len(p.Sources) != 6 {
		t.Errorf("pack carries %d sources, want 6", len(p.Sources))
	}
}
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `cd backend && go test ./internal/foodpack/ -run EmbeddedPack -v`
Expected: FAIL, `undefined: Load`.

- [ ] **Step 4: Implement the embed**

`backend/internal/foodpack/embed.go`:

```go
// Package foodpack embeds the built reference pack into the server
// binary.
//
// This is the whole point of the ingest pipeline: a self-hoster gets
// ~21.8k generic foods with no API key, no rate limit and no network.
// The pack is 1.8 MB compressed, so the cost to the binary is small
// enough that lazy loading would be more complexity than it saves.
package foodpack

import (
	"bytes"
	_ "embed"

	"github.com/boanntech/saolrian/backend/internal/foodpack/format"
)

//go:embed pack.bin.zst
var packBytes []byte

// Load decodes the embedded pack. format.Read rejects a pack built
// against a different nutrient vocabulary with ErrVocabularyMismatch,
// which is what catches a stale pack.bin.zst after the canonical key list
// changes.
func Load() (format.Pack, error) {
	return format.Read(bytes.NewReader(packBytes))
}
```

- [ ] **Step 5: Run it to confirm it passes**

Run: `cd backend && go test ./internal/foodpack/ -v`
Expected: PASS.

- [ ] **Step 6: Write the failing seed test**

`backend/internal/migrations/food_seed_test.go`. Seed from a small hand-built pack rather than the real 21.8k one so the test stays fast:

```go
func testPack(version string) format.Pack {
	return format.Pack{
		Version:      version,
		NutrientKeys: food.Keys(),
		Sources: []format.SourceInfo{{
			Source: "cofid", Region: "uk", Licence: "ogl-uk",
			URL: "https://example.test/cofid", Rows: 1,
		}},
		Foods: []format.RefFood{{
			Source: "cofid", SourceID: "14-318", Region: "uk", Licence: "ogl-uk",
			Name: "Bananas, flesh only", SearchText: "bananas flesh only",
			Nutrients: food.Encode(food.Profile{
				"energy_kcal": 81, "protein": 1.2, "carbohydrate": 20.3, "fat": 0.1, "iron": 0.3,
			}),
			Portions:        []format.Portion{{Label: "1 medium", Grams: 118}},
			DefaultServingG: 118,
		}},
	}
}

func TestSeedInsertsRows(t *testing.T) {
	app := testApp(t)
	if err := seedFoodRef(app, testPack("v1")); err != nil {
		t.Fatal(err)
	}
	r, err := app.FindFirstRecordByFilter("food_ref",
		"source = 'cofid' && source_id = '14-318'", nil)
	if err != nil {
		t.Fatalf("row not seeded: %v", err)
	}
	if r.GetFloat("kcal_per_100g") != 81 {
		t.Errorf("kcal_per_100g = %v, want 81 (denormalized for list rendering)", r.GetFloat("kcal_per_100g"))
	}
	if r.GetString("pack_version") != "v1" {
		t.Errorf("pack_version = %q, want v1", r.GetString("pack_version"))
	}
}

// Absent is not zero: a nutrient the source never measured must be
// missing from the JSON, not present as 0. This is the single most
// important property of the whole data layer, and the seed is where a
// positional array with NaN sentinels becomes a named map.
func TestSeedOmitsAbsentNutrients(t *testing.T) {
	app := testApp(t)
	if err := seedFoodRef(app, testPack("v1")); err != nil {
		t.Fatal(err)
	}
	r, _ := app.FindFirstRecordByFilter("food_ref", "source_id = '14-318'", nil)
	var got map[string]float64
	if err := json.Unmarshal([]byte(r.GetString("nutrients")), &got); err != nil {
		t.Fatal(err)
	}
	if v, ok := got["iron"]; !ok || v != 0.3 {
		t.Errorf("iron = %v, present=%v; want 0.3", v, ok)
	}
	if _, ok := got["selenium"]; ok {
		t.Error("selenium is present in the JSON; the pack never measured it, and storing it as 0 would read as 'contains none'")
	}
}

// Restarts must be cheap. Re-seeding the same version does nothing.
func TestSeedIsIdempotentForSameVersion(t *testing.T) {
	app := testApp(t)
	for i := 0; i < 2; i++ {
		if err := seedFoodRef(app, testPack("v1")); err != nil {
			t.Fatal(err)
		}
	}
	rows, _ := app.FindRecordsByFilter("food_ref", "", "", 0, 0, nil)
	if len(rows) != 1 {
		t.Errorf("got %d rows after seeding v1 twice, want 1", len(rows))
	}
}

// A new pack version replaces the old rows rather than accumulating
// alongside them, or a user would see both editions of every food.
func TestSeedReplacesOnNewVersion(t *testing.T) {
	app := testApp(t)
	if err := seedFoodRef(app, testPack("v1")); err != nil {
		t.Fatal(err)
	}
	if err := seedFoodRef(app, testPack("v2")); err != nil {
		t.Fatal(err)
	}
	rows, _ := app.FindRecordsByFilter("food_ref", "", "", 0, 0, nil)
	if len(rows) != 1 {
		t.Fatalf("got %d rows after upgrading v1 -> v2, want 1", len(rows))
	}
	if rows[0].GetString("pack_version") != "v2" {
		t.Errorf("pack_version = %q, want v2", rows[0].GetString("pack_version"))
	}
}
```

- [ ] **Step 7: Run it to confirm it fails**

Run: `cd backend && go test ./internal/migrations/ -run Seed -v`
Expected: FAIL, `undefined: seedFoodRef`.

- [ ] **Step 8: Implement the seed**

`backend/internal/migrations/food_seed.go`:

```go
// Seeds food_ref from the embedded pack.
//
// Idempotency is keyed on pack_version, so a restart costs one query and
// an upgrade replaces the previous edition wholesale rather than merging
// into it. Merging would leave rows from a dataset a later pack dropped,
// with nothing to notice them.
package migrations

import (
	"encoding/json"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"

	"github.com/boanntech/saolrian/backend/internal/food"
	"github.com/boanntech/saolrian/backend/internal/foodpack"
	"github.com/boanntech/saolrian/backend/internal/foodpack/format"
)

func init() {
	m.Register(func(app core.App) error {
		p, err := foodpack.Load()
		if err != nil {
			return err
		}
		return seedFoodRef(app, p)
	}, nil)
}

func seedFoodRef(app core.App, p format.Pack) error {
	col, err := app.FindCollectionByNameOrId("food_ref")
	if err != nil {
		return err
	}

	// Already at this version: nothing to do.
	if existing, err := app.FindFirstRecordByFilter("food_ref",
		"pack_version = {:v}", map[string]any{"v": p.Version}); err == nil && existing != nil {
		return nil
	}

	// A different version is present: clear it before inserting, so the
	// two editions never coexist.
	if err := app.DB().NewQuery("DELETE FROM food_ref").Execute().Error(); err != nil {
		return err
	}

	return app.RunInTransaction(func(txApp core.App) error {
		for _, f := range p.Foods {
			prof := food.Decode(f.Nutrients)

			// Decode returns only the keys the source actually measured,
			// so marshalling it directly is what keeps absent absent.
			nutrients, err := json.Marshal(prof)
			if err != nil {
				return err
			}
			portions, err := json.Marshal(f.Portions)
			if err != nil {
				return err
			}

			r := core.NewRecord(col)
			r.Set("name", f.Name)
			r.Set("name_locale", f.NameLocale)
			r.Set("source", f.Source)
			r.Set("source_id", f.SourceID)
			r.Set("region", f.Region)
			r.Set("licence", f.Licence)
			r.Set("kcal_per_100g", prof["energy_kcal"])
			r.Set("protein_per_100g", prof["protein"])
			r.Set("carbs_per_100g", prof["carbohydrate"])
			r.Set("fat_per_100g", prof["fat"])
			r.Set("nutrients", string(nutrients))
			r.Set("portions", string(portions))
			r.Set("default_serving_g", f.DefaultServingG)
			r.Set("search_text", f.SearchText)
			r.Set("pack_version", p.Version)
			if err := txApp.Save(r); err != nil {
				return err
			}
		}
		return nil
	})
}
```

One transaction for ~21.8k inserts is what keeps first boot to a few seconds rather than a few minutes. If it proves too large for SQLite's memory on a small host, batch it in chunks of 2,000 — but measure before changing it.

- [ ] **Step 9: Run it to confirm it passes**

Run: `cd backend && go test ./internal/migrations/ -v`
Expected: PASS.

- [ ] **Step 10: Confirm the real seed on a real database**

```bash
cd backend && rm -rf /tmp/pbtest && go run . serve --dir /tmp/pbtest --http 127.0.0.1:8099 &
sleep 25 && curl -s 'http://127.0.0.1:8099/api/health' && kill %1
```

Then check the row count:

```bash
sqlite3 /tmp/pbtest/data.db "select count(*), pack_version from food_ref group by pack_version;"
```

Expected: `21833|2026.09`. Time the first boot and record it in the commit message — the spec promises "a few seconds".

- [ ] **Step 11: Commit**

```bash
cd backend && gofmt -l internal/foodpack internal/migrations && go vet ./...
git add backend/internal/foodpack/embed.go backend/internal/foodpack/embed_test.go \
        backend/internal/foodpack/pack.bin.zst \
        backend/internal/migrations/food_seed.go backend/internal/migrations/food_seed_test.go
git commit -m "feat: embed the food pack and seed food_ref"
```

---

### Task 4: The provider contract, `userProvider` and `packProvider`

**Files:**
- Create: `backend/internal/foodsearch/provider.go`
- Create: `backend/internal/foodsearch/provider_test.go`
- Create: `backend/internal/foodsearch/region.go`
- Create: `backend/internal/foodsearch/region_test.go`
- Create: `backend/internal/foodsearch/user.go`
- Create: `backend/internal/foodsearch/pack.go`
- Create: `backend/internal/foodsearch/local_test.go`

**Interfaces:**
- Consumes: collections from Task 1, `food_ref` rows from Task 3.
- Produces, and every later task depends on these exact names:

```go
type Portion struct {
	Label string  `json:"label"`
	Grams float64 `json:"grams"`
}

type Query struct {
	Text    string
	Barcode string
	Region  string // ISO-3166 alpha-2, may be empty
	UserID  string // for user-scoped providers; empty means anonymous
	Limit   int
}

type Result struct {
	Ref        string             `json:"ref"`
	Name       string             `json:"name"`
	Brand      string             `json:"brand"`
	Source     string             `json:"source"`
	Region     string             `json:"region"`
	Kcal100    float64            `json:"kcal_per_100g"`
	Protein100 float64            `json:"protein_per_100g"`
	Carbs100   float64            `json:"carbs_per_100g"`
	Fat100     float64            `json:"fat_per_100g"`
	Nutrients  map[string]float64 `json:"nutrients,omitempty"`
	Portions   []Portion          `json:"portions"`
	ServingG   float64            `json:"default_serving_g"`
	HasMicros  bool               `json:"has_micros"`
	Local      bool               `json:"local"`
	Duplicates []string           `json:"duplicates,omitempty"`
	Score      float64            `json:"-"`
}

type Provider interface {
	Name() string
	Search(ctx context.Context, q Query) ([]Result, error)
	Lookup(ctx context.Context, ref string) (*Result, error)
}

func NormalizeText(s string) string
func MakeRef(kind, source, id string) string
func ParseRef(ref string) (kind, source, id string, ok bool)
func NewUserProvider(app core.App) Provider
func NewPackProvider(app core.App) Provider
func DatasetPreference(region string) []string
```

**Ordering note:** Step 9 calls `TextScore`, which Task 5 creates. Do Task 5 first — it is pure, has no dependencies of its own, and is numbered second only because the contract reads better before the ranking detail.

**Package placement:** `internal/foodsearch`, not `internal/food` as the spec says. `internal/food` is the canonical vocabulary and `cmd/foodpack` imports it; putting PocketBase behind that import would drag the whole framework into the ingest binary and break the dependency gate in the whole-plan verification. The spec predates the vocabulary package existing.

- [ ] **Step 1: Write the failing ref and normalization test**

```go
package foodsearch

import "testing"

// Ref is the single opaque identifier the frontend passes back when
// logging, so the aggregator can route a lookup without a type switch.
// Round-tripping matters more than the exact format.
func TestRefRoundTrip(t *testing.T) {
	for _, tc := range []struct{ kind, source, id string }{
		{"pack", "cofid", "14-318"},
		{"cache", "off", "0123456789012"},
		{"food", "", "abc123def456789"},
	} {
		ref := MakeRef(tc.kind, tc.source, tc.id)
		kind, source, id, ok := ParseRef(ref)
		if !ok || kind != tc.kind || source != tc.source || id != tc.id {
			t.Errorf("ParseRef(%q) = %q,%q,%q,%v; want %q,%q,%q,true",
				ref, kind, source, id, ok, tc.kind, tc.source, tc.id)
		}
	}
}

// Source ids contain colons in some datasets, so parsing must not split
// naively on every colon.
func TestParseRefKeepsColonsInID(t *testing.T) {
	ref := MakeRef("pack", "ciqual", "a:b:c")
	_, _, id, ok := ParseRef(ref)
	if !ok || id != "a:b:c" {
		t.Errorf("id = %q, ok = %v; want a:b:c", id, ok)
	}
}

func TestParseRefRejectsGarbage(t *testing.T) {
	for _, bad := range []string{"", "pack", "nonsense:x:y", "pack:"} {
		if _, _, _, ok := ParseRef(bad); ok {
			t.Errorf("ParseRef(%q) accepted a malformed ref", bad)
		}
	}
}

// search_text is matched against a normalized query, so both sides must
// fold accents identically or "creme fraiche" will never find
// "Crème fraîche".
func TestNormalizeText(t *testing.T) {
	for in, want := range map[string]string{
		"Crème fraîche":        "creme fraiche",
		"  Bananas,  RAW  ":    "bananas, raw",
		"Pâté":                 "pate",
	} {
		if got := NormalizeText(in); got != want {
			t.Errorf("NormalizeText(%q) = %q, want %q", in, got, want)
		}
	}
}
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd backend && go test ./internal/foodsearch/ -v`
Expected: FAIL, package does not exist.

- [ ] **Step 3: Implement `provider.go`**

```go
// Package foodsearch is the provider layer: one interface over custom
// foods, the embedded reference pack, and live remote providers, with a
// cache decorator and a concurrent aggregator on top.
//
// It lives outside internal/food deliberately. That package is the
// canonical nutrient vocabulary and cmd/foodpack imports it; anything
// PocketBase-shaped placed there follows into the ingest binary.
package foodsearch

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"unicode"

	"golang.org/x/text/runes"
	"golang.org/x/text/transform"
	"golang.org/x/text/unicode/norm"

	"github.com/pocketbase/pocketbase/core"
)

// ... the types from the Interfaces block above ...

// MakeRef builds the opaque identifier the API hands the frontend.
// Format is kind:source:id, with an empty source for kinds that have
// none. The frontend never parses it.
func MakeRef(kind, source, id string) string {
	return kind + ":" + source + ":" + id
}

// ParseRef splits a ref into its three parts. It splits on the first two
// colons only, because a source id may legitimately contain colons.
func ParseRef(ref string) (kind, source, id string, ok bool) {
	parts := strings.SplitN(ref, ":", 3)
	if len(parts) != 3 || parts[2] == "" {
		return "", "", "", false
	}
	switch parts[0] {
	case "pack", "cache", "food":
	default:
		return "", "", "", false
	}
	return parts[0], parts[1], parts[2], true
}

// NormalizeText lowercases, strips accents and collapses whitespace. The
// query and every stored search_text go through it, so the two sides can
// only match if they are folded the same way -- which is why this is one
// function and not two.
func NormalizeText(s string) string {
	t := transform.Chain(norm.NFD, runes.Remove(runes.In(unicode.Mn)), norm.NFC)
	folded, _, err := transform.String(t, s)
	if err != nil {
		folded = s
	}
	return strings.Join(strings.Fields(strings.ToLower(folded)), " ")
}
```

`golang.org/x/text` is already a direct dependency (`go.mod`), so no new module is needed.

- [ ] **Step 4: Run it to confirm it passes**

Run: `cd backend && go test ./internal/foodsearch/ -v`
Expected: PASS.

- [ ] **Step 5: Write the failing region test**

```go
// Region decides which datasets rank first, not which are available. An
// Irish user still gets USDA rows, just below CoFID ones.
func TestDatasetPreference(t *testing.T) {
	ie := DatasetPreference("IE")
	if len(ie) == 0 || ie[0] != "cofid" {
		t.Errorf("IE prefers %v; want cofid first", ie)
	}
	us := DatasetPreference("US")
	if us[0] != "usda_foundation" {
		t.Errorf("US prefers %v; want usda_foundation first", us)
	}
	// Unknown and empty both fall back rather than returning nothing,
	// because an empty preference would rank every dataset equally and
	// make results look arbitrary.
	for _, r := range []string{"", "ZZ", "xx"} {
		if got := DatasetPreference(r); len(got) != 6 {
			t.Errorf("DatasetPreference(%q) = %v; want the full fallback order", r, got)
		}
	}
}

// Every preference list must name all six sources, or a dataset would be
// unrankable for that region and sort below everything by accident.
func TestEveryPreferenceListIsComplete(t *testing.T) {
	all := map[string]bool{
		"usda_foundation": true, "usda_sr": true, "cnf": true,
		"afcd": true, "ciqual": true, "cofid": true,
	}
	for _, country := range []string{"IE", "GB", "US", "CA", "AU", "FR", "ZZ"} {
		got := DatasetPreference(country)
		if len(got) != len(all) {
			t.Errorf("%s: %d datasets, want %d", country, len(got), len(all))
		}
		for _, s := range got {
			if !all[s] {
				t.Errorf("%s: unknown dataset %q", country, s)
			}
		}
	}
}
```

- [ ] **Step 6: Run it, implement `region.go`, run it again**

```go
// Country to dataset preference. Region orders results; it never filters
// them, so a user always reaches every dataset -- theirs simply sorts
// first. Falling back to the default order for an unknown country is
// deliberate: no preference at all would rank the datasets arbitrarily.
package foodsearch

var defaultDatasetOrder = []string{
	"usda_foundation", "usda_sr", "cofid", "ciqual", "cnf", "afcd",
}

var datasetPreference = map[string][]string{
	"IE": {"cofid", "ciqual", "usda_foundation", "usda_sr", "cnf", "afcd"},
	"GB": {"cofid", "ciqual", "usda_foundation", "usda_sr", "cnf", "afcd"},
	"US": {"usda_foundation", "usda_sr", "cnf", "cofid", "ciqual", "afcd"},
	"CA": {"cnf", "usda_foundation", "usda_sr", "cofid", "ciqual", "afcd"},
	"AU": {"afcd", "usda_foundation", "usda_sr", "cofid", "ciqual", "cnf"},
	"NZ": {"afcd", "usda_foundation", "usda_sr", "cofid", "ciqual", "cnf"},
	"FR": {"ciqual", "cofid", "usda_foundation", "usda_sr", "cnf", "afcd"},
}

// DatasetPreference returns the ordered dataset list for a country code.
func DatasetPreference(region string) []string {
	if p, ok := datasetPreference[strings.ToUpper(strings.TrimSpace(region))]; ok {
		return p
	}
	return defaultDatasetOrder
}
```

Run: `cd backend && go test ./internal/foodsearch/ -run Region -v` → PASS.

- [ ] **Step 7: Write the failing local-provider test**

`local_test.go`. Stand up a PocketBase test app the same way `internal/migrations` does.

```go
// The pack provider is the reason this whole plan exists: 21.8k generic
// foods served from SQLite with no network.
func TestPackProviderSearchesSeededRows(t *testing.T) {
	app := testApp(t)
	seedRef(t, app, "cofid", "14-318", "Bananas, flesh only", "uk", 81)
	seedRef(t, app, "usda_sr", "09040", "Bananas, raw", "us", 89)

	p := NewPackProvider(app)
	got, err := p.Search(context.Background(), Query{Text: "banana", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d results, want 2: %+v", len(got), got)
	}
	for _, r := range got {
		if r.Local != true {
			t.Errorf("%s: pack results are local; nothing was fetched", r.Ref)
		}
		if r.Nutrients != nil {
			t.Errorf("%s: search results must omit the nutrient map to keep list payloads small", r.Ref)
		}
	}
}

// Region orders, it does not filter.
func TestPackProviderRanksRegionPreferredFirst(t *testing.T) {
	app := testApp(t)
	seedRef(t, app, "usda_sr", "09040", "Bananas, raw", "us", 89)
	seedRef(t, app, "cofid", "14-318", "Bananas, raw", "uk", 81)

	p := NewPackProvider(app)
	got, _ := p.Search(context.Background(), Query{Text: "bananas raw", Region: "IE", Limit: 10})
	if len(got) != 2 {
		t.Fatalf("region filtered results out; got %d, want 2", len(got))
	}
	if got[0].Source != "cofid" {
		t.Errorf("first result is %s; an IE user should see cofid first", got[0].Source)
	}
}

// Lookup is the only path that returns the full profile.
func TestPackProviderLookupReturnsNutrients(t *testing.T) {
	app := testApp(t)
	seedRef(t, app, "cofid", "14-318", "Bananas, flesh only", "uk", 81)

	p := NewPackProvider(app)
	r, err := p.Lookup(context.Background(), MakeRef("pack", "cofid", "14-318"))
	if err != nil {
		t.Fatal(err)
	}
	if r.Nutrients["iron"] != 0.3 {
		t.Errorf("iron = %v, want 0.3 from the seeded profile", r.Nutrients["iron"])
	}
	if len(r.Portions) == 0 {
		t.Error("portions empty; '1 medium banana' depends on them")
	}
}

func TestPackProviderLookupUnknownRefIsNotFound(t *testing.T) {
	app := testApp(t)
	p := NewPackProvider(app)
	if _, err := p.Lookup(context.Background(), MakeRef("pack", "cofid", "nope")); err == nil {
		t.Error("expected an error for an unknown ref")
	}
}

// User foods outrank everything; they are what the user typed in
// themselves.
func TestUserProviderReturnsOnlyOwnFoods(t *testing.T) {
	app := testApp(t)
	mine := seedUserFood(t, app, "user-a", "My Protein Shake")
	seedUserFood(t, app, "user-b", "My Protein Shake")

	p := NewUserProvider(app)
	got, err := p.Search(context.Background(), Query{Text: "protein", UserID: "user-a", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d results, want 1; another user's foods must never appear", len(got))
	}
	if got[0].Ref != MakeRef("food", "", mine.Id) {
		t.Errorf("ref = %q, want the caller's own row", got[0].Ref)
	}
}
```

Write `seedRef(t, app, source, sourceID, name, region, kcal)` and `seedUserFood(t, app, userID, name)` as helpers in this file. `seedRef` must write a `nutrients` JSON of `{"energy_kcal":<kcal>,"protein":1.2,"carbohydrate":20.3,"fat":0.1,"iron":0.3}`, a `portions` JSON of `[{"label":"1 medium","grams":118}]`, and `search_text` from `NormalizeText(name)`.

- [ ] **Step 8: Run it to confirm it fails**

Run: `cd backend && go test ./internal/foodsearch/ -run 'PackProvider|UserProvider' -v`
Expected: FAIL, `undefined: NewPackProvider`.

- [ ] **Step 9: Implement `pack.go` and `user.go`**

`pack.go`:

```go
// packProvider serves the embedded reference pack out of food_ref.
//
// Search deliberately does not decode the nutrients JSON: a result list
// of forty foods would otherwise carry sixteen hundred numbers nobody
// looks at. has_micros tells the UI whether a detail fetch is worth it,
// and Lookup is the only path that pays for the decode.
package foodsearch

type packProvider struct{ app core.App }

func NewPackProvider(app core.App) Provider { return &packProvider{app: app} }

func (p *packProvider) Name() string { return "pack" }

func (p *packProvider) Search(ctx context.Context, q Query) ([]Result, error) {
	text := NormalizeText(q.Text)
	if text == "" {
		return nil, nil
	}
	limit := q.Limit
	if limit <= 0 || limit > 100 {
		limit = 40
	}
	// LIKE with a leading wildcard cannot use the search_text index, but
	// a 21.8k-row table scans in well under the local provider's 2 s
	// deadline. Revisit with FTS5 only if measurement says to.
	rows, err := p.app.FindRecordsByFilter("food_ref",
		"search_text ~ {:q}", "", limit*4, 0, map[string]any{"q": text})
	if err != nil {
		return nil, err
	}

	pref := DatasetPreference(q.Region)
	rank := make(map[string]int, len(pref))
	for i, s := range pref {
		rank[s] = i
	}

	out := make([]Result, 0, len(rows))
	for _, r := range rows {
		src := r.GetString("source")
		out = append(out, Result{
			Ref:        MakeRef("pack", src, r.GetString("source_id")),
			Name:       r.GetString("name"),
			Source:     src,
			Region:     r.GetString("region"),
			Kcal100:    r.GetFloat("kcal_per_100g"),
			Protein100: r.GetFloat("protein_per_100g"),
			Carbs100:   r.GetFloat("carbs_per_100g"),
			Fat100:     r.GetFloat("fat_per_100g"),
			Portions:   decodePortions(r.GetString("portions")),
			ServingG:   r.GetFloat("default_serving_g"),
			HasMicros:  len(r.GetString("nutrients")) > 2,
			Local:      true,
			Score:      TextScore(text, NormalizeText(r.GetString("name"))) * datasetWeight(rank[src], len(pref)),
		})
	}
	sortByScore(out)
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (p *packProvider) Lookup(ctx context.Context, ref string) (*Result, error) {
	kind, source, id, ok := ParseRef(ref)
	if !ok || kind != "pack" {
		return nil, errNotFound
	}
	r, err := p.app.FindFirstRecordByFilter("food_ref",
		"source = {:s} && source_id = {:i}", map[string]any{"s": source, "i": id})
	if err != nil {
		return nil, errNotFound
	}
	return &Result{
		Ref:        ref,
		Name:       r.GetString("name"),
		Source:     source,
		Region:     r.GetString("region"),
		Kcal100:    r.GetFloat("kcal_per_100g"),
		Protein100: r.GetFloat("protein_per_100g"),
		Carbs100:   r.GetFloat("carbs_per_100g"),
		Fat100:     r.GetFloat("fat_per_100g"),
		Nutrients:  decodeNutrients(r.GetString("nutrients")),
		Portions:   decodePortions(r.GetString("portions")),
		ServingG:   r.GetFloat("default_serving_g"),
		HasMicros:  len(r.GetString("nutrients")) > 2,
		Local:      true,
	}, nil
}

// decodeNutrients returns nil rather than an empty map on bad JSON, so a
// corrupt row reads as "no micronutrient data" instead of "measured as
// containing none of everything".
func decodeNutrients(raw string) map[string]float64 {
	if raw == "" {
		return nil
	}
	var out map[string]float64
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil
	}
	return out
}

func decodePortions(raw string) []Portion {
	if raw == "" {
		return nil
	}
	var out []Portion
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil
	}
	return out
}

func sortByScore(rs []Result) {
	sort.SliceStable(rs, func(i, j int) bool {
		if rs[i].Score != rs[j].Score {
			return rs[i].Score > rs[j].Score
		}
		return rs[i].Ref < rs[j].Ref // stable between identical requests
	})
}

func datasetWeight(rank, n int) float64 {
	if n == 0 {
		return 1
	}
	return 1.0 - 0.4*float64(rank)/float64(n)
}
```

Those four helpers and `var errNotFound = errors.New("not found")` go in `provider.go`. `datasetWeight` gives the preferred dataset 1.0 and the least-preferred 0.6 — enough to order equal-quality name matches without letting a poor match from a preferred dataset beat an exact match from another.

`user.go` mirrors it over the `foods` collection filtered on `user = {:uid}`, with `Local: true`, `Source: "user"` and `Ref: MakeRef("food", "", r.Id)`. Reuse the existing behaviour in `routes/food.go:103 searchLocalFoods` for the name match so results do not change under users.

- [ ] **Step 10: Run it to confirm it passes**

Run: `cd backend && go test ./internal/foodsearch/ -v`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
cd backend && gofmt -l internal/foodsearch && go vet ./internal/foodsearch/
git add backend/internal/foodsearch/
git commit -m "feat: add the food provider contract with user and pack providers"
```

---

### Task 5: Text scoring

**Files:**
- Create: `backend/internal/foodsearch/score.go`
- Create: `backend/internal/foodsearch/score_test.go`

**Interfaces:**
- Produces: `func TextScore(query, candidate string) float64`, used by Task 4's providers and Task 7's aggregator. Both inputs are already normalized.

Split from Task 4 because ranking quality is the thing a reviewer will want to argue with independently, and it is pure — no database, no context, trivially testable. **It has no dependencies, so do it before Task 4's Step 9, which calls `TextScore`.**

- [ ] **Step 1: Write the failing test**

```go
// The ordering the spec asks for: exact > prefix > token > substring.
// Asserting the order rather than the numbers leaves room to tune the
// weights without rewriting the test.
func TestTextScoreOrdering(t *testing.T) {
	q := "banana"
	exact := TextScore(q, "banana")
	prefix := TextScore(q, "banana bread, homemade")
	token := TextScore(q, "green banana, raw")
	substr := TextScore(q, "bananabread mix")
	none := TextScore(q, "cheddar cheese")

	if !(exact > prefix && prefix > token && token > substr && substr > none) {
		t.Errorf("ordering broken: exact=%v prefix=%v token=%v substr=%v none=%v",
			exact, prefix, token, substr, none)
	}
	if none != 0 {
		t.Errorf("non-match scored %v; it must be 0 so the aggregator can drop it", none)
	}
}

// A multi-word query has to reward matching more of it, or "chicken
// breast" ranks "chicken soup" alongside "chicken breast, raw".
func TestTextScoreRewardsMoreMatchedTokens(t *testing.T) {
	both := TextScore("chicken breast", "chicken breast, raw")
	one := TextScore("chicken breast", "chicken soup, canned")
	if both <= one {
		t.Errorf("matching both tokens scored %v against %v for one", both, one)
	}
}

// Scores multiply by a dataset weight, so the range has to be bounded or
// a long name could outscore the weighting entirely.
func TestTextScoreIsBounded(t *testing.T) {
	for _, c := range []string{"banana", "banana bread", "cheddar", ""} {
		if s := TextScore("banana", c); s < 0 || s > 1 {
			t.Errorf("TextScore(banana, %q) = %v, outside [0,1]", c, s)
		}
	}
}
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd backend && go test ./internal/foodsearch/ -run TextScore -v`
Expected: FAIL, `undefined: TextScore`.

- [ ] **Step 3: Implement `score.go`**

```go
// Text match quality, in [0,1]. The aggregator multiplies this by a
// source weight, so it must stay bounded: an unbounded score would let a
// long name beat the source ordering rather than break ties within it.
package foodsearch

import "strings"

func TextScore(query, candidate string) float64 {
	if query == "" || candidate == "" {
		return 0
	}
	switch {
	case candidate == query:
		return 1.0
	case strings.HasPrefix(candidate, query):
		return 0.9
	}

	qt := strings.Fields(query)
	ct := strings.Fields(strings.ReplaceAll(candidate, ",", " "))
	set := make(map[string]bool, len(ct))
	for _, t := range ct {
		set[t] = true
	}
	matched := 0
	for _, t := range qt {
		if set[t] {
			matched++
		}
	}
	if matched > 0 {
		// 0.5 to 0.8, rising with the share of query tokens matched.
		return 0.5 + 0.3*float64(matched)/float64(len(qt))
	}
	if strings.Contains(candidate, query) {
		return 0.3
	}
	return 0
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `cd backend && go test ./internal/foodsearch/ -run TextScore -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/foodsearch/score.go backend/internal/foodsearch/score_test.go
git commit -m "feat: add bounded text match scoring for food search"
```

---

### Task 6: Lift Open Food Facts into a provider, and the USDA stub

**Files:**
- Create: `backend/internal/foodsearch/off.go`
- Create: `backend/internal/foodsearch/off_test.go`
- Create: `backend/internal/foodsearch/usda.go`

**Interfaces:**
- Produces: `func NewOFFProvider(base string, client *http.Client) Provider`. `base` is injectable purely so `httptest` can stand in; production passes `""` and gets the real host.

**Behaviour must not change.** The mapping in `routes/food.go:235 mapOffProduct` and the URL construction in `offSearch`/`offBarcode` move across as they are. This task is a lift, not a rewrite — anything you improve here, you cannot tell from a test whether you broke.

- [ ] **Step 1: Write the failing test**

```go
func offFake(t *testing.T, status int, body string) *httptest.Server {
	t.Helper()
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(s.Close)
	return s
}

func TestOFFSearchMapsProducts(t *testing.T) {
	s := offFake(t, 200, `{"products":[{"code":"123","product_name":"Test Bar",
	  "brands":"Testco","nutriments":{"energy-kcal_100g":400,"proteins_100g":8,
	  "carbohydrates_100g":60,"fat_100g":14}}]}`)

	p := NewOFFProvider(s.URL, s.Client())
	got, err := p.Search(context.Background(), Query{Text: "bar", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d results, want 1", len(got))
	}
	r := got[0]
	if r.Name != "Test Bar" || r.Brand != "Testco" || r.Kcal100 != 400 {
		t.Errorf("mapping changed: %+v", r)
	}
	if r.Local {
		t.Error("OFF results are not local; the aggregator uses this to order them")
	}
	if r.Ref != MakeRef("cache", "off", "123") {
		t.Errorf("ref = %q; OFF rows are addressed through the cache", r.Ref)
	}
}

// A remote provider that returns nonsense must not take the request with
// it -- the aggregator degrades to local results and a warning.
func TestOFFSearchErrorsOnMalformedJSON(t *testing.T) {
	s := offFake(t, 200, `{"products": [[[`)
	p := NewOFFProvider(s.URL, s.Client())
	if _, err := p.Search(context.Background(), Query{Text: "bar"}); err == nil {
		t.Error("expected an error on malformed JSON")
	}
}

func TestOFFSearchErrorsOnHTTPFailure(t *testing.T) {
	s := offFake(t, 503, "upstream is having a day")
	p := NewOFFProvider(s.URL, s.Client())
	if _, err := p.Search(context.Background(), Query{Text: "bar"}); err == nil {
		t.Error("expected an error on a 503")
	}
}

func TestOFFLookupByBarcode(t *testing.T) {
	s := offFake(t, 200, `{"status":1,"product":{"code":"123","product_name":"Test Bar",
	  "brands":"Testco","nutriments":{"energy-kcal_100g":400}}}`)
	p := NewOFFProvider(s.URL, s.Client())
	r, err := p.Lookup(context.Background(), MakeRef("cache", "off", "123"))
	if err != nil {
		t.Fatal(err)
	}
	if r.Name != "Test Bar" {
		t.Errorf("name = %q", r.Name)
	}
}

func TestOFFLookupMissingProduct(t *testing.T) {
	s := offFake(t, 200, `{"status":0}`)
	p := NewOFFProvider(s.URL, s.Client())
	if _, err := p.Lookup(context.Background(), MakeRef("cache", "off", "404")); err == nil {
		t.Error("expected an error when OFF reports status 0")
	}
}

// The per-provider deadline is the aggregator's, but the provider has to
// honour the context or the deadline means nothing.
func TestOFFSearchHonoursContextCancellation(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	t.Cleanup(s.Close)

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	p := NewOFFProvider(s.URL, s.Client())
	if _, err := p.Search(ctx, Query{Text: "bar"}); err == nil {
		t.Error("expected a timeout error")
	}
}
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd backend && go test ./internal/foodsearch/ -run OFF -v`
Expected: FAIL, `undefined: NewOFFProvider`.

- [ ] **Step 3: Implement `off.go` by moving code out of `routes/food.go`**

Move `offNutriments`, `offProduct`, `offSearch`, `offBarcode`, `fetchJSON`, `mapOffProduct` and `toFloat` across unchanged in behaviour. Two changes only, both forced:

1. Requests are built with `http.NewRequestWithContext` so the aggregator's deadline reaches the socket.
2. The host comes from the struct rather than a literal, so `httptest` can stand in.

```go
// offProvider is Open Food Facts, lifted out of routes/food.go without
// behaviour changes. It is a *live* provider: the cache decorator in
// cache.go wraps it rather than caching being built in here, so the same
// wrapper serves the USDA provider when that is switched on.
package foodsearch

const offDefaultBase = "https://world.openfoodfacts.org"

type offProvider struct {
	base   string
	client *http.Client
}

func NewOFFProvider(base string, client *http.Client) Provider {
	if base == "" {
		base = offDefaultBase
	}
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	return &offProvider{base: base, client: client}
}

func (o *offProvider) Name() string { return "off" }
```

`Search` and `Lookup` wrap the moved functions and map `offProduct` into `Result` with `Ref: MakeRef("cache", "off", code)`, `Source: "off"`, `Local: false`, `HasMicros: false` — OFF's `nutriments` carries only the four macros in the subset this app reads, so claiming micros would make the UI offer a detail fetch that returns nothing.

- [ ] **Step 4: Write the USDA stub**

`usda.go`. It exists to prove the seam is real, and it is never registered:

```go
// usdaProvider is a deliberate stub. The design calls for the provider
// layer to be extensible, and an interface with one live implementation
// is an assertion rather than a demonstration -- this is the compile-time
// proof that a second remote provider needs no changes anywhere else.
//
// It is not registered in aggregate.go. Wiring it up means an API key,
// which the self-hosting story is built on not needing.
package foodsearch

type usdaProvider struct{}

func NewUSDAProvider() Provider { return &usdaProvider{} }

func (u *usdaProvider) Name() string { return "usda" }

func (u *usdaProvider) Search(ctx context.Context, q Query) ([]Result, error) {
	return nil, errNotImplemented
}

func (u *usdaProvider) Lookup(ctx context.Context, ref string) (*Result, error) {
	return nil, errNotImplemented
}
```

Add `var errNotImplemented = errors.New("provider not implemented")` to `provider.go`.

- [ ] **Step 5: Run the tests**

Run: `cd backend && go test ./internal/foodsearch/ -v`
Expected: PASS. `routes` will not compile yet; that is Task 9.

- [ ] **Step 6: Commit**

```bash
cd backend && gofmt -l internal/foodsearch
git add backend/internal/foodsearch/off.go backend/internal/foodsearch/off_test.go backend/internal/foodsearch/usda.go
git commit -m "feat: lift Open Food Facts behind the provider interface"
```

---

### Task 7: The cache decorator

**Files:**
- Create: `backend/internal/foodsearch/cache.go`
- Create: `backend/internal/foodsearch/cache_test.go`

**Interfaces:**
- Produces: `func NewCached(app core.App, inner Provider, now func() time.Time) Provider`.

The clock is injected because every meaningful test here is about time. Production passes `time.Now`.

- [ ] **Step 1: Write the failing test**

```go
// A fresh query hit must not touch the network at all. This is the
// difference between a repeated search costing a round trip and costing
// a SQLite read.
func TestCacheSearchHitAvoidsTheNetwork(t *testing.T) {
	app := testApp(t)
	inner := &countingProvider{results: []Result{sampleOFFResult()}}
	clock := &fakeClock{now: time.Date(2026, 9, 8, 12, 0, 0, 0, time.UTC)}

	c := NewCached(app, inner, clock.Now)
	if _, err := c.Search(context.Background(), Query{Text: "test bar"}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Search(context.Background(), Query{Text: "Test  BAR "}); err != nil {
		t.Fatal(err)
	}
	if inner.searches != 1 {
		t.Errorf("inner provider called %d times; the second search differs only by case and spacing and must hit the query cache", inner.searches)
	}
}

func TestCacheSearchRefetchesAfterTTL(t *testing.T) {
	app := testApp(t)
	inner := &countingProvider{results: []Result{sampleOFFResult()}}
	clock := &fakeClock{now: time.Date(2026, 9, 8, 12, 0, 0, 0, time.UTC)}

	c := NewCached(app, inner, clock.Now)
	_, _ = c.Search(context.Background(), Query{Text: "test bar"})
	clock.now = clock.now.Add(31 * 24 * time.Hour)
	_, _ = c.Search(context.Background(), Query{Text: "test bar"})

	if inner.searches != 2 {
		t.Errorf("inner called %d times; a query cached 31 days ago is past the 30-day TTL", inner.searches)
	}
}

// A month-old barcode should not make someone wait on the network for
// macros that have almost certainly not changed.
func TestCacheLookupStaleServesImmediatelyAndRefreshes(t *testing.T) {
	app := testApp(t)
	inner := &countingProvider{lookup: sampleOFFResult()}
	clock := &fakeClock{now: time.Date(2026, 9, 8, 12, 0, 0, 0, time.UTC)}
	c := NewCached(app, inner, clock.Now)

	ref := MakeRef("cache", "off", "123")
	if _, err := c.Lookup(context.Background(), ref); err != nil {
		t.Fatal(err)
	}
	clock.now = clock.now.Add(31 * 24 * time.Hour)

	inner.block = make(chan struct{}) // the refresh will park here
	done := make(chan struct{})
	go func() {
		defer close(done)
		if _, err := c.Lookup(context.Background(), ref); err != nil {
			t.Error(err)
		}
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("stale lookup blocked on the background refresh instead of serving the cached row")
	}
	close(inner.block)
}

// A provider having a bad day must never cost us data we already hold.
func TestCacheKeepsGoodDataWhenProviderErrors(t *testing.T) {
	app := testApp(t)
	inner := &countingProvider{results: []Result{sampleOFFResult()}}
	clock := &fakeClock{now: time.Date(2026, 9, 8, 12, 0, 0, 0, time.UTC)}
	c := NewCached(app, inner, clock.Now)

	_, _ = c.Search(context.Background(), Query{Text: "test bar"})
	inner.err = errors.New("upstream down")
	clock.now = clock.now.Add(31 * 24 * time.Hour)

	got, err := c.Search(context.Background(), Query{Text: "test bar"})
	if err != nil {
		t.Fatalf("a failed refresh must not fail the search: %v", err)
	}
	if len(got) != 1 {
		t.Errorf("got %d results; the cached row must survive a provider error", len(got))
	}
	if _, err := app.FindFirstRecordByFilter("food_cache", "provider_id = '123'", nil); err != nil {
		t.Error("the cached row was evicted by a provider error")
	}
}

func TestCacheMissFetchesSynchronously(t *testing.T) {
	app := testApp(t)
	inner := &countingProvider{lookup: sampleOFFResult()}
	c := NewCached(app, inner, time.Now)
	r, err := c.Lookup(context.Background(), MakeRef("cache", "off", "123"))
	if err != nil {
		t.Fatal(err)
	}
	if r.Name != "Test Bar" || inner.lookups != 1 {
		t.Errorf("a miss must fetch: %+v, lookups=%d", r, inner.lookups)
	}
}
```

Write `countingProvider` (fields: `results []Result`, `lookup Result`, `err error`, `block chan struct{}`, counters `searches`, `lookups`), `fakeClock` and `sampleOFFResult()` in the same file.

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd backend && go test ./internal/foodsearch/ -run Cache -v`
Expected: FAIL, `undefined: NewCached`.

- [ ] **Step 3: Implement `cache.go`**

```go
// A cache decorator over any live provider.
//
// It wraps rather than being built into OFF on purpose: the moment a
// second remote provider exists, caching it must not mean writing this
// twice. The clock is injected because everything interesting here is a
// question about time.
package foodsearch

const (
	// searchTTL is deliberately long. A branded product's macros change
	// when the manufacturer reformulates, which is a matter of years, and
	// the cost of being a month stale is far below the cost of a round
	// trip on every repeated search.
	searchTTL = 30 * 24 * time.Hour
	lookupTTL = 30 * 24 * time.Hour
)

type cached struct {
	app   core.App
	inner Provider
	now   func() time.Time
}

func NewCached(app core.App, inner Provider, now func() time.Time) Provider {
	if now == nil {
		now = time.Now
	}
	return &cached{app: app, inner: inner, now: now}
}

func (c *cached) Name() string { return c.inner.Name() }
```

`Search` in code, because the error path is the part that is easy to get subtly wrong:

```go
func (c *cached) Search(ctx context.Context, q Query) ([]Result, error) {
	qn := NormalizeText(q.Text)
	if qn == "" {
		return nil, nil
	}
	cachedRows, fetchedAt, found := c.readQuery(qn)
	if found && c.now().Sub(fetchedAt) < searchTTL {
		return cachedRows, nil // no network at all
	}

	fresh, err := c.inner.Search(ctx, q)
	if err != nil {
		// A provider having a bad day must not cost us data we already
		// hold, and must not fail a search we can still answer.
		if found {
			return cachedRows, nil
		}
		return nil, err
	}
	c.storeResults(fresh)
	c.storeQuery(qn, fresh)
	return fresh, nil
}
```

The steps `readQuery`, `storeResults` and `storeQuery` implement:
1. `readQuery` loads the `(provider, query_norm)` row and returns the referenced `food_cache` rows **in the stored order** — OFF's ranking is the thing being cached, so re-sorting them would discard it.
2. `storeResults` upserts each `Result` into `food_cache` on the unique `(provider, provider_id)` index, setting `search_text` to `NormalizeText(name + " " + brand)` and `fetched_at` to `c.now()`.
3. `storeQuery` upserts the `(provider, query_norm)` row with the ordered `provider_id` list.

`Lookup`:

```go
func (c *cached) Lookup(ctx context.Context, ref string) (*Result, error) {
	kind, provider, id, ok := ParseRef(ref)
	if !ok || kind != "cache" || provider != c.inner.Name() {
		return nil, errNotFound
	}
	row, fetchedAt, found := c.readRow(provider, id)
	switch {
	case found && c.now().Sub(fetchedAt) < lookupTTL:
		return row, nil
	case found:
		// Stale: serve now, refresh behind. A month-old barcode should
		// not make someone wait on a round trip for macros that have
		// almost certainly not changed.
		//
		// context.Background, not ctx: the request context is cancelled
		// the moment the response is written, which would kill the
		// refresh every single time.
		go func() {
			bg, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			if fresh, err := c.inner.Lookup(bg, ref); err == nil {
				c.storeResults([]Result{*fresh})
			}
		}()
		return row, nil
	}

	fresh, err := c.inner.Lookup(ctx, ref)
	if err != nil {
		return nil, err
	}
	c.storeResults([]Result{*fresh})
	return fresh, nil
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `cd backend && go test ./internal/foodsearch/ -race -v`
Expected: PASS. Run with `-race`: the background refresh is the one place in this plan with real concurrency.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/foodsearch/cache.go backend/internal/foodsearch/cache_test.go
git commit -m "feat: add a cache decorator over live food providers"
```

---

### Task 8: The aggregator

**Files:**
- Create: `backend/internal/foodsearch/aggregate.go`
- Create: `backend/internal/foodsearch/aggregate_test.go`

**Interfaces:**
- Produces:

```go
type Response struct {
	Results     []Result      `json:"results"`
	Warnings    []string      `json:"warnings"`
	Attribution []Attribution `json:"attribution"`
}

type Attribution struct {
	Source  string `json:"source"`
	Licence string `json:"licence"`
	URL     string `json:"url"`
}

type Aggregator struct{ /* unexported */ }

func New(app core.App, providers ...Provider) *Aggregator
func (a *Aggregator) Search(ctx context.Context, q Query) (Response, error)
func (a *Aggregator) Lookup(ctx context.Context, ref string) (*Result, error)
func (a *Aggregator) Attribution() []Attribution
func Default(app core.App) *Aggregator
```

`Default` registers user, pack, and cache-wrapped OFF — in that order — and is what `routes` calls.

- [ ] **Step 1: Write the failing test**

```go
// The promise the whole design makes: OFF being down degrades the
// response, it does not fail it. This is today's behaviour generalized,
// and it is the single most important test in this task.
func TestAggregatorReturnsLocalResultsWhenRemoteFails(t *testing.T) {
	local := &countingProvider{name: "pack", results: []Result{
		{Ref: "pack:cofid:1", Name: "Bananas, flesh only", Source: "cofid", Local: true, Score: 0.9},
	}}
	remote := &countingProvider{name: "off", err: errors.New("timeout")}

	a := New(nil, local, remote)
	resp, err := a.Search(context.Background(), Query{Text: "banana", Limit: 10})
	if err != nil {
		t.Fatalf("a failing remote must not fail the request: %v", err)
	}
	if len(resp.Results) != 1 {
		t.Fatalf("got %d results, want the local one", len(resp.Results))
	}
	if len(resp.Warnings) != 1 || !strings.Contains(resp.Warnings[0], "off") {
		t.Errorf("warnings = %v; the failure must be visible, not silent", resp.Warnings)
	}
}

// A slow provider must not hold the response past its deadline.
func TestAggregatorAppliesPerProviderDeadline(t *testing.T) {
	local := &countingProvider{name: "pack", results: []Result{{Ref: "pack:cofid:1", Name: "Banana", Local: true, Score: 0.9}}}
	slow := &countingProvider{name: "off", delay: 3 * time.Second}

	a := New(nil, local, slow)
	a.remoteTimeout = 100 * time.Millisecond

	start := time.Now()
	resp, err := a.Search(context.Background(), Query{Text: "banana"})
	if err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Errorf("search took %v; the remote deadline is 100ms", elapsed)
	}
	if len(resp.Results) != 1 || len(resp.Warnings) != 1 {
		t.Errorf("expected the local result plus a warning, got %+v", resp)
	}
}

// User foods outrank the pack, which outranks OFF, for the same text
// quality. The user typed theirs in; it is what they meant.
func TestAggregatorRanksUserAbovePackAboveRemote(t *testing.T) {
	user := &countingProvider{name: "user", results: []Result{{Ref: "food::u1", Name: "Banana", Source: "user", Local: true, Score: 1.0}}}
	pack := &countingProvider{name: "pack", results: []Result{{Ref: "pack:cofid:1", Name: "Banana", Source: "cofid", Local: true, Score: 1.0}}}
	off := &countingProvider{name: "off", results: []Result{{Ref: "cache:off:1", Name: "Banana", Source: "off", Score: 1.0}}}

	a := New(nil, user, pack, off)
	resp, _ := a.Search(context.Background(), Query{Text: "banana"})
	if len(resp.Results) != 3 {
		t.Fatalf("got %d results, want 3", len(resp.Results))
	}
	want := []string{"user", "cofid", "off"}
	for i, w := range want {
		if resp.Results[i].Source != w {
			t.Errorf("position %d is %s, want %s (order: %v)", i, resp.Results[i].Source, w, sources(resp.Results))
		}
	}
}

// Clustering is presentation only. It must never merge or average
// values -- a wrong cluster should be a cosmetic problem, not a
// data-correctness one.
func TestAggregatorClustersDuplicatesWithoutMergingValues(t *testing.T) {
	pack := &countingProvider{name: "pack", results: []Result{
		{Ref: "pack:cofid:1", Name: "Bananas, raw", Source: "cofid", Kcal100: 81, Local: true, Score: 0.9},
		{Ref: "pack:usda_sr:2", Name: "Bananas, raw", Source: "usda_sr", Kcal100: 89, Local: true, Score: 0.85},
	}}
	a := New(nil, pack)
	resp, _ := a.Search(context.Background(), Query{Text: "bananas raw", Region: "IE"})

	if len(resp.Results) != 1 {
		t.Fatalf("got %d results; identically named foods cluster into one", len(resp.Results))
	}
	head := resp.Results[0]
	if head.Source != "cofid" {
		t.Errorf("cluster head is %s; the region-preferred member leads", head.Source)
	}
	if head.Kcal100 != 81 {
		t.Errorf("kcal = %v, want 81 -- the head keeps its own value and nothing is averaged", head.Kcal100)
	}
	if len(head.Duplicates) != 1 || head.Duplicates[0] != "pack:usda_sr:2" {
		t.Errorf("duplicates = %v; the other members must stay reachable", head.Duplicates)
	}
}

// A barcode goes straight to Lookup: ranking a single known product is
// meaningless work.
func TestAggregatorBarcodeBypassesRanking(t *testing.T) {
	off := &countingProvider{name: "off", lookup: sampleOFFResult()}
	a := New(nil, off)
	resp, err := a.Search(context.Background(), Query{Barcode: "123"})
	if err != nil {
		t.Fatal(err)
	}
	if off.searches != 0 {
		t.Errorf("Search was called %d times for a barcode query", off.searches)
	}
	if len(resp.Results) != 1 || resp.Results[0].Name != "Test Bar" {
		t.Errorf("barcode lookup returned %+v", resp.Results)
	}
}

func TestAggregatorLookupRoutesByRefKind(t *testing.T) {
	pack := &countingProvider{name: "pack", lookup: Result{Ref: "pack:cofid:1", Name: "Bananas"}}
	off := &countingProvider{name: "off", lookup: sampleOFFResult()}
	a := New(nil, pack, off)

	if _, err := a.Lookup(context.Background(), "pack:cofid:1"); err != nil {
		t.Fatal(err)
	}
	if pack.lookups != 1 || off.lookups != 0 {
		t.Errorf("a pack ref went to the wrong provider: pack=%d off=%d", pack.lookups, off.lookups)
	}
}
```

Extend `countingProvider` from Task 7 with `name string` and `delay time.Duration`. Add a `sources([]Result) []string` helper for readable failures.

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd backend && go test ./internal/foodsearch/ -run Aggregator -v`
Expected: FAIL, `undefined: New`.

- [ ] **Step 3: Implement `aggregate.go`**

```go
// Fans out across registered providers concurrently, then ranks and
// clusters what comes back.
//
// Two deadlines rather than one: a local provider reading SQLite has no
// business taking two seconds, and a remote one routinely takes more than
// that. Collapsing them to a single timeout means either cutting off OFF
// too early or waiting on a hung database far too long.
package foodsearch

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/errgroup"

	"github.com/pocketbase/pocketbase/core"
)

const (
	defaultLocalTimeout  = 2 * time.Second
	defaultRemoteTimeout = 6 * time.Second
)

// sourceWeight orders the kinds of result against each other, before the
// per-dataset preference inside the pack tier. A user's own food always
// wins an equal text match: they typed it in, so it is what they meant.
var sourceWeight = map[string]float64{"user": 1.0, "off": 0.7}

const packSourceWeight = 0.85

type Aggregator struct {
	app           core.App
	providers     []Provider
	localTimeout  time.Duration
	remoteTimeout time.Duration
}

func New(app core.App, providers ...Provider) *Aggregator {
	return &Aggregator{
		app: app, providers: providers,
		localTimeout:  defaultLocalTimeout,
		remoteTimeout: defaultRemoteTimeout,
	}
}

// Default is the production wiring: user foods, the embedded pack, and
// Open Food Facts behind the cache. The USDA provider is deliberately
// absent -- see usda.go.
func Default(app core.App) *Aggregator {
	return New(app,
		NewUserProvider(app),
		NewPackProvider(app),
		NewCached(app, NewOFFProvider("", nil), time.Now),
	)
}
```

`Search`:
1. A non-empty `q.Barcode` short-circuits: `Lookup` on each provider that can answer it, first hit wins, return it as a one-element `Response`.
2. Otherwise run every provider under `errgroup.WithContext`, each with its own `context.WithTimeout` — `localTimeout` for a provider whose results are local, `remoteTimeout` otherwise. Distinguish by provider name (`user`, `pack` are local) rather than by inspecting results, which are not available yet.
3. **Collect errors into `Warnings`; never return them.** `fmt.Sprintf("%s unavailable: %v", p.Name(), err)`. Use a `sync.Mutex` around the shared slices — `errgroup`'s error is not used for control flow here.
4. Multiply each result's `Score` by its source weight, sort descending, break ties on `Ref` so the order is stable between identical requests.
5. Cluster, then truncate to `q.Limit`.

`clusterDuplicates`, which must never touch a value:

```go
// Groups identically named foods from different sources under one head.
//
// Presentation only. The head keeps its own numbers and the others stay
// reachable by ref -- nothing is averaged and nothing is merged, so a
// wrong cluster is a cosmetic problem rather than a data-correctness one.
// Input must already be sorted, so the first member of a group is the
// best-ranked one and therefore the region-preferred one.
func clusterDuplicates(sorted []Result) []Result {
	seen := make(map[string]int, len(sorted)) // normalized name -> index in out
	out := make([]Result, 0, len(sorted))
	for _, r := range sorted {
		key := NormalizeText(r.Name)
		if i, ok := seen[key]; ok {
			out[i].Duplicates = append(out[i].Duplicates, r.Ref)
			continue
		}
		seen[key] = len(out)
		out = append(out, r)
	}
	return out
}
```

`Attribution()` reads the distinct `(source, licence)` pairs from `food_ref` and returns them with each source's URL. When `app` is nil (unit tests), return nil rather than panicking.

- [ ] **Step 4: Run it to confirm it passes**

Run: `cd backend && go test ./internal/foodsearch/ -race -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd backend && gofmt -l internal/foodsearch && go vet ./internal/foodsearch/
git add backend/internal/foodsearch/aggregate.go backend/internal/foodsearch/aggregate_test.go
git commit -m "feat: add the concurrent food search aggregator"
```

---

### Task 9: The API and cache pruning

**Files:**
- Modify: `backend/internal/routes/food.go` (rewrite)
- Modify: `backend/internal/routes/summary.go:17-28` (register two routes)
- Create: `backend/internal/routes/food_test.go`
- Create: `backend/internal/foodsearch/prune.go`
- Create: `backend/internal/foodsearch/prune_test.go`
- Modify: `backend/main.go` (register the cron)

**Interfaces:**
- Consumes: `foodsearch.Default`, `foodsearch.Response`.
- Produces: `GET /api/saolrian/food/search`, `GET /api/saolrian/food/{ref}`, `GET /api/saolrian/food/barcode/{code}`, `GET /api/saolrian/attribution`, and `foodsearch.RegisterCron(app)`.

**Compatibility is load-bearing.** `AddFood.tsx:109` types the response as `{ results?: Food[]; local?: Food[]; remote?: Food[] }`. A cached PWA shell will still be running the old bundle after the server upgrades, so `local` and `remote` stay populated alongside `results` for one release. Removing them is a follow-up, not part of this plan.

- [ ] **Step 1: Write the failing handler test**

```go
// The old shell keeps working for one release. Dropping these before the
// service worker updates would break search for anyone who had not
// reloaded.
func TestSearchResponseKeepsLegacyLocalAndRemoteKeys(t *testing.T) {
	body := searchRequest(t, "banana")
	for _, k := range []string{"results", "local", "remote"} {
		if _, ok := body[k]; !ok {
			t.Errorf("response is missing %q; a cached PWA shell still reads it", k)
		}
	}
}

// Search payloads stay small: forty results carrying forty nutrients
// each is sixteen hundred numbers nobody looks at.
func TestSearchOmitsNutrientMaps(t *testing.T) {
	body := searchRequest(t, "banana")
	results := body["results"].([]any)
	if len(results) == 0 {
		t.Fatal("no results")
	}
	first := results[0].(map[string]any)
	if _, ok := first["nutrients"]; ok {
		t.Error("search results carry a nutrient map; has_micros exists so they need not")
	}
	if _, ok := first["has_micros"]; !ok {
		t.Error("has_micros missing; the UI cannot tell whether a detail fetch is worthwhile")
	}
}

func TestFoodDetailReturnsNutrients(t *testing.T) {
	body := detailRequest(t, "pack:cofid:14-318")
	n, ok := body["nutrients"].(map[string]any)
	if !ok || n["iron"] == nil {
		t.Errorf("detail response has no nutrient map: %+v", body)
	}
}

func TestFoodDetailRejectsMalformedRef(t *testing.T) {
	if status := detailStatus(t, "not-a-ref"); status != 400 {
		t.Errorf("status = %d, want 400", status)
	}
}

// The CC-BY and open-government licences require attribution, and the
// endpoint is what the Plan 4 screen will read.
func TestAttributionListsEverySeededSource(t *testing.T) {
	body := attributionRequest(t)
	list := body["attribution"].([]any)
	if len(list) == 0 {
		t.Fatal("attribution is empty; four of the five licences require it")
	}
	for _, item := range list {
		m := item.(map[string]any)
		for _, k := range []string{"source", "licence", "url"} {
			if m[k] == "" || m[k] == nil {
				t.Errorf("attribution entry missing %q: %+v", k, m)
			}
		}
	}
}

func TestSearchRequiresQuery(t *testing.T) {
	if status := searchStatus(t, ""); status != 400 {
		t.Errorf("status = %d for an empty q, want 400", status)
	}
}
```

Write `searchRequest`, `searchStatus`, `detailRequest`, `detailStatus` and `attributionRequest` helpers that stand up a test app, seed one `food_ref` row, and drive the handler. Follow whatever pattern `trends_test.go` already uses for authenticated requests.

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd backend && go test ./internal/routes/ -run 'Search|FoodDetail|Attribution' -v`
Expected: FAIL.

- [ ] **Step 3: Rewrite `routes/food.go`**

Everything OFF-shaped is gone — it moved in Task 6. What is left is thin:

```go
// Food search, lookup and barcode endpoints.
//
// All three are a thin shell over foodsearch.Aggregator: the ordering,
// caching and degradation rules live there, where they can be tested
// without an HTTP round trip.
package routes

func foodSearchHandler(e *core.RequestEvent) error {
	q := strings.TrimSpace(e.Request.URL.Query().Get("q"))
	if q == "" {
		return e.BadRequestError("missing q parameter", nil)
	}
	limit, _ := strconv.Atoi(e.Request.URL.Query().Get("limit"))

	resp, err := foodsearch.Default(e.App).Search(e.Request.Context(), foodsearch.Query{
		Text:   q,
		Region: profileRegion(e),
		UserID: e.Auth.Id,
		Limit:  limit,
	})
	if err != nil {
		return e.InternalServerError("search failed", err)
	}

	// `local` and `remote` are the pre-aggregator response shape. A PWA
	// shell cached before this deploy still reads them, so they stay for
	// one release. See AddFood.tsx:109.
	local, remote := splitLegacy(resp.Results)
	return e.JSON(http.StatusOK, map[string]any{
		"results":     resp.Results,
		"local":       local,
		"remote":      remote,
		"warnings":    resp.Warnings,
		"attribution": resp.Attribution,
		"error":       "",
	})
}
```

`profileRegion(e)` reads the caller's `profiles.region`, returning `""` when there is no profile or no region — `DatasetPreference` already falls back. `splitLegacy` partitions on `Result.Local`.

`foodDetailHandler` parses the ref, calls `Lookup`, and returns 400 on a malformed ref and 404 on a miss. `foodBarcodeHandler` keeps its existing response shape and gains `nutrients`. `attributionHandler` returns `{"attribution": [...]}`.

- [ ] **Step 4: Register the routes**

In `summary.go:17`:

```go
	g.GET("/food/search", foodSearchHandler)
	g.GET("/food/barcode/{code}", foodBarcodeHandler)
	g.GET("/food/{ref}", foodDetailHandler)
	g.GET("/attribution", attributionHandler)
```

`/food/{ref}` must be registered **after** `/food/search` and `/food/barcode/{code}` so the literal paths win. Add a test that `GET /food/search` still reaches the search handler, because this ordering is exactly the kind of thing that breaks silently.

- [ ] **Step 5: Run it to confirm it passes**

Run: `cd backend && go test ./internal/routes/ -v`
Expected: PASS.

- [ ] **Step 6: Write the failing prune test**

```go
// Without pruning the cache grows without bound: every novel search adds
// rows nothing ever removes.
func TestPruneRemovesOldUnreferencedRows(t *testing.T) {
	app := testApp(t)
	old := seedCacheRow(t, app, "off", "old", time.Now().AddDate(0, 0, -120))
	recent := seedCacheRow(t, app, "off", "recent", time.Now().AddDate(0, 0, -10))

	if err := Prune(app, time.Now); err != nil {
		t.Fatal(err)
	}
	if _, err := app.FindRecordById("food_cache", old.Id); err == nil {
		t.Error("a 120-day-old unreferenced row survived pruning")
	}
	if _, err := app.FindRecordById("food_cache", recent.Id); err != nil {
		t.Error("a 10-day-old row was pruned")
	}
}

// A row a diary entry points at is history, not cache. Pruning it would
// break the link between an entry and what was logged.
func TestPruneKeepsRowsReferencedByDiaryEntries(t *testing.T) {
	app := testApp(t)
	row := seedCacheRow(t, app, "off", "referenced", time.Now().AddDate(0, 0, -120))
	seedDiaryEntryReferencing(t, app, row.Id)

	if err := Prune(app, time.Now); err != nil {
		t.Fatal(err)
	}
	if _, err := app.FindRecordById("food_cache", row.Id); err != nil {
		t.Error("pruned a cache row a diary entry references")
	}
}
```

- [ ] **Step 7: Implement `prune.go` and register the cron**

`prune.go` imports `github.com/pocketbase/dbx` for `dbx.Params`; it is already a direct dependency (`go.mod`), used the same way in `internal/routes/trends.go:280`.

```go
// Prunes both cache collections. Without this they grow without bound:
// every novel query adds rows and nothing removes them.
//
// A row a diary entry references is not cache, it is history, and is
// kept regardless of age.
package foodsearch

const cacheRetention = 90 * 24 * time.Hour

func Prune(app core.App, now func() time.Time) error {
	cutoff := now().Add(-cacheRetention).UTC().Format("2006-01-02 15:04:05Z")

	// NOT EXISTS rather than a join: a diary entry's relation is the
	// difference between a cache row and a record of something a person
	// actually ate, and only one of those is safe to delete.
	if err := app.DB().NewQuery(`
		DELETE FROM food_cache
		WHERE fetched_at < {:cutoff}
		  AND NOT EXISTS (
		    SELECT 1 FROM diary_entries WHERE diary_entries.food = food_cache.id
		  )
	`).Bind(dbx.Params{"cutoff": cutoff}).Execute().Error(); err != nil {
		return err
	}

	// Query rows reference nothing and are pure cache.
	return app.DB().NewQuery(`
		DELETE FROM food_query_cache WHERE fetched_at < {:cutoff}
	`).Bind(dbx.Params{"cutoff": cutoff}).Execute().Error()
}

// RegisterCron schedules the prune. 03:30 daily: unattended, and far from
// the daily-summary work.
func RegisterCron(app core.App) {
	app.Cron().MustAdd("food_cache_prune", "30 3 * * *", func() {
		if err := Prune(app, time.Now); err != nil {
			app.Logger().Error("food cache prune failed", "error", err)
		}
	})
}
```

In `main.go`, beside `bootstrap.Register(app)`:

```go
	foodsearch.RegisterCron(app)
```

- [ ] **Step 8: Run everything**

Run: `cd backend && go test ./... -race`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
cd backend && gofmt -l . | grep -v -E 'bootstrap|routes/summary|tdee'
git add backend/internal/routes/ backend/internal/foodsearch/prune.go \
        backend/internal/foodsearch/prune_test.go backend/main.go
git commit -m "feat: serve food search from the aggregator and prune the cache"
```

`gofmt -l` must now print at most `internal/bootstrap/bootstrap.go`, `internal/routes/summary.go` and `internal/tdee/tdee.go` — `routes/food.go` was rewritten here and must come out clean.

---

### Task 10: Search results UI

**Files:**
- Modify: `frontend/src/lib/types.ts:36-46`
- Create: `frontend/src/lib/foodSearch.ts`
- Create: `frontend/src/lib/__tests__/foodSearch.test.ts`
- Modify: `frontend/src/screens/AddFood.tsx`
- Modify: `frontend/src/screens/__tests__/AddFood.test.tsx`

**Interfaces:**
- Consumes: the search response from Task 9.
- Produces: `sourceLabel(source: string): string`, `portionOptions(food: Food): PortionOption[]`.

Scope here is **search results only**. The nutrient panel, the daily view and the attribution screen are Plan 4.

- [ ] **Step 1: Extend the `Food` type**

`frontend/src/lib/types.ts`:

```ts
export interface Portion {
  label: string;
  grams: number;
}

export interface Food {
  ref?: string;
  barcode: string | null;
  name: string;
  brand: string | null;
  source?: string;
  region?: string;
  kcal_per_100g: number;
  protein_per_100g: number;
  carbs_per_100g: number;
  fat_per_100g: number;
  default_serving_g?: number | null;
  portions?: Portion[];
  has_micros?: boolean;
  duplicates?: string[];
  local: boolean;
}
```

Every new field is optional so a response from an older server still type-checks — the mirror of the backend keeping `local` and `remote`.

- [ ] **Step 2: Write the failing helper test**

`frontend/src/lib/__tests__/foodSearch.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { portionOptions, sourceLabel } from '../foodSearch';

describe('sourceLabel', () => {
  it('names each dataset the way its publisher does', () => {
    expect(sourceLabel('cofid')).toBe('CoFID');
    expect(sourceLabel('usda_sr')).toBe('USDA');
    expect(sourceLabel('usda_foundation')).toBe('USDA');
    expect(sourceLabel('ciqual')).toBe('CIQUAL');
    expect(sourceLabel('cnf')).toBe('CNF');
    expect(sourceLabel('afcd')).toBe('AFCD');
    expect(sourceLabel('off')).toBe('Open Food Facts');
    expect(sourceLabel('user')).toBe('My foods');
  });

  it('falls back to the raw value rather than rendering nothing', () => {
    expect(sourceLabel('something_new')).toBe('something_new');
  });
});

describe('portionOptions', () => {
  it('offers household measures ahead of grams', () => {
    const opts = portionOptions({
      name: 'Bananas', portions: [{ label: '1 medium', grams: 118 }],
    } as never);
    expect(opts[0]).toEqual({ label: '1 medium, 118 g', grams: 118 });
    expect(opts.at(-1)?.grams).toBe(100);
  });

  it('offers grams alone when the source publishes no portions', () => {
    // CoFID and CIQUAL largely publish none, so this is the common case,
    // not the edge case.
    const opts = portionOptions({ name: 'Cheddar', portions: [] } as never);
    expect(opts).toHaveLength(1);
    expect(opts[0].grams).toBe(100);
  });

  it('tolerates portions being absent entirely', () => {
    expect(portionOptions({ name: 'Cheddar' } as never)).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `cd frontend && npx vitest run src/lib/__tests__/foodSearch.test.ts`
Expected: FAIL, cannot resolve `../foodSearch`.

- [ ] **Step 4: Implement `foodSearch.ts`**

```ts
import type { Food, Portion } from './types';

export interface PortionOption {
  label: string;
  grams: number;
}

// Publishers' own names, not our slugs: a chip reading "usda_sr" tells a
// user nothing, and the licences expect the datasets to be named.
const SOURCE_LABELS: Record<string, string> = {
  usda_foundation: 'USDA',
  usda_sr: 'USDA',
  cnf: 'CNF',
  ciqual: 'CIQUAL',
  cofid: 'CoFID',
  afcd: 'AFCD',
  off: 'Open Food Facts',
  user: 'My foods',
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

// Household measures first, 100 g always last as the fallback everyone
// understands. CoFID and CIQUAL publish no portions at all, so the
// grams-only case is the common one.
export function portionOptions(food: Food): PortionOption[] {
  const out: PortionOption[] = (food.portions ?? []).map((p: Portion) => ({
    label: `${p.label}, ${Math.round(p.grams)} g`,
    grams: p.grams,
  }));
  out.push({ label: '100 g', grams: 100 });
  return out;
}
```

- [ ] **Step 5: Run it to confirm it passes**

Run: `cd frontend && npx vitest run src/lib/__tests__/foodSearch.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing screen test**

Extend `frontend/src/screens/__tests__/AddFood.test.tsx`, following whatever mocking that file already does for `saolrianSend`:

```ts
it('shows which dataset each result came from', async () => {
  mockSearch({
    results: [
      { ref: 'pack:cofid:14-318', name: 'Bananas, flesh only', source: 'cofid',
        kcal_per_100g: 81, protein_per_100g: 1.2, carbs_per_100g: 20.3,
        fat_per_100g: 0.1, local: true, has_micros: true, barcode: null, brand: null },
    ],
    local: [], remote: [], warnings: [],
  });
  renderAddFood();
  await userEvent.type(screen.getByRole('searchbox'), 'banana');
  expect(await screen.findByText('CoFID')).toBeInTheDocument();
});

it('offers household measures when the source publishes them', async () => {
  mockSearch({
    results: [
      { ref: 'pack:usda_sr:09040', name: 'Bananas, raw', source: 'usda_sr',
        kcal_per_100g: 89, protein_per_100g: 1.1, carbs_per_100g: 22.8,
        fat_per_100g: 0.3, local: true, barcode: null, brand: null,
        portions: [{ label: '1 medium', grams: 118 }] },
    ],
    local: [], remote: [], warnings: [],
  });
  renderAddFood();
  await userEvent.type(screen.getByRole('searchbox'), 'banana');
  await userEvent.click(await screen.findByText('Bananas, raw'));
  expect(await screen.findByText('1 medium, 118 g')).toBeInTheDocument();
});

// A warning must be visible. Silently returning fewer results when OFF is
// down is how a user concludes the app has lost their food.
it('surfaces a provider warning without hiding the local results', async () => {
  mockSearch({
    results: [
      { ref: 'pack:cofid:14-318', name: 'Bananas, flesh only', source: 'cofid',
        kcal_per_100g: 81, protein_per_100g: 1.2, carbs_per_100g: 20.3,
        fat_per_100g: 0.1, local: true, barcode: null, brand: null },
    ],
    local: [], remote: [],
    warnings: ['off unavailable: timeout'],
  });
  renderAddFood();
  await userEvent.type(screen.getByRole('searchbox'), 'banana');
  expect(await screen.findByText('Bananas, flesh only')).toBeInTheDocument();
  expect(screen.getByText(/open food facts/i)).toBeInTheDocument();
});

it('groups duplicates under one heading and expands them', async () => {
  mockSearch({
    results: [
      { ref: 'pack:cofid:14-318', name: 'Bananas, raw', source: 'cofid',
        kcal_per_100g: 81, protein_per_100g: 1.2, carbs_per_100g: 20.3,
        fat_per_100g: 0.1, local: true, barcode: null, brand: null,
        duplicates: ['pack:usda_sr:09040'] },
    ],
    local: [], remote: [], warnings: [],
  });
  renderAddFood();
  await userEvent.type(screen.getByRole('searchbox'), 'banana');
  const toggle = await screen.findByRole('button', { name: /1 other source/i });
  await userEvent.click(toggle);
  expect(await screen.findByText('USDA')).toBeInTheDocument();
});
```

- [ ] **Step 7: Run it to confirm it fails**

Run: `cd frontend && npx vitest run src/screens/__tests__/AddFood.test.tsx`
Expected: FAIL.

- [ ] **Step 8: Update `AddFood.tsx`**

Four changes, no restructuring:

1. Read `results` in preference to `local`/`remote` where line 109 currently merges them. Keep the fallback so an old server still works.
2. Render `sourceLabel(f.source)` as a chip in the result row beside the existing kcal line (around line 573).
3. Where grams are entered for the selected food, render `portionOptions(selected)` as a select that sets grams. Keep the free-text gram input — a portion picker that replaces it would be a regression for anyone weighing food.
4. Render `warnings` above the list, mapping each provider name through `sourceLabel` so the user reads "Open Food Facts unavailable", not "off unavailable". Render `duplicates.length` as an expandable "N other sources" control.

- [ ] **Step 9: Run the frontend suite**

Run: `cd frontend && npx vitest run && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/lib/types.ts frontend/src/lib/foodSearch.ts \
        frontend/src/lib/__tests__/foodSearch.test.ts \
        frontend/src/screens/AddFood.tsx frontend/src/screens/__tests__/AddFood.test.tsx
git commit -m "feat: show dataset chips, portions and duplicate clusters in search"
```

---

## Verification for the whole plan

```bash
cd backend
go test ./... -race
go vet ./...
gofmt -l .                                    # only the 3 pre-existing files
go list -deps ./cmd/foodpack | grep -c pocketbase   # must print 0
go list -deps . | grep -c excelize                  # must print 0

rm -rf /tmp/pbverify
go run . serve --dir /tmp/pbverify --http 127.0.0.1:8099 &
sleep 30
sqlite3 /tmp/pbverify/data.db "select count(*) from food_ref;"   # 21833
curl -s 'http://127.0.0.1:8099/api/health'
kill %1

cd ../frontend && npx vitest run && npx tsc --noEmit && npm run build
```

Done means:

- A logged-in user searching "banana" gets pack results with source chips, ordered by their region, with no network call to Open Food Facts required for any of them.
- Pulling the network cable still returns pack and user results, plus a visible warning naming Open Food Facts.
- `food_ref` holds 21,833 rows at `pack_version = 2026.09`, and a restart re-seeds nothing.
- An existing install's `source='off'` rows appear in `food_cache` with their `foods` rows and `diary_entries.food` relations intact.
- `GET /api/saolrian/food/pack:cofid:14-318` returns a nutrient map with absent nutrients **absent**, not zero.
- `GET /api/saolrian/attribution` lists all six sources with licence and URL.
- The ingest binary still has no PocketBase in its dependency graph, and the server binary still has no excelize.

## Follow-on

**Plan 4** — `nutrients` columns on `diary_entries`, `foods`, `recipes` and `recipe_ingredients`; the DRI/NRV reference tables in `internal/foodsearch/reference.go`; the food-detail nutrient panel; the daily nutrients view with its coverage line; `profiles.nutrient_reference`; and the in-app attribution screen the CC-BY and open-government licences require. Every one of those reads something this plan built.

Two known items this plan does not address, both recorded during Plan 2 and neither blocking:

- `UnmappedCollector` in `internal/foodpack/source/build.go:231` keys on the code string alone, so `--report-unmapped` under-reports a column whose normalised name matches one in an earlier-loading source. Harmless while the four non-USDA tables are exhaustive; unsound for the next source added.
- The `fat_saturated + fat_monounsaturated + fat_polyunsaturated <= fat` gate in `cmd/foodpack/verify.go` is pack-wide, and 42 of its 55 suspects are CNF, whose own rate of 1.116% is 2.2x the ceiling. It passes by dilution. Making it per-source is the honest fix and may fail until someone establishes whether CNF's fatty-acid data is genuinely that noisy.

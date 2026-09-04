# Recipes: create, add foods, log servings to the diary

Date: 2026-09-04
Status: Approved design, pending implementation plan

## Goal

Let a user build a recipe (name + ingredients, each an existing food or a
quick manual macro entry), see its total and per-serving calories/macros,
and log a chosen number of servings to their diary as a single entry —
similar to LoseIt's recipe feature.

## Why now

The app already has the pieces this leans on: `AddFood.tsx`'s food search
and "Quick add" pattern, `diary_entries.source` already includes `'recipe'`
in its enum (unused today), and `foods`/`diary_entries` already snapshot
name/brand/macros at add-time rather than joining live. Recipes reuse all
of this rather than inventing a new pattern.

## Data model

No new Go backend routes. Both new collections are plain PocketBase
collections manipulated directly via the JS SDK from the frontend —
matching how `meal_slots` already works (created/deleted via
`pb.collection('meal_slots')` calls in `AddFood.tsx`, no custom handler).
Ingredient search reuses the existing `/api/saolrian/food/search` and
`/api/saolrian/food/barcode/{code}` endpoints as-is.

New migration file (`backend/internal/migrations/`, alongside
`migrations.go`, e.g. `saolrian_recipes.go`):

### `recipes`

Owner-scoped rules (`user = @request.auth.id`), same as every other
collection.

| Field | Type | Notes |
|---|---|---|
| `user` | relation → users | required |
| `name` | text | required |
| `servings` | number | required, min 1, **whole integer** (how many servings the recipe makes) |
| `total_kcal` | number | denormalized sum of ingredient rows |
| `total_protein` | number | " |
| `total_carbs` | number | " |
| `total_fat` | number | " |
| `created` / `updated` | autodate | |

The `total_*` fields are recomputed and saved by the editor every time
ingredients change, so the recipe list screen can show kcal/serving without
fetching every ingredient row — the same denormalization approach the app
already uses for `name_snapshot`/`brand_snapshot` elsewhere.

### `recipe_ingredients`

Owner-scoped rules, same pattern.

| Field | Type | Notes |
|---|---|---|
| `user` | relation → users | required (direct field, not traversed via `recipe.user`, matching how `diary_entries` always carries its own `user` even though it also relates to `meal_slot`) |
| `recipe` | relation → recipes | required, `CascadeDelete: true` |
| `food` | relation → foods | **nullable** — null for a quick manual entry |
| `name_snapshot` | text | required |
| `brand_snapshot` | text | |
| `grams` | number | |
| `kcal` / `protein` / `carbs` / `fat` | number | snapshotted via `foodMath` at add-time, same as `diary_entries` |
| `sort_order` | number | preserves the order ingredients were added |

Index: `(recipe, sort_order)` for stable ordered fetches.

`diary_entries` needs **no schema change** — it already has `source:
'recipe'` in its select enum and a nullable `food` relation.

## Frontend

### Types & math

- `frontend/src/lib/types.ts`: add `Recipe` (`id`, `name`, `servings`,
  `total_kcal`, `total_protein`, `total_carbs`, `total_fat`) and
  `RecipeIngredient` (`id`, `recipe`, `food`, `name_snapshot`,
  `brand_snapshot`, `grams`, `kcal`, `protein`, `carbs`, `fat`,
  `sort_order`).
- `frontend/src/lib/nutrition.ts`: add `sumIngredients(ingredients)` →
  `{ kcal, protein, carbs, fat }` totals, and `perServing(totals,
  servings)` → each macro divided by `servings`, rounded the same way
  `foodMath` already rounds (kcal to an int, macros to 1 decimal).

### Screens

1. **`frontend/src/screens/Recipes.tsx`** (new, route `/recipes`) — list of
   the signed-in user's recipes: name, kcal/serving (from the cached
   `total_*` fields ÷ `servings`), servings count. "+ New recipe" button →
   `/recipes/new`. Tapping a recipe → `/recipes/:id`.

2. **`frontend/src/screens/RecipeEditor.tsx`** (new, routes `/recipes/new`
   and `/recipes/:id`) —
   - Name field.
   - Servings `Stepper` (`inputMode="numeric"`, step 1, min 1 — whole
     integers only).
   - Ingredient list: each row shows name/brand, grams, computed kcal, and
     a remove button.
   - "+ Add ingredient" opens a `Sheet` with the same search-then-detail
     flow as `AddFood.tsx` (search box over local + Open Food Facts
     results, tap a result → grams `Stepper` → confirm adds the row) **and**
     a "Quick add" option in the same sheet, mirroring `AddFood`'s existing
     Quick add sheet, for a manual kcal/protein/carbs/fat entry with no
     backing `food` record.
   - Live totals card: "Total" and "Per serving" (via `sumIngredients` +
     `perServing`), recalculated on every ingredient change.
   - Save: upserts the `recipes` row (including recomputed `total_*`) and
     diffs `recipe_ingredients` against what was loaded (create new rows,
     update changed ones, delete removed ones).
   - Delete recipe button — no confirmation dialog, matching the existing
     lightweight delete pattern used for meal slots (`removeSlot` in
     `AddFood.tsx` has no confirm either). Cascade-deletes ingredient rows
     via `CascadeDelete`.
   - Save is disabled with zero ingredients (a recipe needs at least one).

3. **`frontend/src/screens/AddFood.tsx`** — add a third top-level option
   next to "Search" and "Quick add": **"From recipe"**. Tapping it shows
   the user's recipes (name + kcal/serving) with a "Manage recipes" link to
   `/recipes`. Tapping a recipe shows:
   - Per-serving macros card (same `NCELL`/`NLABEL` styling as the existing
     detail card).
   - "Servings to log" `Stepper` (`inputMode="decimal"`, step 0.5, min
     0.5, default 1) — decimal, independent of the recipe's own
     whole-number `servings` field, since eating half a portion is normal.
   - The existing meal-slot picker (`slotControls`, reused as-is).
   - "Add to diary" button.

   Submitting computes `perServing(totals, recipe.servings) × servingsToLog`
   and creates **one** `diary_entries` row: `source: 'recipe'`, `food:
   null`, `name_snapshot: recipe.name`, `external_id: recipe.id`, macros =
   the scaled values, `grams: null` (recipes are serving-based, not
   gram-based).

4. **`frontend/src/screens/ProfileGoals.tsx`** — add a "Recipes" link card
   next to the existing "Import / Export" card, pointing to `/recipes`.

5. **`frontend/src/main.tsx`** — add routes `/recipes`, `/recipes/new`,
   `/recipes/:id`.

### Diary integration

- `frontend/src/lib/offline.ts`'s `createDiaryEntry` currently hardcodes
  `source: 'manual'` on every create. Extend its signature to
  `createDiaryEntry(endpoint, userId, payload, source = 'manual')` so
  recipe logging can pass `'recipe'` while keeping the offline-queue
  behaviour (a recipe logged with no connection queues and replays like
  any other entry).
- Editing or deleting a recipe never touches diary entries already logged
  from it — those rows are permanent snapshots, exactly like a `foods` row
  can change without altering past diary entries logged from it.
- `EditEntry.tsx` needs no changes: it has no `source`-specific branching
  today, and a recipe-sourced row has the same `name_snapshot`/macro fields
  as any other row.

## Error handling

- Recipe `servings` must be a whole integer ≥ 1 (min-1 clamp on the
  Stepper; no fractional recipe-serving-count support).
- Save disabled with zero ingredients.
- "Servings to log" stepper clamps to a 0.5 minimum.
- Ingredient search inherits `AddFood`'s existing offline/unreachable error
  handling (same search endpoint, same error messages).

## Testing

- Vitest unit tests for `sumIngredients` / `perServing` in `nutrition.ts`
  (fixed inputs → known totals and per-serving values, including rounding
  behaviour).
- Vitest tests for `RecipeEditor` (add/remove ingredient updates totals;
  save disabled at zero ingredients) and the "From recipe" flow in
  `AddFood.tsx` (logs the correctly-scaled combined entry), following the
  existing pattern in `frontend/src/screens/__tests__/`.
- No new backend Go tests: this feature adds no Go code (migrations only),
  and no Go tests exist today for the other plain-migration collections
  either.

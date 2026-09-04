# LoseIt full import: zip upload, category selection, background job + push

Date: 2026-09-04
Status: Approved design, pending implementation plan

## Goal

Replace the existing single-CSV LoseIt importer with a full import from a
LoseIt "Export Data" zip: the user uploads one `.zip`, the app shows which
supported categories it found, the user picks which to import, and the
import runs as a background job that notifies the user (push + toast) when
it finishes — even if they've closed the app.

## Why now

The current importer (`frontend/src/screens/Import.tsx`,
`frontend/src/lib/loseit.ts`, `backend/internal/routes/import_loseit.go`)
only handles the food-log CSV, requires the user to have manually located
that one file inside their export, and imports are all-or-nothing with no
per-row dedup worth relying on (`external_id` is hardcoded to the literal
string `"loseit"` on every row today, so it doesn't uniquely identify a
row). A LoseIt export actually contains 24 files covering exercise, weight,
sleep, steps, body fat, custom foods, recipes, and profile/goals, none of
which (other than food logs) can currently be imported at all.

## Source format (reference)

A LoseIt export zip is flat (no top-level folder) and contains one CSV per
category plus two subfolders (`food-photos/`, `progress-photos/`) that hold
only CDN token metadata, no actual image bytes. Observed file list, with
header rows:

```
achievement-actions.csv        Tag,Type,Deleted
achievements.csv               Tag,Level,Earned On,Deleted
active-food-servings.csv       FoodUniqueId,Measure,Quantity,BaseMultiplier,Created,LastUpdated,Deleted
body-fat.csv                   Date,Value,Secondary Value,Last Updated
carbohydrates(g).csv           (per-nutrient daily total; same shape as body-fat.csv)
course-progress.csv            Course Code,Level Code,Subject Code,Lesson Code,Start Date,Finish Date
custom-exercises.csv           Exercise,Image,Mets
custom-foods.csv               Name,UniqueId,Brand,Image,Quantity,Measure,Calories,Fat (g),Protein (g),Carbohydrates (g),Saturated Fat (g),Sugars (g),Fiber (g),Cholesterol (mg),Sodium (mg)
daily-calorie-summary.csv      Date,Food cals,Exercise cals,Budget cals,EER
daily-values.csv               Date,Name,Value
exercise-logs.csv              Date,Name,Icon,Type,Quantity,Units,Calories,Deleted   (Units observed: "minutes" only)
fasting-logs.csv               Scheduled start,Scheduled duration,Actual start,Actual end,Deleted
fasting-schedules.csv          Day,Scheduled start,Duration,Deleted
fats(g).csv                    (per-nutrient daily total)
fiber.csv                      (per-nutrient daily total)
food-logs.csv                  Date,Name,Icon,Meal,Quantity,Units,Calories,Deleted,Fat (g),Protein (g),Carbohydrates (g),Saturated Fat (g),Sugars (g),Fiber (g),Cholesterol (mg),Sodium (mg)
food-photos/food-photos.csv    Date,Meal Type,Visibility,Token,Deleted,Last Updated
garmin-calories.csv            Date,Value,Secondary Value,Last Updated
notes.csv                      Date,Title,Body
profile.csv                    Name,Value   (key/value pairs: Birthday, Gender, Height, Start Weight, Current Weight, Goal Weight, Calorie Adjustment, Current EER, Plan, Activity Level, Start Date)
progress-photos/progress-photos.csv  Date,Goal Tag,Visibility,Token,Deleted,Created,Last Updated
protein(g).csv                 (per-nutrient daily total)
recipes.csv                    Name,UniqueId,Quantity,Measure,Author,Image Name,Calories,Fat (g),Protein (g),Carbohydrates (g),Saturated Fat (g),Sugars (g),Fiber (g),Cholesterol (mg),Sodium (mg)
sleep-hours.csv                Date,Value,Secondary Value,Last Updated
steps.csv                      Date,Value,Secondary Value,Last Updated
water-intake.csv               Date,Value,Secondary Value,Last Updated
weight-loss-medication-logs.csv Medication,Dosage,Dose Unit,Administration Type,Injection Site,Taken At (UTC),Deleted
weights.csv                    Date,Weight,Last Updated,Deleted
```

Dates in per-row files are `MM/DD/YYYY`. `Last Updated`/`Created` timestamps
are ISO 8601. Numeric fields may contain the literal string `n/a`.

## Category scope

Only categories with a genuine home in this app's data model are offered
for import. Everything else is parsed only far enough to be excluded from
the picker (i.e. the zip is still fully read, but unsupported files are
never surfaced as an importable category and never written anywhere).

| Category (picker label) | Source file | Destination | Notes |
|---|---|---|---|
| Food logs | food-logs.csv | `diary_entries` | extends today's importer |
| Custom foods | custom-foods.csv | `foods` (source=`loseit`) | gram-measured → per-100g |
| Recipes | recipes.csv | `foods` (source=`loseit`) | serving-measured → see below |
| Weight | weights.csv | `weights` | |
| Exercise | exercise-logs.csv | new `exercise_entries` | |
| Steps | steps.csv | `daily_metrics.steps` | field exists |
| Water | water-intake.csv | `daily_metrics.water_ml` | field exists |
| Body fat | body-fat.csv | `daily_metrics.body_fat_pct` | **new field** |
| Sleep | sleep-hours.csv | `daily_metrics.sleep_hours` | **new field** |
| Profile & goals | profile.csv | `profiles` (one-time field update, not a log) | user confirms before applying, since it overwrites current goal settings |

**Explicitly out of scope**, with reasons (no code should be written to
parse these beyond recognizing and skipping the filename):

- `daily-calorie-summary.csv` — derived from food+exercise logs; importing it
  raw would duplicate/conflict with data computed from the categories above.
- `garmin-calories.csv` — LoseIt already folds Garmin's calorie adjustment
  into `exercise-logs.csv` as a same-day "Garmin Adjustment" row; importing
  both would double-count.
- `fasting-logs.csv`, `fasting-schedules.csv` — no fasting feature exists.
- `achievements.csv`, `achievement-actions.csv` — no gamification feature.
- `active-food-servings.csv` — LoseIt's own "recently used serving size"
  cache; not portable data.
- `daily-values.csv` — an internal "day marked complete" UI flag, not
  meaningful outside LoseIt.
- `notes.csv` — no notes feature exists.
- `weight-loss-medication-logs.csv` — no medication-tracking feature.
- `course-progress.csv` — LoseIt's educational course feature; N/A.
- `food-photos.csv`, `progress-photos.csv` — contain only LoseIt CDN
  tokens, not image bytes; nothing to import.
- `custom-exercises.csv` — MET-based exercise definitions; `exercise-logs.csv`
  already carries name/minutes/kcal directly per entry, so no lookup table
  is needed for v1.

### Recipes → `foods` normalization

`recipes.csv` gives total macros for the whole recipe plus a `Quantity`
(number of servings) and `Measure` (always `Serving` in the sample data,
never a gram weight). `custom-foods.csv` rows are usually gram-measured
(`Measure` = `Grams`, `Quantity` = grams) and convert straight to
`kcal_per_100g = Calories / Quantity * 100`.

For serving-measured rows (all recipes, and any custom food that isn't
gram-measured): compute `kcal_per_100g = Calories / Quantity` (i.e. kcal per
one serving) and set `default_serving_g = 100`. This reuses the app's
existing "1 serving = 100g" fallback convention (`backend/internal/routes/food.go:283`,
`AddFood.tsx:102`) rather than inventing a new one — when the user later adds
"1 serving" of that food, `grams` resolves to 100 and the macro math produces
exactly the per-serving values from the recipe.

### Profile & goals mapping

`profile.csv` is a snapshot, not a log — applying it means overwriting
current values in `profiles`, once, on explicit user confirmation (a
separate checkbox/step in the picker, not bundled silently with the other
categories):

| profile.csv key | `profiles` field | Conversion |
|---|---|---|
| Birthday | `birth_year` | parse year out of `MM/DD/YYYY` |
| Gender | `sex` | `Male`→`male`, `Female`→`female`, else `other` |
| Height | `height_cm` | direct (LoseIt exports cm) |
| Current EER, Calorie Adjustment | `calorie_target` | `EER + Adjustment`, only if adjustment is non-zero (0 means "use computed TDEE", matching this field's existing semantics) |
| Plan | `goal` | `maintain`/`lose`/`gain` (already matching values) |
| Activity Level | `activity_level` | case-insensitive substring match: contains "sedentary"→`sedentary`, "light"→`light`, "very"→`very`, "extrem"→`extreme`, anything else (including "Somewhat Active", the only value observed in sample data) → `moderate`. The full set of values LoseIt can export isn't known from a single sample, so this is a best-effort fallback rather than an exhaustive mapping — worth widening once more real exports are seen. |

`Start Weight`/`Current Weight`/`Goal Weight` are not applied to `profiles`
(no such fields there); `Current Weight` will already exist in the imported
`weights` log if the Weight category is selected.

## Architecture

### Client-side zip parsing (no server-side upload endpoint)

The app currently has no multipart/file-upload handling anywhere in the
backend, and today's CSV importer already works by parsing entirely
client-side and posting parsed JSON rows. This design keeps that pattern:

- Add **fflate** (MIT-licensed, ~8KB) as a frontend dependency to unzip the
  file client-side into `Record<string, Uint8Array>`.
- `frontend/src/lib/loseitZip.ts` (new): given a `File`, unzip it, decode
  each recognized entry as UTF-8 text, and run a per-category parser
  (extending the existing "detect header row by content, alias column
  names" approach in `loseit.ts`) to produce typed row arrays. Unrecognized
  filenames are ignored. Returns `{ category, rows, count }[]` for whatever
  supported categories were found.
- This avoids building server-side multipart handling, size limits, temp
  storage, and zip-bomb protection — all new surface that a ~1MB personal
  export doesn't justify. If a future need for much larger imports (or
  imports from other sources) arises, server-side handling can be added
  then.

### Background job + push notification (new backend infrastructure)

None of this exists today (no goroutines/queues, no push subscriptions, no
VAPID keys) and is being added specifically because the import must be able
to notify the user after they've closed the app:

**New collections** (`backend/internal/migrations/`, new migration file
alongside the existing `migrations.go`, since PocketBase migrations are
additive/ordered — this is `saolrian_loseit_import.go` or similar):

- `import_jobs`: `user` (relation), `status` (select: `queued`/`running`/
  `done`/`failed`), `categories` (json — which categories were requested),
  `counts` (json — per-category `{imported, skipped}`), `error` (text),
  `created`/`updated` (autodate). Owner-scoped rules like every other
  collection.
- `push_subscriptions`: `user` (relation), `endpoint` (text), `p256dh`
  (text), `auth` (text), `created` (autodate). Unique index on
  `(user, endpoint)` so re-subscribing the same browser doesn't duplicate.
- `exercise_entries`: `user` (relation), `name` (text), `minutes` (number),
  `kcal` (number), `logged_at` (date), `source` (select:
  `manual`/`import`), `external_id` (text). Index on `(user, logged_at)`
  and a partial unique index on `(user, source, external_id)` where
  `external_id != ''` for dedup.
- `daily_metrics` gains two nullable number fields: `sleep_hours`,
  `body_fat_pct`.
- `foods`' existing partial unique index `idx_foods_source_sourceId`
  (currently `source = 'off'` only) needs a matching partial unique index
  for `source = 'loseit'` so custom-food/recipe re-imports can dedup on
  `(source, source_id)` the same way OFF cache entries do.

**Endpoint changes**:

- `POST /api/saolrian/import/loseit` becomes async and multi-category: body
  is `{ categories: { diary?: [...], foods?: [...], recipes?: [...],
  weight?: [...], exercise?: [...], daily_metrics?: [...], profile?: {...}
  } }` (only the keys the user selected are present). Handler creates an
  `import_jobs` row (`status: "queued"`), launches a `go func()` to process
  each provided category sequentially (existing dedup-by-`findOrCreateSlot`
  logic for diary rows, new equivalent per-category dedup checks against
  `external_id`/`source_id` as described above), updating the job's
  `status`/`counts` as it goes, and returns `{ job_id }` immediately (202).
  On completion (success or failure, via `recover()` around the goroutine
  body), sends a Web Push notification to every stored subscription for
  that user summarizing the result (or the failure).
- `POST /api/saolrian/push/subscribe`: stores a `PushSubscription` the
  frontend obtained from `registration.pushManager.subscribe()`.
- `POST /api/saolrian/push/unsubscribe`: removes it.
- VAPID keypair read from env vars (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`)
  at startup. If unset, the subscribe endpoint and push-sending both
  no-op gracefully — self-hosters who don't configure push still get a
  fully working import (live status + toast while the tab is open), just
  no notification after closing the app. The exact Go webpush library to
  use is not pinned in this spec — it should be selected and its
  API verified against its actual docs during implementation rather than
  assumed here.

**Live status while the tab stays open**: the frontend subscribes to the
`import_jobs` record via PocketBase's built-in realtime API
(`pb.collection('import_jobs').subscribe(id, cb)`) — no custom polling
endpoint needed, this is a stock PocketBase feature already available
through the existing SDK wrapper.

**Frontend push wiring**:

- `frontend/src/lib/push.ts` (new): request `Notification` permission,
  fetch the VAPID public key from a new unauthenticated
  `GET /api/saolrian/push/vapid-key` endpoint (simpler than baking it into
  the frontend build, and consistent with reading it from env vars at
  runtime rather than at build time), call
  `registration.pushManager.subscribe()`, POST the result to
  `/api/saolrian/push/subscribe`.
- `vite.config.ts`: switch `VitePWA` from the default `generateSW` strategy
  to `injectManifest`, since a custom `push`/`notificationclick` event
  listener needs to live in the service worker and the auto-generated one
  has no hook for custom code. Add `frontend/src/sw.ts`:
  `precacheAndRoute(self.__WB_MANIFEST)` plus the two listeners (show a
  notification from the push payload; on click, focus/open the app).
- Push permission is requested opportunistically, right before an import
  starts (not on app load) — if denied, the import still runs and still
  reports its result via realtime + toast for as long as the tab is open.

### Dedup / idempotent re-import

Today's diary importer sets `external_id` to the constant string
`"loseit"` on every row, which cannot distinguish rows and is not used for
dedup at all. This is fixed as part of this work: each category derives a
stable per-row `external_id` before insert, and checks for an existing row
with the same `(user, source, external_id)` first, skipping it if found —

- diary rows: hash of `(date, name, meal, quantity, unit, kcal)`
- exercise rows: hash of `(date, name, quantity, kcal)`
- weight rows: the date itself (LoseIt exports at most one weight per day)
- custom foods / recipes: LoseIt's own `UniqueId` column, used directly as
  `foods.source_id`
- daily_metrics (steps/water/body fat/sleep): keyed by `(user, date)`,
  which is already the collection's existing unique index — an import
  updates the existing day's row rather than inserting, so re-import is
  naturally idempotent (last import wins for that field)

This makes re-running the import after a fresh LoseIt export safe: only
genuinely new rows since the last import get inserted.

## Frontend UI flow (`Import.tsx` rework)

1. File input accepts `.zip` instead of `.csv`.
2. On selection, unzip client-side (`loseitZip.ts`), show a checklist of the
   categories actually found, each with its row count, all pre-checked
   except "Profile & goals" (unchecked by default, since it overwrites
   current settings — see above).
3. "Import selected" button: requests push permission/subscribes if not
   already done, POSTs the assembled per-category payload, receives
   `{ job_id }`, subscribes to that job's realtime updates, and shows an
   "Importing…" state.
4. On the job record flipping to `done`/`failed` (via realtime, or via the
   push notification if the tab was closed and is reopened later): show a
   toast with the per-category counts, and update the UI without a reload.
5. The existing "Export diary" card is unchanged.

## Error handling

- Corrupt/non-zip file, or a zip with none of the recognized filenames:
  inline error, no request sent ("No importable Lose It! data found in this
  file.").
- Per-row parse failures: counted as `skipped`, same as today — no
  category-level abort on a single bad row.
- Job-level failure (panic, DB error mid-loop): caught via `recover()`,
  job marked `failed` with an error message, still triggers a push/toast so
  the user isn't left wondering.
- Push subscribe denied, or VAPID unset: import proceeds normally; result
  still delivered via realtime + toast whenever the tab is open.

## Testing

- Frontend: unit tests for the new per-category zip/CSV parsers, using
  small synthetic fixture CSVs committed to the repo (not the user's real
  export, which stays out of the repository).
- Backend: Go tests for per-category dedup (importing the same payload
  twice results in the second run reporting everything as skipped) and for
  the new migrations creating the expected collections/fields/indexes.
- Manual: end-to-end run in dev against a real LoseIt export zip, verifying
  the picker's row counts, realtime status updates, toast on completion,
  and push delivery (noting push requires HTTPS or localhost — won't work
  over plain HTTP in a non-TLS production deployment).

## Security notes for review

- `VAPID_PRIVATE_KEY` is a secret and must only ever live in env vars /
  secret storage, never committed or logged.
- New endpoints accept user-supplied JSON that gets written to the
  database (diary/exercise/food/weight rows) — needs the same input
  validation rigor as the existing importer (reject empty names/dates,
  bound numeric fields) since this is user-uploaded, not trusted, data.
- `push_subscriptions` and `import_jobs` follow the same owner-scoped rule
  pattern (`user = @request.auth.id`) as every other collection — no new
  access pattern introduced.

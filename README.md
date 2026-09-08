# Saolrian

**Your life, tracked.** Calorie and fitness tracking you can actually own — self-hostable with a single binary, or use the hosted tier.

Inspired by the Irish words *saol* (life) and *rian* (track).

![Status](https://img.shields.io/badge/status-early_beta-0f7a5f) ![License](https://img.shields.io/badge/license-MIT-blue) ![Backend](https://img.shields.io/badge/backend-Go%20%2B%20PocketBase-00ADD8) ![Frontend](https://img.shields.io/badge/frontend-React%20PWA-61dafb)

## What is this?

Saolrian is a calorie tracker with a difference: **self-hosting is a first-class feature.** The entire backend — database, auth, file storage, admin UI — is a single ~15 MB Go binary built on [PocketBase](https://pocketbase.io). The frontend is an installable PWA that asks you one question at first launch:

> *Hosted, or self-hosted?*

Same app either way. Your data either way.

## Features

### Logging
- 🍽️ **Food logging** — search 3M+ foods via [Open Food Facts](https://world.openfoodfacts.org), scan barcodes (camera + manual), save custom foods
- 🕘 **Recently logged** — the log screen opens on the foods you actually eat, pre-filled with the amount you last had, so a repeat meal is two taps
- ⚡ **Quick add** — log just calories (macros optional) in one tap, no search needed
- 🥘 **Recipes** — build a recipe from searched foods or manual macro entries, see total *and* per-serving macros, then log any number of servings to the diary as a single entry
- 🗓️ **Log to any day** — forgot yesterday? Add food straight from that day in History; it lands on the day you're looking at
- 🍳 **Smart meal default** — the meal slot is guessed from when you usually log into each one, not from whichever sorts first
- ✏️ **Edit & undo** — kebab menu on any diary entry; edit kcal/grams/meal in place, with grams driving the calories and macros. Deleting offers an undo rather than a confirmation
- 🗓️ **Customizable meal slots** — Breakfast, second breakfast, pre-workout — name your meals whatever you want, add or delete as many as you like

### Dashboard
- 📊 **Today** — animated budget meter, per-meal groups, remaining-calorie math
- 💧 **Water & steps** — quick-add taps for both, and either can be tapped and typed to set an exact figure (or corrected after a mis-tap)
- 🎯 **Your own targets** — macro, water and step goals come from your profile, not from built-in constants
- ⚖️ **Weight** — logged from Profile, stored as a full history of `weights` records
- 🗓️ **History** — week strip with adherence dots, day summary, weekly stats

### Everything else
- 🎯 **TDEE & goals** — Mifflin-St Jeor / Katch-McArdle, five activity levels, lose/maintain/gain at a weekly rate you pick, with macro targets. Targets are floored at a safe minimum, and the app says so when your chosen rate would go below it
- 📏 **Metric or imperial** — kg/cm or lb/ft-in, defaulted from your locale. Storage stays metric either way
- 📈 **Trends** — weight trend with a fitted rate, intake vs budget, cumulative energy balance, logging heatmap, macros, weekday pattern, meal split, water and steps; pick which cards you want
- 🧮 **Observed TDEE** — your real calorie burn worked out from your own intake and weight history, offered as a suggestion you accept rather than applied behind your back
- 📥 **Lose It! import** — bring your food-log history with you (CSV)
- 🎨 **Theming** — light / dark / system appearance plus 8 accent palettes or a custom colour, saved per user and per device
- 🔑 **Account** — password reset by email, and sign out from Profile (it keeps your server selected; use "Change server" on the sign-in screen to point somewhere else)
- 📴 **Offline-first PWA** — diary creates queue to localStorage when the network drops and replay when you're back
- 🔓 **Data export** — full CSV export, anytime

## Quick start (self-host)

The whole thing is one binary:

```bash
# grab a release (or build: cd backend && go build -o saolrian .)
./saolrian serve --http 0.0.0.0:8090
```

1. Visit `http://your-server:8090/_/` once to create the admin account
2. Serve the frontend (any static host) and open the app
3. At first launch choose **Self-hosted** and point it at your URL

Your data lives in a single SQLite file (`pb_data/`). Back it up:

```bash
litestream replicate ./pb_data/saolrian.db s3://your-bucket
```

### Docker

```bash
docker compose up -d   # full stack: backend + frontend + Caddy on :8080
```

One command brings up everything — the app UI at `http://server:8080`, the PocketBase admin at `http://server:8080/_/`, and Caddy routing `/api/*` to the backend. Data persists in the `pb_data` volume.

A `.env` file is optional and only needed to enable Web Push notifications. To enable it, copy `.env.example` to `.env` and fill in your VAPID keys (and `VAPID_SUBJECT`) before running `docker compose up -d`.

## Marketing site

The landing page lives in [`docs/site/`](docs/site/) as its own Vite + React
app, so it deploys to any static host without dragging marketing code into
the PWA bundle.

```bash
cd docs/site
npm install
npm run dev        # http://localhost:5174
npm run build      # → docs/site/dist/ (prerendered static HTML)
```

Every claim the page makes lives in `src/content.ts`, and the FAQ/software
JSON-LD is generated from the same arrays — see
[`docs/site/README.md`](docs/site/README.md).

## Development

```bash
# backend (Go 1.27+)
cd backend
go run . serve --http 127.0.0.1:8090

# frontend (Node 20+)
cd frontend
npm install
npm run dev        # http://localhost:5173
npm test           # vitest — 72 tests across 14 files
```

Point the app at `http://127.0.0.1:8090` in onboarding.

## Architecture

```
frontend/   React 19 + Vite 6 + TypeScript PWA, Tailwind v4 design tokens
            and a shared primitive set (Button/Card/Field/Sheet/Meter/...)
backend/    Go 1.27 + PocketBase 0.40 as a framework: SQLite, auth, S3
            storage, realtime, admin UI, custom /api/saolrian/* routes
docs/site/  marketing site (React 19 + Vite, prerendered static build)
docs/       logos, screenshots, design specs + plans
```

Custom API surface (v0, stable-ish):
- `GET  /api/saolrian/summary?date=YYYY-MM-DD` — day totals + meal groups + budget
- `GET  /api/saolrian/trends?days=` — day series, weight trend and observed TDEE
- `GET  /api/saolrian/food/search?q=` — local foods + Open Food Facts proxy
- `GET  /api/saolrian/food/barcode/:code` — OFF product lookup
- `POST /api/saolrian/import/loseit` — history import

All routes require auth. Everything else — including recipes and meal slots —
goes through plain PocketBase collections via the JS SDK, no custom handler.

Collections: `profiles`, `meal_slots`, `foods`, `diary_entries`, `weights`,
`daily_metrics`, `recipes`, `recipe_ingredients` — all user-scoped with
PocketBase API rules.

## Roadmap

**Next up** — designed, not yet built (see [`docs/superpowers/specs/`](docs/superpowers/specs/)):

- **Generic foods, offline** — a 21,834-food reference pack built from five national
  food-composition databases, bundled with the backend so the staples resolve without a
  network round trip and without depending on how someone happened to type a barcode
  label. The pack builds and verifies today; wiring it into search is the next step.

- **Full Lose It! import** — upload the whole "Export Data" zip instead of hunting
  for one CSV: the app shows which of the 24 supported categories it found (exercise,
  weight, sleep, steps, body fat, custom foods, recipes, goals), you pick what to
  import, and it runs as a background job that push-notifies you when it's done

**v2** — Health Connect (Android), Strava, Liftosaur connectors; unified energy-balance dashboards

**v3** — smart TDEE back-calculation, AI suggestions, family/coach sharing

## Data sources

Branded products come from [Open Food Facts](https://world.openfoodfacts.org). Generic
foods come from a reference pack of 21,834 entries (1.8 MB compressed) that
`backend/cmd/foodpack` builds from five national food-composition databases — built and
verified today, not yet wired into search. Every food keeps the licence of the dataset it
came from:

- **[USDA FoodData Central](https://fdc.nal.usda.gov/)** — Foundation Foods (411) and
  SR Legacy (7,791), published by the U.S. Department of Agriculture, Agricultural
  Research Service. Public domain.
- **[Canadian Nutrient File 2015](https://food-nutrition.canada.ca/cnf-fce/)** — 5,677
  foods, published by Health Canada. Contains information licensed under the
  [Open Government Licence – Canada](https://open.canada.ca/en/open-government-licence-canada).
- **[ANSES-CIQUAL 2025](https://ciqual.anses.fr/)** — 3,483 foods, published by ANSES
  (French Agency for Food, Environmental and Occupational Health & Safety). Used under
  the [Licence Ouverte / Open Licence](https://www.etalab.gouv.fr/licence-ouverte-open-licence/).
- **[McCance & Widdowson's CoFID 2021](https://www.gov.uk/government/publications/composition-of-foods-integrated-dataset-cofid)**
  — 2,884 foods, published by Public Health England. Contains public sector information
  licensed under the
  [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/).
- **[Australian Food Composition Database, Release 3](https://www.foodstandards.gov.au/science-data/food-composition-databases)**
  — 1,588 foods, published by Food Standards Australia New Zealand. Used under
  [CC BY 3.0 AU](https://creativecommons.org/licenses/by/3.0/au/).

None of these publishers endorse Saolrian. The data is reshaped on the way in —
nutrient names mapped onto one canonical vocabulary, values normalised per 100 g — so
anything the app gets wrong is ours to fix, not theirs.

## License

MIT — © 2026 BoannTech. Made in Ireland 🇮🇪

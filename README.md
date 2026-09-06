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
- ⚡ **Quick add** — log just calories (macros optional) in one tap, no search needed
- 🥘 **Recipes** — build a recipe from searched foods or manual macro entries, see total *and* per-serving macros, then log any number of servings to the diary as a single entry
- ✏️ **Edit & delete** — kebab menu on any diary entry; edit kcal/grams/meal in place, or delete
- 🗓️ **Customizable meal slots** — Breakfast, second breakfast, pre-workout — name your meals whatever you want, add or delete as many as you like

### Dashboard
- 📊 **Today** — animated budget meter, per-meal groups, remaining-calorie math
- 💧 **Water & steps** — quick +250/+500 ml and +1,000/+5,000 step taps, or type an exact water amount
- ⚖️ **Weight** — logged from Profile, stored as a full history of `weights` records
- 🗓️ **History** — week strip with adherence dots, day summary, weekly stats

### Everything else
- 🎯 **TDEE & goals** — Mifflin-St Jeor / Katch-McArdle, five activity levels, lose/maintain/gain with macro targets
- 📈 **Trends** — weight trend with a fitted rate, intake vs budget, cumulative energy balance, logging heatmap, macros, weekday pattern, meal split, water and steps; pick which cards you want
- 🧮 **Observed TDEE** — your real calorie burn worked out from your own intake and weight history, offered as a suggestion you accept rather than applied behind your back
- 📥 **Lose It! import** — bring your food-log history with you (CSV)
- 🎨 **Theming** — light / dark / system appearance plus 8 accent palettes or a custom colour, saved per user and per device
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

- **Full Lose It! import** — upload the whole "Export Data" zip instead of hunting
  for one CSV: the app shows which of the 24 supported categories it found (exercise,
  weight, sleep, steps, body fat, custom foods, recipes, goals), you pick what to
  import, and it runs as a background job that push-notifies you when it's done

**v2** — Health Connect (Android), Strava, Liftosaur connectors; unified energy-balance dashboards

**v3** — smart TDEE back-calculation, AI suggestions, family/coach sharing

## License

MIT — © 2026 BoannTech. Made in Ireland 🇮🇪

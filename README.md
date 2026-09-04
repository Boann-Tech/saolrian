# Saolrian

**Your life, tracked.** Calorie and fitness tracking you can actually own — self-hostable with a single binary, or use the hosted tier.

Inspired by the Irish words *saol* (life) and *rian* (track).

![Status](https://img.shields.io/badge/status-early_beta-0f7a5f) ![License](https://img.shields.io/badge/license-MIT-blue) ![Backend](https://img.shields.io/badge/backend-Go%20%2B%20PocketBase-00ADD8) ![Frontend](https://img.shields.io/badge/frontend-React%20PWA-61dafb)

## What is this?

Saolrian is a calorie tracker with a difference: **self-hosting is a first-class feature.** The entire backend — database, auth, file storage, admin UI — is a single ~15 MB Go binary built on [PocketBase](https://pocketbase.io). The frontend is an installable PWA that asks you one question at first launch:

> *Hosted, or self-hosted?*

Same app either way. Your data either way.

## Features (MVP)

- 🍽️ **Food logging** — search 3M+ foods via [Open Food Facts](https://world.openfoodfacts.org), scan barcodes (camera + manual), custom foods
- ⚡ **Quick add** — log just calories (macros optional) in one tap, no search needed
- ✏️ **Edit & delete** — kebab menu on any diary entry; edit kcal/grams/meal in place, or delete
- 💧 **Water & steps** — per-day hydration (+250/+500 ml) and step counters (+1,000/+5,000) on Today
- 🗓️ **Customizable meal slots** — Breakfast, second breakfast, pre-workout — name your meals whatever you want, add as many as you like
- 🎯 **TDEE & goals** — Mifflin-St Jeor / Katch-McArdle, five activity levels, lose/maintain/gain with macro targets
- 📊 **History & trends** — week view, adherence dots, weight tracking
- 📥 **Lose It! import** — bring your history with you
- 🎨 **Theming** — 8 accent palettes + custom color, per user and per instance
- 📴 **Offline-first PWA** — log meals on a plane, sync when you land
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

## Development

```bash
# backend (Go 1.24+)
cd backend
go run . serve --http 127.0.0.1:8090

# frontend (Node 20+)
cd frontend
npm install
npm run dev        # http://localhost:5173
```

Point the app at `http://127.0.0.1:8090` in onboarding.

## Architecture

```
frontend/   React 19 + Vite + TypeScript PWA (pocketbase JS SDK)
backend/    Go + PocketBase-as-framework: SQLite, auth, S3 storage,
            realtime, admin UI, custom /api/saolrian/* routes
docs/       landing page, logos, screenshots
```

Custom API surface (v0, stable-ish):
- `GET  /api/saolrian/summary?date=YYYY-MM-DD` — day totals + meal groups + budget
- `GET  /api/saolrian/food/search?q=` — local foods + Open Food Facts proxy
- `GET  /api/saolrian/food/barcode/:code` — OFF product lookup
- `POST /api/saolrian/import/loseit` — history import

Collections: `profiles`, `meal_slots`, `foods`, `diary_entries`, `weights` — all user-scoped with PocketBase API rules.

## Roadmap

- **v2** — Health Connect (Android), Strava, Liftosaur connectors; unified energy-balance dashboards
- **v3** — smart TDEE back-calculation, AI suggestions, family/coach sharing

## License

MIT — © 2026 BoannTech. Made in Ireland 🇮🇪

## Saolrian Frontend

React + Vite + TypeScript PWA for the Saolrian calorie tracker. Talks to a self-hosted PocketBase backend.

### Run

```sh
pnpm install   # or npm install
pnpm dev       # http://localhost:5173
pnpm build     # typecheck + production build
pnpm test      # vitest (nutrition math, CSV parsing, formatting)
```

### Architecture

- `src/lib/` — framework-free logic (unit-tested with vitest):
  - `nutrition.ts` — TDEE/BMR/macro math, mirrors the Go backend exactly (Mifflin-St Jeor / Katch-McArdle, activity factors, goal adjustments: lose −500, gain +350).
  - `loseit.ts` — defensive Lose It! CSV parser (header detection, column mapping by name, quoted fields).
  - `format.ts` — `Intl.NumberFormat` + local-date helpers.
  - `export.ts` — diary → CSV serialization.
  - `pb.ts` — PocketBase client factory, custom-endpoint `saolrianSend` helper, URL validation.
  - `offline.ts` — offline queue for diary creates; flushes on `online` event.
  - `storage.ts` — localStorage keys: `saolrian-endpoint`, `saolrian-theme`, `saolrian-offline-queue`.
- `src/state/AppContext.tsx` — single React context: endpoint, pb client, profile, meal slots, theme, refresh fns.
- `src/screens/` — Onboarding, Auth, Today, AddFood, History, ProfileGoals, Import.
- `src/components/` — hand-rolled ui primitives (Card/Button/Modal/Toast/Segmented), AppShell (bottom tab bar), MealGroup.

### Persistence

| localStorage key | Contents |
|---|---|
| `saolrian-endpoint` | Base URL of the PocketBase server ('' = unset → onboarding) |
| `saolrian-theme` | Accent hex color |
| `saolrian-offline-queue` | `[{endpoint, payload, queued_at}]` diary creates awaiting sync |

### Offline

If a diary-entry create fails with a network error, the payload is queued in localStorage and replayed automatically when the browser fires `online` (or on next app load). A pill in the header shows the pending count.

### PWA

`vite-plugin-pwa` with auto-update service worker. Workbox `NetworkFirst` strategy for `/api/` requests. Icons: SVG source (`public/icons/icon.svg`, rounded square + white S) rasterized to 192/512 PNG plus a maskable variant.

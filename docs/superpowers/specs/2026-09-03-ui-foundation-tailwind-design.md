# UI Foundation: Tailwind v4 token system + component layer + dark mode

Date: 2026-09-03
Status: Implemented (2026-09-04)

## Goal

Rebuild the frontend's styling foundation so the app reads as one coherent
system: a real token scale, a used component layer, no per-screen CSS drift,
and a full dark theme. The current "approved prototype" look is a starting
point — tasteful refinement of hierarchy, spacing rhythm, and alignment is in
scope, not just mechanical consolidation.

## Why now

The current frontend styling has structural problems:

- **`ui.tsx` primitives are disconnected from the CSS.** Nothing renders
  `<Button>`; every screen hand-writes `className="btn outline sm"`. The
  classes `Button` emits (`btn-primary`, `btn-md`) do not exist in `app.css`
  (which uses `.btn.outline`, `.btn.ghost`, `.btn.sm`). `Segmented` emits
  `.segmented`/`.seg` — also absent; the real control is `.goalseg`.
  `ui.css` is an empty comment file.
- **One 1,267-line `app.css`** of terse prototype class names
  (`.mrow .b`, `.v2.bad`, `.ncell.big`, `.nv2`) plus eight per-screen `.css`
  files. The white / hairline / radius-12 / faint-shadow surface is
  re-implemented at least six times (`.card`, `.balance`, `.stat`, `.move`,
  `.meals`, `.daycard`). `.sheet .done` re-implements `.btn`.
- **`tokens.css` has color tokens only** — no spacing, radius, type, shadow,
  z-index, or motion scale. Magic numbers everywhere: `13.5px`, `11.5px`,
  `padding: 22px 26px`, radii mixed across 9/10/11/12px.
- **No dark mode.** `tokens.css` is light-only.
- **Inline styles** scattered across screens (`style={{ marginTop: 16 }}`,
  `style={{ width: '100%', textAlign: 'center' }}`).

## Approach

Adopt Tailwind v4 with the token scale defined as the theme (`@theme`),
convert screens to utilities, and keep a small component layer for composites
and a small plain-CSS layer for genuinely bespoke visual effects. This was
chosen over a vanilla-CSS token refactor and over CSS Modules.

Trade-off accepted: this rewrites the markup of every screen and is a larger
diff than a vanilla refactor. Mitigation: migrate screen-by-screen behind a
stable primitive set, deleting each screen's `.css` file as it converts, with
`tsc` + tests + light/dark screenshots at every step.

## Current stack (verified)

- Vite 6.3, React 19.1, TypeScript 5.8, react-router-dom 7.6
- Vitest 3.1 + jsdom; one test: `src/__tests__/onboarding.test.tsx`
  (no class-name / DOM-class assertions — safe against restyle)
- `vite-plugin-pwa` configured with `theme_color: '#0f7a5f'`
- Runtime accent picker: `AppContext` stores a hex string (`theme`, default
  `#0f7a5f`, `localStorage` key `saolrian-theme`) and sets `--accent` on
  `document.documentElement`, and updates `<meta name="theme-color">`.

## Section 1 — Tooling & build

- Add dev deps: `tailwindcss@4`, `@tailwindcss/vite`,
  `class-variance-authority`, `clsx`, `tailwind-merge`,
  `prettier-plugin-tailwindcss`.
- `vite.config.ts`: add `@tailwindcss/vite` to `plugins`.
- Add `src/lib/cn.ts` — `cn(...)` = `twMerge(clsx(...))`.
- New entry stylesheet `src/styles/index.css`:
  - `@import "tailwindcss";`
  - `@import "./theme.css";` (the `@theme` block — Section 2)
  - `@import "./effects.css";` (bespoke visuals — Section 3)
- `main.tsx`: import `./styles/index.css`; remove the `./styles/app.css` and
  `./styles/tokens.css` imports once migration completes.
- `prettier` config gains `plugins: ["prettier-plugin-tailwindcss"]`.

## Section 2 — Token system (`src/styles/theme.css`)

Everything below lives in a single `@theme` block unless noted.

**Spacing.** Keep Tailwind's default 4px-based scale. No custom spacing scale.

**Radius.** `--radius-sm: 8px; --radius-md: 10px; --radius-lg: 12px;
--radius-xl: 16px; --radius-full: 999px;`
Usage rule: form controls & buttons → `md`; cards & tiles → `lg`; sheets &
modals → `xl`; pills / chips / dots → `full`. Replaces the current
9/10/11/12px mix.

**Type.** Eight steps, mapped from the current sizes with half-pixels
collapsed to the nearest step:
`--text-2xs: 11px; --text-xs: 12px; --text-sm: 13px; --text-base: 14px;
--text-md: 16px; --text-lg: 18px; --text-xl: 22px; --text-2xl: 28px;`
Body stays 14–15px equivalent; form controls keep a 16px floor (iOS
auto-zoom) via a base rule, not a token change.
Font families unchanged: `'Inter Tight', 'Inter', system-ui` for UI,
`'Fraunces', Georgia, serif` italic for the hero accent word.

**Shadow.** `--shadow-card` (the current `0 1px 2px rgba(10,37,64,.04)`),
`--shadow-pop` (hover lift, ~`0 3px 10px rgba(10,37,64,.07)`),
`--shadow-sheet` (`0 -12px 40px rgba(10,37,64,.18)` / modal
`0 12px 40px …`). Dark theme overrides these to deeper, lower-alpha values.

**Z-index.** `--z-tabbar: 15; --z-sheet-scrim: 28; --z-sheet: 30;
--z-toast: 40; --z-modal: 50;` (matches current values, now named).

**Motion.** `--ease-out: cubic-bezier(.2,.8,.2,1);`
`--dur-fast: .15s; --dur-mid: .3s; --dur-slow: .6s;`

**Color — semantic tokens, light values in `@theme`:**

| Token | Light | Role |
|---|---|---|
| `--color-bg` | `#ffffff` | page background |
| `--color-surface` | `#f6f9fc` | recessed surface (stat tiles, inputs bg) |
| `--color-raised` | `#ffffff` | cards / sheets / meal rows |
| `--color-border` | `#e3e8ee` | hairlines |
| `--color-text` | `#0a2540` | primary ink |
| `--color-text-muted` | `#425466` | secondary |
| `--color-text-faint` | `#8792a2` | captions / meta |
| `--color-accent` | `var(--accent, #0f7a5f)` | brand; tracks runtime picker |
| `--color-accent-soft` | `color-mix(in srgb, var(--accent) 9%, #fff)` | accent wash |
| `--color-accent-ink` | `color-mix(in srgb, var(--accent) 82%, #000)` | text on accent-soft |
| `--color-accent-line` | `color-mix(in srgb, var(--accent) 26%, #fff)` | accent hairline |
| `--color-good` | `#3ecf8e` | positive |
| `--color-good-ink` | `#057f5b` | positive text |
| `--color-warn` | `#b4530a` | over-budget text (was inline `#b4530a`) |
| `--color-warn-soft` | `rgba(224,163,75,.14)` | over-budget wash (was inline) |
| `--color-danger` | `#d64545` | destructive |

`--accent`, `--accent-soft`, `--accent-ink`, `--accent-line`, `--accent-glow`
also remain defined as plain custom properties on `:root` (re-derived from
`--accent` via `color-mix`) so the runtime picker keeps working; the
`@theme` `--color-accent*` tokens reference them.

**Dark mode.**
- `@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));`
- Dark values set in `@layer base` on `:root[data-theme=dark]`, plus a
  `@media (prefers-color-scheme: dark)` block scoped
  `:root:not([data-theme=light])` for the "system" default.
- Target dark palette (starting point, tuned during migration):
  `bg #0c1622`, `surface #12202f`, `raised #16273a`, `border #24384d`,
  `text #e7eef6`, `text-muted #9fb2c4`, `text-faint #6d8299`,
  `good #4ade9e`, `good-ink #4ade9e`, `warn #e0a34b`, `danger #ef6a6a`.
  Accent stays user-driven; `accent-soft`/`accent-ink` re-mix against the
  dark base (mix percentages adjusted so accent-soft is a dark tint, not a
  near-white wash).
- Shadows in dark: reduce alpha, increase blur/spread; hairlines carry more
  of the separation.

## Section 3 — Primitive component layer

`src/components/ui.tsx` → `src/components/ui/` (barrel `index.ts`). Each
primitive is a real component with `cva` variants, consumed on every screen.
Raw `className="btn …"` strings are eliminated.

| Primitive | Variants / props | Replaces |
|---|---|---|
| `Button` | `variant: primary\|outline\|ghost\|danger`, `size: sm\|md`, `block`, `loading` | ~35 raw `.btn*` call sites; dead `Button` in current `ui.tsx`; `.sheet .done` |
| `Card`, `CardTitle` | `padding` prop; `as` | `.card`, and the surface repeated in `.balance` / `.stat` / `.move` / `.meals` / `.daycard` |
| `Field` | `label`, `hint`, `error` | `.field` + `.field-label` + `.field-hint` |
| `TextInput`, `Select` | standard, token-styled, focus ring from `--color-accent-soft` | bare `input`/`select`, `.search` |
| `Stepper` | `value`, `onChange`, `step`, `min`, `suffix` | `.stepper` / `.ste` |
| `Segmented` | generic `<T extends string>`, `role="tablist"` | `.goalseg`; fixes dead `.segmented`/`.seg`; reused for meal-slot pills where it fits |
| `Sheet` | `open`, `onClose`, `title`; scrim + slide-up, `--z-sheet*`, `--ease-out` | `.sheet` / `.sheet-scrim` (theme picker); wraps `ScanSheet` body |
| `Modal` | kept API (`open`, `onClose`, `title`); restyled to share `Sheet` scrim + motion tokens | `.modal*` |
| `Toast` + `ToastProvider` + `useToast` | provider/API unchanged; restyled to tokens; `toast-err` → `--color-danger` | `.toast*` |
| `Spinner` | `size`, `tone` | `.spin` / `.spin.ink` |
| `Empty` | optional `icon`, `action` | `.empty` |
| `StatTile` | `label`, `value`, `sub`, `progress?` | `.stat*` |
| `Meter` | `value`, `max`, `over` | `.meter*` |
| `ProgressBar` | `pct`, `tone` | `.movebar`, `.stat .mini` |

**Bespoke visuals → `src/styles/effects.css`** (`@layer components`,
token-driven, ~100 lines):
- `.hero` gradient + `::after` rotated blob
- `.meter` fill gradient + width transition (component sets `--pct`)
- route-change slide+fade (`.view-wrap` keyframes)
- `.tabbar` translucency + `backdrop-filter` blur
- hidden-scrollbar utility for horizontal pill rows
- toast-in / sheet-in keyframes

Everything else is Tailwind utilities in JSX.

## Section 4 — Screen migration

Per step: convert JSX to utilities + primitives, delete that screen's `.css`
file, run `tsc -b` and `vitest run`, capture light + dark screenshots and
compare to the baseline. Refinement allowed per step: consistent section
padding, aligned radii/type steps, and real empty/loading/error states where
missing.

Order:

1. `AppShell` + tab bar — `components/shell.css`
2. `Today` + `MealGroup` — `screens/today.css`, `components/meals.css`
3. `AddFood` + `ScanSheet` — `screens/addfood.css`, `components/scansheet.css`
4. `ProfileGoals` + theme sheet — `screens/profile.css`
5. `History` — `screens/history.css`
6. `Onboarding` — `screens/onboarding.css`
7. `Welcome` — `screens/welcome.css`
8. `Auth` — `screens/auth.css`
9. `EditEntry` + `Import` — `screens/edit-entry.css`, `screens/import.css`

Then delete `src/styles/app.css` and `src/components/ui.css`; remove their
imports. `src/styles/tokens.css` content is absorbed into `theme.css` and the
file is deleted.

## Section 5 — Dark-mode wiring

- `AppContext`: add `mode: 'light' | 'dark' | 'system'` (persist
  `localStorage` key `saolrian-theme-mode`, default `system`); an effect sets
  or removes `data-theme` on `document.documentElement`. Existing `theme`
  (accent hex) is unchanged and orthogonal.
- Resolve "system" via `matchMedia('(prefers-color-scheme: dark)')` with a
  change listener so it updates live.
- `<meta name="theme-color">` follows the resolved theme (dark chrome color
  when dark); keep the accent-driven update too — resolved theme wins for the
  chrome, accent still tints where relevant.
- `ProfileGoals` theme sheet: add a `Light / System / Dark` `Segmented` above
  the accent swatches.
- Each screen is verified in both themes during its migration step, not in a
  separate later pass.

## Section 6 — Verification

- `tsc -b` clean.
- `vitest run` green. `onboarding.test.tsx` has no class assertions
  (verified); update only if a structural change breaks a query.
- `npm run build` succeeds; record CSS bundle size before/after.
- Screenshot pass, light + dark, at 320px and ~430px widths, against
  `docs/_shots/` baselines; new baselines saved to `docs/_shots/refine/`.
- Manual sweep: route transitions, toast stack, bottom sheets, barcode
  modal, steppers, `:focus-visible` rings, tab bar hide/show on
  Onboarding/AddFood/Auth, offline queue pill.

## Out of scope

- No routing, data-layer, or PocketBase changes.
- No new screens or features (the `Light/System/Dark` control is the only
  new UI affordance).
- No component-library dependency (Radix, etc.) — primitives stay hand-rolled.
- No visual redesign beyond refinement of the existing language.

## Risks

- **Screen-markup churn is large.** Mitigated by strict per-screen steps with
  test + screenshot gates; each step is independently revertible.
- **Runtime accent picker interaction with `@theme`.** Verified approach:
  keep `--accent*` as `:root` custom props, have `@theme` colors reference
  them. Must be checked first, in the Section 1/2 step, before screens move.
- **Dark accent-soft legibility.** The `color-mix` percentages that produce a
  near-white wash in light mode produce a muddy tint in dark; dark overrides
  must re-specify the mix, not just the base colors.
- **PWA `theme_color`** in the manifest is static; only the runtime `<meta>`
  can be theme-aware. Acceptable.

# UI Foundation (Tailwind v4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the frontend's ad-hoc CSS with a Tailwind v4 token system, a used component layer, and a full dark theme, migrating every screen off its per-screen stylesheet.

**Architecture:** Tailwind v4 with the design scale defined in a CSS `@theme` block (no JS config). Semantic color tokens (light + dark) plus radius/type/shadow/z/motion scales. A hand-rolled primitive component layer (`src/components/ui/`) built with `class-variance-authority` replaces raw `className="btn …"` strings. Genuinely bespoke visuals (hero gradient, meter fill, tab-bar blur, route transition) live in one small `src/styles/effects.css`. Screens migrate one at a time behind the stable primitives; each screen's `.css` file is deleted as it converts. The legacy `tokens.css` variable names survive as aliases in `theme.css` until the last screen is done, so un-migrated screens keep rendering (and pick up dark mode) throughout.

**Tech Stack:** Vite 6, React 19, TypeScript 5.8, react-router-dom 7, Vitest 3 + jsdom, `tailwindcss@4`, `@tailwindcss/vite`, `class-variance-authority`, `clsx`, `tailwind-merge`.

**Spec:** `docs/superpowers/specs/2026-09-03-ui-foundation-tailwind-design.md`

## Global Constraints

- All commands run from `frontend/`. Working dir for every task: `frontend/`.
- Vite version floor for Tailwind v4: **5.0** (project is on 6.3 — OK). Do not downgrade Vite.
- No new runtime dependencies beyond `class-variance-authority`, `clsx`, `tailwind-merge`. No component library (Radix, Headless UI, etc.). Primitives stay hand-rolled.
- No routing, data-layer, PocketBase, or feature changes. The only new UI affordance in the whole plan is the `Light / System / Dark` control added in Task 11.
- Form controls keep a **16px minimum font-size** (iOS Safari auto-zooms focused inputs below 16px). Enforce via a base rule, never drop below it.
- The runtime accent picker must keep working: `AppContext` sets `--accent` on `document.documentElement`; `@theme` color `--color-accent` resolves through `var(--accent)`. Never hard-code the accent hex into a utility.
- localStorage keys are fixed: `saolrian-theme` (accent hex, existing), `saolrian-theme-mode` (new: `light` | `dark` | `system`).
- The Onboarding test (`src/__tests__/onboarding.test.tsx`) queries `selector: '.wordmark'`. Keep a `wordmark` class on that element (Task 13) or update the test in the same task.
- After every task: `npx tsc -b` is clean and `npx vitest run` is green before committing.
- Commit at the end of each task with the message shown in that task's final step.

## Shared Reference: class → token / utility mapping

Every screen-migration task (Tasks 9–16) applies this mapping. It is defined once here; tasks point back to it.

**Legacy CSS var → new semantic token (both exist during migration; use the new name in migrated JSX):**

| Legacy (`tokens.css`) | New (`theme.css`) | Tailwind utility examples |
|---|---|---|
| `--bg` | `--color-bg` | `bg-bg` |
| `--surface` | `--color-surface` | `bg-surface` |
| (`#fff` card fills) | `--color-raised` | `bg-raised` |
| `--line` | `--color-border` | `border-border` |
| `--ink` | `--color-text` | `text-text` |
| `--muted` | `--color-text-muted` | `text-text-muted` |
| `--faint` | `--color-text-faint` | `text-text-faint` |
| `--accent` | `--color-accent` | `bg-accent` `text-accent` |
| `--accent-soft` | `--color-accent-soft` | `bg-accent-soft` |
| `--accent-ink` | `--color-accent-ink` | `text-accent-ink` |
| `--accent-line` | `--color-accent-line` | `border-accent-line` |
| `--good` / `--good-ink` | `--color-good` / `--color-good-ink` | `text-good-ink` |
| `#b4530a` (inline over-budget) | `--color-warn` | `text-warn` |
| `--danger` | `--color-danger` | `text-danger` |

**Ad-hoc pixel value → scale token:**

| Found in current CSS | Use |
|---|---|
| `border-radius: 9/10/11px` (controls) | `rounded-md` (10px) |
| `border-radius: 12px` (cards/tiles) | `rounded-lg` (12px) |
| `border-radius: 22px` (sheets/modals) | `rounded-xl` (16px) — sheets get `rounded-t-xl` |
| `border-radius: 99px` | `rounded-full` |
| `font-size: 11 / 11.5px` | `text-2xs` (11px) |
| `font-size: 12 / 12.5px` | `text-xs` (12px) |
| `font-size: 13 / 13.5px` | `text-sm` (13px) |
| `font-size: 14 / 14.5px` | `text-base` (14px) |
| `font-size: 16px` | `text-md` |
| `font-size: 17 / 18px` | `text-lg` |
| `font-size: 21 / 22px` | `text-xl` |
| `font-size: 27 / 29px` | `text-2xl` (28px) |
| `box-shadow: 0 1px 2px rgba(10,37,64,.04)` | `shadow-card` |
| `box-shadow: 0 3px 10px rgba(10,37,64,.07)` | `shadow-pop` |
| `box-shadow: 0 ±12px 40px rgba(10,37,64,.18)` | `shadow-sheet` |
| section padding `22px 26px` / `16px 26px 12px` | `px-6 py-5` (24/20) — one section rhythm app-wide |
| `transition: … .15s ease` | `transition` (Tailwind default 150ms) |
| `cubic-bezier(.2,.8,.2,1)` | `ease-out` (mapped in `@theme`) |

**Primitive swaps (Tasks 9–16):**

| Current markup | Replace with |
|---|---|
| `<button className="btn">` | `<Button>` |
| `<button className="btn outline">` | `<Button variant="outline">` |
| `<button className="btn ghost">` | `<Button variant="ghost">` |
| `<button className="btn outline sm">` | `<Button variant="outline" size="sm">` |
| `<button className="btn" disabled={saving}>` + manual `.spin` | `<Button loading={saving}>` |
| `<div className="card" style={{padding:'16px 18px'}}>` | `<Card>` |
| `.field` + `.field-label` + `.field-hint` blocks | `<Field label hint>` |
| bare `<input>` / `.search` | `<TextInput>` |
| bare `<select>` | `<Select>` |
| `.stepper` +/- control | `<Stepper>` |
| `.goalseg` buttons | `<Segmented>` |
| `.sheet` + `.sheet-scrim` | `<Sheet>` |
| `.modal*` | `<Modal>` (unchanged API) |
| `.stat*` tile | `<StatTile>` |
| `.meter*` | `<Meter>` |
| `.movebar` / `.stat .mini` | `<ProgressBar>` |
| `.empty` | `<Empty>` |
| inline `.spin` | `<Spinner>` |

**Screen-task procedure (identical for Tasks 9–16):**
1. Read the screen's `.tsx` and its `.css`.
2. Convert the JSX: swap primitives per the table, convert remaining structural CSS to utilities per the mapping, delete inline `style={{…}}` that the mapping covers (keep dynamic ones like `style={{ width: \`${pct}%\` }}`).
3. Delete the screen's `.css` file and its `import './x.css'` line.
4. Refinement pass allowed: unify section padding, align radii/type to the scale, add missing empty/loading/error states using `<Empty>` / `<Spinner>`.
5. `npx tsc -b` → clean.
6. `npx vitest run` → green.
7. `npm run build` → succeeds.
8. `npm run dev`, open the screen, verify against the pre-migration look in **both** themes (toggle `document.documentElement.dataset.theme`). Structure and spacing match; colors resolve; nothing unstyled.
9. Commit.

---

### Task 1: Install Tailwind v4 and wire the entry stylesheet

**Files:**
- Modify: `frontend/package.json` (dependencies)
- Modify: `frontend/vite.config.ts`
- Create: `frontend/src/lib/cn.ts`
- Create: `frontend/src/styles/index.css`
- Modify: `frontend/src/main.tsx:15-16`

**Interfaces:**
- Produces: `cn(...classes)` from `src/lib/cn.ts` — `(...inputs: ClassValue[]) => string`, merges Tailwind classes (later of two conflicting wins).
- Produces: `src/styles/index.css` as the single stylesheet entry: pulls in Tailwind, `theme.css` (Task 2), `effects.css` (Task 8).

- [ ] **Step 1: Install packages**

```bash
npm install -D tailwindcss@^4 @tailwindcss/vite@^4
npm install clsx tailwind-merge class-variance-authority
```

Expected: `package.json` gains `tailwindcss` + `@tailwindcss/vite` under devDependencies and the three runtime helpers under dependencies. `npm ls tailwindcss` shows a 4.x version.

- [ ] **Step 2: Add the Vite plugin**

In `frontend/vite.config.ts`, import and register the plugin as the first entry in `plugins`:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    VitePWA({
      // …unchanged…
    }),
  ],
  server: { port: 5173, strictPort: true },
});
```

- [ ] **Step 3: Create the `cn` helper**

`frontend/src/lib/cn.ts`:

```ts
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Join conditional class names and de-conflict Tailwind utilities. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 4: Create the entry stylesheet**

`frontend/src/styles/index.css`:

```css
@import 'tailwindcss';
@import './theme.css';
@import './effects.css';

/* Form controls keep a 16px floor — iOS Safari auto-zooms below it. */
input,
select,
textarea {
  font-size: 16px;
  line-height: 1.4;
}
```

Note: `theme.css` and `effects.css` do not exist yet. Create empty placeholders so the build resolves:

```bash
: > src/styles/theme.css
: > src/styles/effects.css
```

- [ ] **Step 5: Point `main.tsx` at the new entry, keep the legacy sheets for now**

In `frontend/src/main.tsx`, the import block currently reads:

```ts
import { AppShell } from './components/AppShell';
import './styles/tokens.css';
import './styles/app.css';
```

Change to:

```ts
import { AppShell } from './components/AppShell';
import './styles/index.css';
import './styles/tokens.css';
import './styles/app.css';
```

(`tokens.css` + `app.css` stay imported until Task 17 — un-migrated screens still need them.)

- [ ] **Step 6: Verify the build**

Run: `npm run build`
Expected: PASS. Then confirm Tailwind actually ran:

```bash
grep -rl "tailwindcss" dist/assets/*.css
```

Expected: at least one built CSS file mentions Tailwind's layer comments / reset.

- [ ] **Step 7: Verify tests still pass**

Run: `npx vitest run`
Expected: PASS (all existing onboarding tests green).

- [ ] **Step 8: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/vite.config.ts frontend/src/lib/cn.ts frontend/src/styles/index.css frontend/src/styles/theme.css frontend/src/styles/effects.css frontend/src/main.tsx
git commit -m "build: add Tailwind v4 + cn helper, wire styles/index.css entry"
```

---

### Task 2: Token system in `theme.css` (scales + semantic colors + dark + legacy aliases)

**Files:**
- Modify: `frontend/src/styles/theme.css` (currently empty)

**Interfaces:**
- Produces: `@theme` tokens usable as Tailwind utilities across all later tasks:
  - colors: `bg`, `surface`, `raised`, `border`, `text`, `text-muted`, `text-faint`, `accent`, `accent-soft`, `accent-ink`, `accent-line`, `good`, `good-ink`, `warn`, `warn-soft`, `danger`
  - radius: `sm` 8 / `md` 10 / `lg` 12 / `xl` 16 / `full`
  - text: `2xs` 11 / `xs` 12 / `sm` 13 / `base` 14 / `md` 16 / `lg` 18 / `xl` 22 / `2xl` 28
  - shadow: `card`, `pop`, `sheet`
  - ease: `out`
- Produces: dark theme active when `document.documentElement` has `data-theme="dark"`, or (no `data-theme` / `data-theme` absent) when the OS prefers dark. `data-theme="light"` forces light.
- Produces: legacy custom properties (`--bg`, `--ink`, `--surface`, `--line`, `--faint`, `--muted`, `--good`, `--good-ink`, `--danger`, `--accent-soft`, `--accent-ink`, `--accent-line`, `--accent-glow`) still defined, now aliased to the new tokens and theme-aware, so `app.css` + un-migrated screen CSS keep working and gain dark mode.

- [ ] **Step 1: Write `theme.css`**

`frontend/src/styles/theme.css`:

```css
/* ─────────────────────────────────────────────────────────────
   Design tokens. Single source of truth for the Tailwind theme.
   Semantic color names; light values here, dark values below.
   ───────────────────────────────────────────────────────────── */

@custom-variant dark (&:where([data-theme='dark'], [data-theme='dark'] *));

@theme {
  --radius-sm: 8px;
  --radius-md: 10px;
  --radius-lg: 12px;
  --radius-xl: 16px;
  --radius-full: 999px;

  --text-2xs: 11px;
  --text-xs: 12px;
  --text-sm: 13px;
  --text-base: 14px;
  --text-md: 16px;
  --text-lg: 18px;
  --text-xl: 22px;
  --text-2xl: 28px;

  --shadow-card: 0 1px 2px rgba(10, 37, 64, 0.04);
  --shadow-pop: 0 3px 10px rgba(10, 37, 64, 0.07);
  --shadow-sheet: 0 12px 40px rgba(10, 37, 64, 0.18);

  --ease-out: cubic-bezier(0.2, 0.8, 0.2, 1);

  /* Colors — semantic. `--accent` is set at runtime by AppContext. */
  --color-bg: #ffffff;
  --color-surface: #f6f9fc;
  --color-raised: #ffffff;
  --color-border: #e3e8ee;
  --color-text: #0a2540;
  --color-text-muted: #425466;
  --color-text-faint: #8792a2;

  --color-accent: var(--accent, #0f7a5f);
  --color-accent-soft: var(--accent-soft);
  --color-accent-ink: var(--accent-ink);
  --color-accent-line: var(--accent-line);

  --color-good: #3ecf8e;
  --color-good-ink: #057f5b;
  --color-warn: #b4530a;
  --color-warn-soft: rgba(224, 163, 75, 0.14);
  --color-danger: #d64545;
}

/* Runtime-derived accent tints. Kept as :root custom props (not @theme
   literals) so they re-mix whenever AppContext rewrites --accent.
   Redefined per-theme below. */
:root {
  --accent: #0f7a5f;
  --accent-soft: color-mix(in srgb, var(--accent) 9%, #fff);
  --accent-ink: color-mix(in srgb, var(--accent) 82%, #000);
  --accent-line: color-mix(in srgb, var(--accent) 26%, #fff);
  --accent-glow: color-mix(in srgb, var(--accent) 42%, transparent);
  color-scheme: light;
}

/* ── Dark palette ──────────────────────────────────────────────
   Applied when data-theme=dark, OR when the OS prefers dark and no
   explicit data-theme=light is set. */
:root[data-theme='dark'] {
  color-scheme: dark;
  --color-bg: #0c1622;
  --color-surface: #12202f;
  --color-raised: #16273a;
  --color-border: #24384d;
  --color-text: #e7eef6;
  --color-text-muted: #9fb2c4;
  --color-text-faint: #6d8299;
  --color-good: #4ade9e;
  --color-good-ink: #4ade9e;
  --color-warn: #e0a34b;
  --color-warn-soft: rgba(224, 163, 75, 0.18);
  --color-danger: #ef6a6a;
  --shadow-card: 0 1px 2px rgba(0, 0, 0, 0.4);
  --shadow-pop: 0 4px 14px rgba(0, 0, 0, 0.5);
  --shadow-sheet: 0 12px 48px rgba(0, 0, 0, 0.6);
  /* Dark accent tints: mix toward the dark base, not white. */
  --accent-soft: color-mix(in srgb, var(--accent) 22%, #16273a);
  --accent-ink: color-mix(in srgb, var(--accent) 70%, #fff);
  --accent-line: color-mix(in srgb, var(--accent) 40%, #24384d);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    color-scheme: dark;
    --color-bg: #0c1622;
    --color-surface: #12202f;
    --color-raised: #16273a;
    --color-border: #24384d;
    --color-text: #e7eef6;
    --color-text-muted: #9fb2c4;
    --color-text-faint: #6d8299;
    --color-good: #4ade9e;
    --color-good-ink: #4ade9e;
    --color-warn: #e0a34b;
    --color-warn-soft: rgba(224, 163, 75, 0.18);
    --color-danger: #ef6a6a;
    --shadow-card: 0 1px 2px rgba(0, 0, 0, 0.4);
    --shadow-pop: 0 4px 14px rgba(0, 0, 0, 0.5);
    --shadow-sheet: 0 12px 48px rgba(0, 0, 0, 0.6);
    --accent-soft: color-mix(in srgb, var(--accent) 22%, #16273a);
    --accent-ink: color-mix(in srgb, var(--accent) 70%, #fff);
    --accent-line: color-mix(in srgb, var(--accent) 40%, #24384d);
  }
}

/* ── Legacy aliases ───────────────────────────────────────────
   Keep app.css + un-migrated screen CSS working (and theme-aware)
   until Task 17 removes them. */
:root {
  --bg: var(--color-bg);
  --ink: var(--color-text);
  --surface: var(--color-surface);
  --line: var(--color-border);
  --faint: var(--color-text-faint);
  --muted: var(--color-text-muted);
  --good: var(--color-good);
  --good-ink: var(--color-good-ink);
  --danger: var(--color-danger);
}

body {
  background: var(--color-bg);
  color: var(--color-text);
}
```

- [ ] **Step 2: Remove the now-duplicated `:root` block from `tokens.css`**

`frontend/src/styles/tokens.css` currently opens with a `:root { --accent … --danger … }` block (lines 1–15) and then has base element rules (`*`, `html, body`, `body`, `button`, `input`, `a`). Delete **only** the opening `:root { … }` color block; keep the base element rules. `theme.css` now owns colors. This avoids two conflicting `--accent` defaults.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS. Then:

```bash
CSS=$(ls -1 dist/assets/*.css | head -1)
grep -q -- "--color-bg" "$CSS" && echo "tokens present"
grep -q "data-theme" "$CSS" && echo "dark rules present"
```

Expected: both echo lines print.

- [ ] **Step 4: Sanity-check dark resolves in the browser**

Run: `npm run dev`. In DevTools console:

```js
document.documentElement.dataset.theme = 'dark';
getComputedStyle(document.body).backgroundColor; // → rgb(12, 22, 34)
document.documentElement.dataset.theme = 'light';
getComputedStyle(document.body).backgroundColor; // → rgb(255, 255, 255)
```

Expected: values flip as shown. Existing screens (still on `app.css`) visibly darken.

- [ ] **Step 5: Tests**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/styles/theme.css frontend/src/styles/tokens.css
git commit -m "feat: design token system (scales + semantic light/dark colors)"
```

---

### Task 3: Dark-mode state in AppContext

**Files:**
- Modify: `frontend/src/lib/storage.ts`
- Modify: `frontend/src/state/AppContext.tsx`
- Create: `frontend/src/state/__tests__/theme-mode.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces on the `useApp()` context object:
  - `mode: 'light' | 'dark' | 'system'`
  - `setMode: (m: 'light' | 'dark' | 'system') => void`
  - `resolvedTheme: 'light' | 'dark'` (what `mode` resolves to right now)
- Produces in `storage.ts`: `THEME_MODE_KEY = 'saolrian-theme-mode'`, `getStoredMode(): 'light'|'dark'|'system'`, `setStoredMode(m): void`.
- Side effect: `document.documentElement` gets `data-theme="light"` or `data-theme="dark"` set to match `resolvedTheme` (never left unset once the provider mounts). `<meta name="theme-color">` is set to `#0c1622` when dark, else the accent hex.

- [ ] **Step 1: Write the failing test**

`frontend/src/state/__tests__/theme-mode.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { AppProvider, useApp } from '../AppContext';

function Probe() {
  const { mode, resolvedTheme, setMode } = useApp();
  return (
    <div>
      <span data-testid="mode">{mode}</span>
      <span data-testid="resolved">{resolvedTheme}</span>
      <button onClick={() => setMode('dark')}>go dark</button>
      <button onClick={() => setMode('system')}>go system</button>
    </div>
  );
}

let prefersDark = false;
beforeEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  prefersDark = false;
  vi.stubGlobal(
    'matchMedia',
    (q: string) =>
      ({
        matches: q.includes('dark') ? prefersDark : false,
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('theme mode', () => {
  it('defaults to system and resolves via prefers-color-scheme', () => {
    prefersDark = true;
    render(
      <AppProvider>
        <Probe />
      </AppProvider>,
    );
    expect(screen.getByTestId('mode').textContent).toBe('system');
    expect(screen.getByTestId('resolved').textContent).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('setMode("dark") pins dark, persists, and sets the attribute', () => {
    render(
      <AppProvider>
        <Probe />
      </AppProvider>,
    );
    act(() => {
      screen.getByText('go dark').click();
    });
    expect(screen.getByTestId('resolved').textContent).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('saolrian-theme-mode')).toBe('dark');
  });

  it('reads a persisted mode on init', () => {
    localStorage.setItem('saolrian-theme-mode', 'light');
    prefersDark = true; // must be ignored
    render(
      <AppProvider>
        <Probe />
      </AppProvider>,
    );
    expect(screen.getByTestId('mode').textContent).toBe('light');
    expect(screen.getByTestId('resolved').textContent).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run src/state/__tests__/theme-mode.test.tsx`
Expected: FAIL — `mode` / `resolvedTheme` / `setMode` are `undefined`.

- [ ] **Step 3: Add storage helpers**

Append to `frontend/src/lib/storage.ts` (near the theme helpers):

```ts
export const THEME_MODE_KEY = 'saolrian-theme-mode';
export type ThemeMode = 'light' | 'dark' | 'system';

export function getStoredMode(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_MODE_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function setStoredMode(m: ThemeMode): void {
  try {
    localStorage.setItem(THEME_MODE_KEY, m);
  } catch {
    /* ignore */
  }
}
```

- [ ] **Step 4: Wire AppContext**

In `frontend/src/state/AppContext.tsx`:

Add to imports from `../lib/storage`: `getStoredMode, setStoredMode, type ThemeMode`.

Add to the `AppState` interface:

```ts
  mode: ThemeMode;
  resolvedTheme: 'light' | 'dark';
  setMode: (m: ThemeMode) => void;
```

Inside `AppProvider`, after the `theme` state:

```ts
  const [mode, setModeState] = useState<ThemeMode>(() => getStoredMode());
  const [systemDark, setSystemDark] = useState<boolean>(
    () => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches,
  );

  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const resolvedTheme: 'light' | 'dark' =
    mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolvedTheme);
  }, [resolvedTheme]);

  const setMode = useCallback((m: ThemeMode) => {
    setStoredMode(m);
    setModeState(m);
  }, []);
```

Change the existing theme-reflection effect so the chrome color follows the resolved theme:

```ts
  useEffect(() => {
    document.documentElement.style.setProperty('--accent', theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', resolvedTheme === 'dark' ? '#0c1622' : theme);
  }, [theme, resolvedTheme]);
```

Add `mode`, `resolvedTheme`, `setMode` to the `value` object and its `useMemo` dependency array.

- [ ] **Step 5: Run the tests, verify they pass**

Run: `npx vitest run src/state/__tests__/theme-mode.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 6: Full test + typecheck**

Run: `npx tsc -b && npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/storage.ts frontend/src/state/AppContext.tsx frontend/src/state/__tests__/theme-mode.test.tsx
git commit -m "feat: light/dark/system theme mode in AppContext"
```

---

### Task 4: Primitive layer — folder scaffold, `Button`, `Card`

**Files:**
- Create: `frontend/src/components/ui/index.ts`
- Create: `frontend/src/components/ui/Button.tsx`
- Create: `frontend/src/components/ui/Card.tsx`
- Create: `frontend/src/components/ui/__tests__/Button.test.tsx`
- Create: `frontend/src/components/ui/__tests__/Card.test.tsx`
- Modify: `frontend/src/components/ui.tsx` (re-export from the new folder; see Step 6)

**Interfaces:**
- Produces:
  - `Button` — `props: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary'|'outline'|'ghost'|'danger'; size?: 'sm'|'md'; block?: boolean; loading?: boolean }`. When `loading`: renders a leading `<Spinner>`, sets `disabled`, keeps children visible.
  - `Card` — `props: { as?: 'div'|'section'; padding?: 'none'|'sm'|'md'; className?: string; children: ReactNode } & HTMLAttributes`. `padding` default `'md'` → `p-4`.
  - `CardTitle` — `props: { children: ReactNode; right?: ReactNode }`.
- Consumes: `cn` from `../../lib/cn`; `Spinner` from `./feedback` is created in Task 6 — for now `Button` uses a local inline spinner span (replaced in Task 6 Step 7).

- [ ] **Step 1: Write failing tests**

`frontend/src/components/ui/__tests__/Button.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Button } from '../Button';

describe('Button', () => {
  it('renders children and defaults to primary/md', () => {
    render(<Button>Save</Button>);
    const b = screen.getByRole('button', { name: 'Save' });
    expect(b.className).toMatch(/bg-accent/);
  });

  it('applies the outline variant and sm size', () => {
    render(
      <Button variant="outline" size="sm">
        Add
      </Button>,
    );
    const b = screen.getByRole('button', { name: 'Add' });
    expect(b.className).toMatch(/border/);
  });

  it('loading disables the button and shows a status element', () => {
    render(<Button loading>Add slot</Button>);
    const b = screen.getByRole('button', { name: /Add slot/ });
    expect(b).toBeDisabled();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('passes through onClick and type', () => {
    render(
      <Button type="submit" className="mt-4">
        Go
      </Button>,
    );
    const b = screen.getByRole('button', { name: 'Go' });
    expect(b).toHaveAttribute('type', 'submit');
    expect(b.className).toMatch(/mt-4/);
  });
});
```

`frontend/src/components/ui/__tests__/Card.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Card, CardTitle } from '../Card';

describe('Card', () => {
  it('renders a div with raised background and default padding', () => {
    render(<Card>body</Card>);
    const el = screen.getByText('body');
    expect(el.className).toMatch(/bg-raised/);
    expect(el.className).toMatch(/p-4/);
  });

  it('padding="none" drops the padding utility', () => {
    render(<Card padding="none">bare</Card>);
    expect(screen.getByText('bare').className).not.toMatch(/\bp-4\b/);
  });

  it('CardTitle renders a heading and an optional right slot', () => {
    render(<CardTitle right={<span>edit</span>}>Hydration</CardTitle>);
    expect(screen.getByRole('heading', { name: 'Hydration' })).toBeInTheDocument();
    expect(screen.getByText('edit')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run them, verify they fail**

Run: `npx vitest run src/components/ui/__tests__/`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `Button`**

`frontend/src/components/ui/Button.tsx`:

```tsx
import type { ButtonHTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/cn';

const button = cva(
  'inline-flex items-center justify-center gap-2 font-semibold transition ' +
    'disabled:opacity-35 disabled:pointer-events-none active:scale-[.98] ' +
    'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/40',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-white hover:brightness-108',
        outline: 'bg-raised border border-border text-text hover:border-accent-line hover:text-accent-ink',
        ghost: 'bg-transparent text-accent-ink hover:bg-accent-soft',
        danger: 'bg-danger text-white hover:brightness-108',
      },
      size: {
        sm: 'text-sm rounded-md px-2.5 py-1.5',
        md: 'text-base rounded-md px-3.5 py-3',
      },
      block: { true: 'w-full', false: '' },
    },
    defaultVariants: { variant: 'primary', size: 'md', block: false },
  },
);

type Props = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof button> & { loading?: boolean };

export function Button({ variant, size, block, loading, disabled, className, children, ...rest }: Props) {
  return (
    <button
      className={cn(button({ variant, size, block }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && (
        <span
          role="status"
          aria-label="Loading"
          className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white"
        />
      )}
      {children}
    </button>
  );
}
```

Note: `hover:brightness-108` needs an arbitrary value — use `hover:brightness-[1.08]`. Fix both occurrences.

- [ ] **Step 4: Implement `Card`**

`frontend/src/components/ui/Card.tsx`:

```tsx
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

const PAD = { none: '', sm: 'p-3', md: 'p-4' } as const;

export function Card({
  as: Tag = 'div',
  padding = 'md',
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLElement> & {
  as?: 'div' | 'section';
  padding?: keyof typeof PAD;
  children: ReactNode;
}) {
  return (
    <Tag
      className={cn('rounded-lg border border-border bg-raised shadow-card', PAD[padding], className)}
      {...rest}
    >
      {children}
    </Tag>
  );
}

export function CardTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-baseline justify-between">
      <h3 className="text-md font-bold tracking-[-.01em]">{children}</h3>
      {right}
    </div>
  );
}
```

- [ ] **Step 5: Barrel export**

`frontend/src/components/ui/index.ts`:

```ts
export { Button } from './Button';
export { Card, CardTitle } from './Card';
```

- [ ] **Step 6: Keep the old import path alive**

Screens currently do `import { Field, useToast } from '../components/ui'`. That resolves to `src/components/ui.tsx`. Leave `ui.tsx` in place for now; at the **end** of Task 7, `ui.tsx` is replaced by a re-export of `./ui/index.ts`. Do not touch `ui.tsx` in this task.

- [ ] **Step 7: Run tests, verify pass**

Run: `npx vitest run src/components/ui/__tests__/`
Expected: PASS (7 tests).

- [ ] **Step 8: Typecheck + full test**

Run: `npx tsc -b && npx vitest run`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/components/ui/
git commit -m "feat: ui primitives — Button, Card"
```

---

### Task 5: Form primitives — `Field`, `TextInput`, `Select`, `Stepper`, `Segmented`

**Files:**
- Create: `frontend/src/components/ui/Field.tsx` (`Field`, `TextInput`, `Select`)
- Create: `frontend/src/components/ui/Stepper.tsx`
- Create: `frontend/src/components/ui/Segmented.tsx`
- Create: `frontend/src/components/ui/__tests__/form.test.tsx`
- Modify: `frontend/src/components/ui/index.ts`

**Interfaces:**
- Consumes: `cn`.
- Produces:
  - `Field` — `{ label: string; hint?: string; error?: string; children: ReactNode }`; wraps in `<label>`, renders `.field-label`-equivalent, hint in `text-text-faint`, error in `text-danger` (replaces hint when set).
  - `TextInput` — `InputHTMLAttributes<HTMLInputElement>`; token-styled, 16px, focus ring `ring-2 ring-accent-soft border-accent`.
  - `Select` — `SelectHTMLAttributes<HTMLSelectElement>`; same shell as `TextInput`.
  - `Stepper` — `{ value: number; onChange: (n: number) => void; step?: number; min?: number; max?: number; suffix?: string; 'aria-label'?: string }`.
  - `Segmented<T extends string>` — `{ value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; 'aria-label'?: string }`; `role="tablist"`, buttons `role="tab"` with `aria-selected`.

- [ ] **Step 1: Write failing tests**

`frontend/src/components/ui/__tests__/form.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Field, TextInput, Select } from '../Field';
import { Stepper } from '../Stepper';
import { Segmented } from '../Segmented';

describe('Field', () => {
  it('associates the label and shows the hint', () => {
    render(
      <Field label="Height" hint="in centimetres">
        <TextInput />
      </Field>,
    );
    expect(screen.getByText('Height')).toBeInTheDocument();
    expect(screen.getByText('in centimetres')).toBeInTheDocument();
  });

  it('error replaces hint and uses danger colour', () => {
    render(
      <Field label="Email" hint="we never share it" error="required">
        <TextInput />
      </Field>,
    );
    expect(screen.queryByText('we never share it')).not.toBeInTheDocument();
    expect(screen.getByText('required').className).toMatch(/text-danger/);
  });
});

describe('Select', () => {
  it('renders options', () => {
    render(
      <Select defaultValue="a">
        <option value="a">A</option>
        <option value="b">B</option>
      </Select>,
    );
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });
});

describe('Stepper', () => {
  it('increments and decrements by step, clamped to min', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Stepper value={2} step={2} min={0} onChange={onChange} aria-label="servings" />);
    await user.click(screen.getByRole('button', { name: /increase/i }));
    expect(onChange).toHaveBeenLastCalledWith(4);
    await user.click(screen.getByRole('button', { name: /decrease/i }));
    expect(onChange).toHaveBeenLastCalledWith(0);
  });
});

describe('Segmented', () => {
  it('marks the active option and fires onChange', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Segmented
        value="lose"
        onChange={onChange}
        options={[
          { value: 'lose', label: 'Lose' },
          { value: 'maintain', label: 'Maintain' },
        ]}
      />,
    );
    expect(screen.getByRole('tab', { name: 'Lose' })).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('tab', { name: 'Maintain' }));
    expect(onChange).toHaveBeenCalledWith('maintain');
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run src/components/ui/__tests__/form.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `Field.tsx`**

```tsx
import type { InputHTMLAttributes, SelectHTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

const CONTROL =
  'w-full rounded-md border-[1.5px] border-border bg-raised px-3 py-2.5 text-md text-text ' +
  'outline-none transition focus:border-accent focus:ring-2 focus:ring-accent-soft';

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-semibold text-text-muted">{label}</span>
      {children}
      {error ? (
        <span className="text-xs text-danger">{error}</span>
      ) : hint ? (
        <span className="text-xs text-text-faint">{hint}</span>
      ) : null}
    </label>
  );
}

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(CONTROL, className)} {...rest} />;
}

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(CONTROL, className)} {...rest} />;
}
```

- [ ] **Step 4: Implement `Stepper.tsx`**

```tsx
import { cn } from '../../lib/cn';

export function Stepper({
  value,
  onChange,
  step = 1,
  min = -Infinity,
  max = Infinity,
  suffix,
  className,
  'aria-label': ariaLabel,
}: {
  value: number;
  onChange: (n: number) => void;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
  className?: string;
  'aria-label'?: string;
}) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  return (
    <div
      className={cn(
        'inline-flex items-center gap-0.5 rounded-md border-[1.5px] border-border bg-raised',
        className,
      )}
      role="group"
      aria-label={ariaLabel}
    >
      <button
        type="button"
        aria-label="decrease"
        className="h-9 w-9 text-md text-text hover:text-accent"
        onClick={() => onChange(clamp(value - step))}
      >
        −
      </button>
      <span className="min-w-[52px] text-center text-sm font-semibold">
        {value}
        {suffix ? ` ${suffix}` : ''}
      </span>
      <button
        type="button"
        aria-label="increase"
        className="h-9 w-9 text-md text-text hover:text-accent"
        onClick={() => onChange(clamp(value + step))}
      >
        +
      </button>
    </div>
  );
}
```

- [ ] **Step 5: Implement `Segmented.tsx`**

```tsx
import { cn } from '../../lib/cn';

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
  'aria-label': ariaLabel,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  className?: string;
  'aria-label'?: string;
}) {
  return (
    <div role="tablist" aria-label={ariaLabel} className={cn('flex gap-1.5', className)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            role="tab"
            type="button"
            aria-selected={on}
            className={cn(
              'flex-1 rounded-md border-[1.5px] px-0 py-2.5 text-sm font-semibold transition',
              on
                ? 'border-accent bg-accent-soft text-accent-ink'
                : 'border-border bg-raised text-text-muted hover:border-accent-line',
            )}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 6: Extend the barrel**

Add to `frontend/src/components/ui/index.ts`:

```ts
export { Field, TextInput, Select } from './Field';
export { Stepper } from './Stepper';
export { Segmented } from './Segmented';
```

- [ ] **Step 7: Run tests, verify pass**

Run: `npx vitest run src/components/ui/__tests__/form.test.tsx`
Expected: PASS.

- [ ] **Step 8: Typecheck + full test**

Run: `npx tsc -b && npx vitest run`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/components/ui/
git commit -m "feat: ui primitives — Field, TextInput, Select, Stepper, Segmented"
```

---

### Task 6: Overlay & feedback primitives — `Sheet`, `Modal`, `Toast`, `Spinner`, `Empty`

**Files:**
- Create: `frontend/src/components/ui/Sheet.tsx`
- Create: `frontend/src/components/ui/Modal.tsx`
- Create: `frontend/src/components/ui/feedback.tsx` (`Spinner`, `Empty`, `ToastProvider`, `useToast`)
- Create: `frontend/src/components/ui/__tests__/overlay.test.tsx`
- Modify: `frontend/src/components/ui/index.ts`
- Modify: `frontend/src/components/ui/Button.tsx` (swap the inline spinner for `<Spinner tone="onAccent">`)

**Interfaces:**
- Consumes: `cn`.
- Produces:
  - `Spinner` — `{ size?: 'sm' | 'md'; tone?: 'accent' | 'onAccent' }`; `role="status"`, `aria-label="Loading"`.
  - `Empty` — `{ children: ReactNode; align?: 'center' | 'left' }`.
  - `ToastProvider` / `useToast` — **unchanged API**: `useToast()` returns `(text: string, kind?: 'ok' | 'err') => void`. Reposition/restyle only.
  - `Modal` — **unchanged API**: `{ open: boolean; onClose: () => void; title: string; children: ReactNode }`. Escape-to-close preserved.
  - `Sheet` — `{ open: boolean; onClose: () => void; title?: string; children: ReactNode }`; bottom sheet, scrim, slide via `effects.css` classes `.sheet-scrim` / `.sheet` (Task 8 owns the keyframes; here just apply the classes + `open` toggle).

- [ ] **Step 1: Write failing tests**

`frontend/src/components/ui/__tests__/overlay.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal } from '../Modal';
import { Sheet } from '../Sheet';
import { Spinner, Empty, ToastProvider, useToast } from '../feedback';

describe('Modal', () => {
  it('renders when open and closes on Escape', async () => {
    const onClose = vi.fn();
    render(
      <Modal open title="Barcode" onClose={onClose}>
        <p>body</p>
      </Modal>,
    );
    expect(screen.getByRole('dialog', { name: 'Barcode' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('renders nothing when closed', () => {
    render(
      <Modal open={false} title="X" onClose={() => {}}>
        <p>body</p>
      </Modal>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('Sheet', () => {
  it('shows the title and fires onClose from the scrim', async () => {
    const onClose = vi.fn();
    render(
      <Sheet open title="Theme" onClose={onClose}>
        <p>swatches</p>
      </Sheet>,
    );
    expect(screen.getByText('Theme')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('sheet-scrim'));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('feedback', () => {
  it('Spinner exposes a status role', () => {
    render(<Spinner />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('Empty renders its message', () => {
    render(<Empty>Nothing here</Empty>);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
  });

  it('useToast pushes a message that auto-dismisses', () => {
    vi.useFakeTimers();
    function T() {
      const toast = useToast();
      return <button onClick={() => toast('Saved')}>go</button>;
    }
    render(
      <ToastProvider>
        <T />
      </ToastProvider>,
    );
    act(() => {
      screen.getByText('go').click();
    });
    expect(screen.getByText('Saved')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3300);
    });
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run src/components/ui/__tests__/overlay.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `feedback.tsx`**

Port `Spinner`, `Empty`, `ToastProvider`, `useToast` from the current `src/components/ui.tsx` (lines 110–156) with token classes:

```tsx
import { createContext, useCallback, useContext, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export function Spinner({
  size = 'sm',
  tone = 'accent',
}: {
  size?: 'sm' | 'md';
  tone?: 'accent' | 'onAccent';
}) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn(
        'inline-block animate-spin rounded-full border-2',
        size === 'sm' ? 'h-3.5 w-3.5' : 'h-5 w-5',
        tone === 'onAccent'
          ? 'border-white/40 border-t-white'
          : 'border-border border-t-accent',
      )}
    />
  );
}

export function Empty({
  children,
  align = 'center',
}: {
  children: ReactNode;
  align?: 'center' | 'left';
}) {
  return (
    <div className={cn('py-3.5 text-sm text-text-faint', align === 'center' ? 'text-center' : 'text-left')}>
      {children}
    </div>
  );
}

interface ToastMsg {
  id: number;
  text: string;
  kind: 'ok' | 'err';
}
const ToastCtx = createContext<(text: string, kind?: 'ok' | 'err') => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastMsg[]>([]);
  const nextId = useRef(1);
  const push = useCallback((text: string, kind: 'ok' | 'err' = 'ok') => {
    const id = nextId.current++;
    setItems((t) => [...t, { id, text, kind }]);
    window.setTimeout(() => setItems((t) => t.filter((m) => m.id !== id)), 3200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div
        className="pointer-events-none fixed left-1/2 z-40 flex -translate-x-1/2 flex-col items-center gap-2"
        style={{ bottom: 'calc(104px + env(safe-area-inset-bottom))' }}
        aria-live="polite"
      >
        {items.map((m) => (
          <div
            key={m.id}
            className={cn(
              'max-w-[92vw] whitespace-nowrap rounded-full px-4 py-2 text-xs font-medium text-white shadow-sheet',
              m.kind === 'err' ? 'bg-danger' : 'bg-text',
            )}
          >
            {m.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}
```

- [ ] **Step 4: Implement `Modal.tsx`**

Port from current `ui.tsx` lines 74–108; token classes; keep `role="dialog"`, `aria-label={title}`, Escape handler, backdrop-click close:

```tsx
import { useEffect } from 'react';
import type { ReactNode } from 'react';

export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[rgba(10,37,64,.32)] px-4 pb-4 pt-[6vh]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[480px] rounded-xl border border-border bg-raised p-4 shadow-sheet"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={title}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-md font-bold">{title}</h3>
          <button
            className="rounded-md p-1 text-text-faint hover:bg-surface hover:text-text"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Implement `Sheet.tsx`**

```tsx
import { useEffect } from 'react';
import type { ReactNode } from 'react';

export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <>
      <div
        data-testid="sheet-scrim"
        className={`sheet-scrim${open ? ' open' : ''}`}
        onClick={onClose}
      />
      <div className={`sheet${open ? ' open' : ''}`} role="dialog" aria-label={title} aria-hidden={!open}>
        <div className="mx-auto mb-4 h-1 w-9 rounded-full bg-border" />
        {title && <h3 className="text-lg font-bold tracking-[-.01em]">{title}</h3>}
        {children}
      </div>
    </>
  );
}
```

(`.sheet` / `.sheet-scrim` visual + transform live in `effects.css`, Task 8.)

- [ ] **Step 6: Extend the barrel**

```ts
export { Sheet } from './Sheet';
export { Modal } from './Modal';
export { Spinner, Empty, ToastProvider, useToast } from './feedback';
```

- [ ] **Step 7: Swap `Button`'s inline spinner**

In `frontend/src/components/ui/Button.tsx`, replace the inline `<span role="status" …>` with:

```tsx
import { Spinner } from './feedback';
// …
{loading && <Spinner tone="onAccent" />}
```

Re-run `npx vitest run src/components/ui/__tests__/Button.test.tsx` — still PASS (the `role="status"` assertion holds).

- [ ] **Step 8: Run tests, verify pass**

Run: `npx vitest run src/components/ui/__tests__/`
Expected: PASS (all primitive tests).

- [ ] **Step 9: Typecheck + full test**

Run: `npx tsc -b && npx vitest run`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/components/ui/
git commit -m "feat: ui primitives — Sheet, Modal, Toast, Spinner, Empty"
```

---

### Task 7: Data-display primitives + collapse `ui.tsx` into the folder

**Files:**
- Create: `frontend/src/components/ui/StatTile.tsx` (`StatTile`, `Meter`, `ProgressBar`)
- Create: `frontend/src/components/ui/__tests__/data.test.tsx`
- Modify: `frontend/src/components/ui/index.ts`
- Replace: `frontend/src/components/ui.tsx` → thin re-export of `./ui`
- Delete: `frontend/src/components/ui.css`

**Interfaces:**
- Consumes: `cn`.
- Produces:
  - `StatTile` — `{ label: string; value: ReactNode; sub?: ReactNode; progress?: number }` (progress 0–100 renders a `<ProgressBar>` beneath).
  - `Meter` — `{ value: number; max: number; over?: boolean }` — full-width track + fill; sets `style={{ width: pct% }}`.
  - `ProgressBar` — `{ pct: number; tone?: 'accent' | 'good' }`.
- Produces: `src/components/ui.tsx` re-exports everything from `./ui` so existing `import … from '../components/ui'` keeps working unchanged.

- [ ] **Step 1: Write failing tests**

`frontend/src/components/ui/__tests__/data.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatTile, Meter, ProgressBar } from '../StatTile';

describe('StatTile', () => {
  it('renders label, value and optional sub', () => {
    render(<StatTile label="Protein" value="80g" sub="/ 150" />);
    expect(screen.getByText('Protein')).toBeInTheDocument();
    expect(screen.getByText('80g')).toBeInTheDocument();
    expect(screen.getByText('/ 150')).toBeInTheDocument();
  });

  it('progress renders a bar with clamped width', () => {
    const { container } = render(<StatTile label="Carbs" value="200g" progress={150} />);
    const fill = container.querySelector('[data-fill]') as HTMLElement;
    expect(fill.style.width).toBe('100%');
  });
});

describe('Meter', () => {
  it('computes percentage and flags over', () => {
    const { container } = render(<Meter value={120} max={100} over />);
    const fill = container.querySelector('[data-fill]') as HTMLElement;
    expect(fill.style.width).toBe('100%');
    expect(fill.className).toMatch(/warn/);
  });
});

describe('ProgressBar', () => {
  it('clamps pct to 0..100', () => {
    const { container } = render(<ProgressBar pct={-5} />);
    const fill = container.querySelector('[data-fill]') as HTMLElement;
    expect(fill.style.width).toBe('0%');
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run src/components/ui/__tests__/data.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `StatTile.tsx`**

```tsx
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

const clamp = (n: number) => Math.min(100, Math.max(0, n));

export function ProgressBar({ pct, tone = 'accent' }: { pct: number; tone?: 'accent' | 'good' }) {
  return (
    <div className="mt-2 h-[3px] overflow-hidden rounded-full bg-border">
      <div
        data-fill
        className={cn('h-full rounded-full', tone === 'good' ? 'bg-good' : 'bg-accent')}
        style={{ width: `${clamp(pct)}%` }}
      />
    </div>
  );
}

export function StatTile({
  label,
  value,
  sub,
  progress,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  progress?: number;
}) {
  return (
    <div className="min-w-0 flex-1 rounded-lg border border-border bg-surface p-3.5 transition hover:shadow-pop">
      <div className="text-2xs font-semibold uppercase tracking-[.04em] text-text-faint">{label}</div>
      <div className="mt-1 truncate text-lg font-bold tracking-[-.01em]">
        {value} {sub && <small className="text-2xs font-medium text-text-faint">{sub}</small>}
      </div>
      {progress != null && <ProgressBar pct={progress} />}
    </div>
  );
}

export function Meter({ value, max, over }: { value: number; max: number; over?: boolean }) {
  const pct = max > 0 ? clamp(Math.round((value / max) * 100)) : 0;
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-accent-soft">
      <div
        data-fill
        className={cn(
          'h-full rounded-full transition-[width] duration-500 ease-out',
          over ? 'bg-warn' : 'bg-accent',
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
```

- [ ] **Step 4: Extend the barrel**

```ts
export { StatTile, Meter, ProgressBar } from './StatTile';
```

- [ ] **Step 5: Replace `ui.tsx` with a re-export**

Overwrite `frontend/src/components/ui.tsx` entirely:

```tsx
/* Compatibility shim: the primitive layer now lives in ./ui/.
   Existing `import { X } from '../components/ui'` paths keep working. */
export * from './ui';
```

- [ ] **Step 6: Delete the dead stylesheet**

```bash
git rm frontend/src/components/ui.css
```

Confirm nothing imports it:

```bash
grep -rn "ui.css" frontend/src
```

Expected: no matches.

- [ ] **Step 7: Run tests, verify pass**

Run: `npx vitest run`
Expected: PASS — including `onboarding.test.tsx` (it imports `useToast` from `../components/ui`, still resolved via the shim).

- [ ] **Step 8: Typecheck + build**

Run: `npx tsc -b && npm run build`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/components/
git commit -m "feat: ui primitives — StatTile, Meter, ProgressBar; collapse ui.tsx into ui/"
```

---

### Task 8: `effects.css` + AppShell / tab bar migration

**Files:**
- Modify: `frontend/src/styles/effects.css` (currently empty)
- Modify: `frontend/src/components/AppShell.tsx`
- Delete: `frontend/src/components/shell.css`

**Interfaces:**
- Consumes: token vars from `theme.css`.
- Produces: `effects.css` classes used by components — `.hero`, `.meter-fill` (if kept as CSS; the `Meter` primitive uses utilities so this is only the hero's decorative gradient), `.view-wrap` (route transition), `.tabbar` + `.tabbar--hidden`, `.sheet` + `.sheet-scrim` (+ `.open`), `.no-scrollbar`, `@keyframes` for toast/sheet/view.
- Produces: `AppShell` rendering the same structure (`.shell`, `.view-wrap`, `.tabbar`, `.nv` items) with `effects.css` classes for the bespoke bits and utilities for the rest.

- [ ] **Step 1: Read the current shell**

Read `frontend/src/components/AppShell.tsx` and `frontend/src/components/shell.css` in full. Note: `.shell.no-tabs` hides the tab bar on Onboarding/AddFood/Auth; the `.view-wrap` keyframe slide; the tab bar's translucency + `backdrop-filter`; `.queue-pill`; `.shell-foot`.

- [ ] **Step 2: Write `effects.css`**

`frontend/src/styles/effects.css`:

```css
/* ─────────────────────────────────────────────────────────────
   Bespoke visuals that don't reduce to utilities. Token-driven.
   ───────────────────────────────────────────────────────────── */

@layer components {
  /* Hero — brandline gradient wash + decorative rotated blob */
  .hero {
    position: relative;
    overflow: hidden;
    background: linear-gradient(150deg, var(--color-accent-soft) 0%, var(--color-surface) 45%, var(--color-bg) 100%);
  }
  .hero::after {
    content: '';
    position: absolute;
    top: -40px;
    right: -70px;
    width: 240px;
    height: 340px;
    background: linear-gradient(
      135deg,
      var(--color-accent) 0%,
      color-mix(in srgb, var(--color-accent) 55%, #fff) 60%,
      transparent 130%
    );
    transform: rotate(18deg);
    border-radius: 32px;
    opacity: 0.16;
    pointer-events: none;
  }

  /* Route change: directional slide + fade */
  .view-wrap {
    animation: view-in 0.32s var(--ease-out);
  }
  @keyframes view-in {
    from {
      opacity: 0;
      transform: translateX(30px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  /* Fixed bottom tab bar with translucency */
  .tabbar {
    position: fixed;
    left: 50%;
    bottom: 0;
    width: 100%;
    max-width: 640px;
    transform: translateX(-50%);
    z-index: var(--z-tabbar, 15);
    background: color-mix(in srgb, var(--color-bg) 94%, transparent);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    border-top: 1px solid var(--color-border);
    transition:
      transform 0.32s var(--ease-out),
      opacity 0.25s ease;
  }
  .tabbar--hidden {
    transform: translateX(-50%) translateY(110%);
    opacity: 0;
    pointer-events: none;
  }

  /* Bottom sheet (Sheet primitive) */
  .sheet-scrim {
    position: fixed;
    inset: 0;
    z-index: 28;
    background: rgba(10, 37, 64, 0.32);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.25s ease;
  }
  .sheet-scrim.open {
    opacity: 1;
    pointer-events: auto;
  }
  .sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 30;
    max-width: 640px;
    margin: 0 auto;
    padding: 20px 24px 26px;
    background: var(--color-raised);
    border-radius: 22px 22px 0 0;
    box-shadow: var(--shadow-sheet);
    transform: translateY(105%);
    transition: transform 0.3s var(--ease-out);
  }
  .sheet.open {
    transform: translateY(0);
  }

  .no-scrollbar {
    scrollbar-width: none;
  }
  .no-scrollbar::-webkit-scrollbar {
    display: none;
  }
}
```

Add `--z-tabbar` etc. to `theme.css`'s `@theme` block now if not already present:

```css
  --z-tabbar: 15;
  --z-sheet-scrim: 28;
  --z-sheet: 30;
  --z-toast: 40;
  --z-modal: 50;
```

- [ ] **Step 3: Migrate `AppShell.tsx`**

Convert per the Shared Reference. Structure stays identical. Example — the wrapper and tab bar:

```tsx
// was: <div className={`shell${hideTabs ? ' no-tabs' : ''}`}>
<div className="mx-auto flex min-h-[100dvh] max-w-[640px] flex-col bg-bg">
  <div className="view-wrap flex-1 [&>*]:min-h-full">{children}</div>
  <nav className={cn('flex px-3 pb-[calc(20px+env(safe-area-inset-bottom))] pt-2', 'tabbar', hideTabs && 'tabbar--hidden')}>
    {/* .nv items → utilities: flex-1 flex flex-col items-center gap-[3px] text-2xs font-semibold text-text-faint; active → text-accent */}
  </nav>
</div>
```

`.queue-pill` → `rounded-full border border-[#fde68a] bg-[#fef3c7] px-2.5 py-0.5 text-xs font-semibold text-[#92400e]` (keep the amber literal — it is a fixed status colour, not themed). `.shell-foot` → `truncate px-0 pb-[88px] text-center text-2xs text-text-faint`.

- [ ] **Step 4: Delete `shell.css`**

```bash
git rm frontend/src/components/shell.css
grep -rn "shell.css" frontend/src   # expect no matches
```

- [ ] **Step 5: Typecheck + test + build**

Run: `npx tsc -b && npx vitest run && npm run build`
Expected: PASS.

- [ ] **Step 6: Visual check**

`npm run dev`. Sign in (or use the existing dev flow). Verify: tab bar blurs content behind it, hides on `/add`, slide-in on route change, footer text present. Toggle `data-theme` — shell + tab bar recolour.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/styles/effects.css frontend/src/styles/theme.css frontend/src/components/AppShell.tsx
git commit -m "feat: effects.css + migrate AppShell/tabbar to tokens"
```

---

### Task 9: Migrate `Today` + `MealGroup`

**Files:**
- Modify: `frontend/src/screens/Today.tsx`
- Modify: `frontend/src/components/MealGroup.tsx`
- Delete: `frontend/src/screens/today.css`, `frontend/src/components/meals.css`

**Interfaces:**
- Consumes: `Button`, `Card`, `CardTitle`, `StatTile`, `Meter`, `ProgressBar`, `Empty`, `Spinner`, `TextInput` from `../components/ui`.
- Produces: no new exports.

- [ ] **Step 1: Read** `Today.tsx`, `today.css`, `MealGroup.tsx`, `meals.css` in full.

- [ ] **Step 2: Migrate `Today.tsx`** following the Shared Reference procedure. Concrete conversions:

Hero balance block:

```tsx
// was: <div className="balance"> … <div className="l"><div className="cap">…</div><div className="v">…</div></div> …
<Card as="section" className="relative z-10 mt-5 flex items-center justify-between">
  <div>
    <div className="text-2xs font-semibold uppercase tracking-[.05em] text-text-faint">Calories today</div>
    <div className="mt-0.5 text-2xl font-bold tracking-[-.02em]">
      {formatInt(eaten)} <small className="text-base font-medium text-text-muted">/ {budget != null ? formatInt(budget) : '—'}</small>
    </div>
  </div>
  {budget != null && (
    <div className={cn(
      'rounded-full px-3 py-1.5 text-right text-sm font-semibold',
      over ? 'bg-warn-soft text-warn' : 'bg-good/12 text-good-ink',
    )}>
      {over ? `${formatInt(-remaining!)} over` : `${formatInt(remaining!)} left`}
      <small className="mt-0.5 block text-2xs font-medium text-text-faint">{pct}% of budget{over ? ' — over' : ''}</small>
    </div>
  )}
</Card>
```

Meter block → `<Meter value={eaten} max={budget ?? 0} over={over} />` inside a `px-6` wrapper, with the caption row as utilities.

Macro tiles:

```tsx
<div className="flex gap-2.5">
  {([['Protein', summary.totals.protein], ['Carbs', summary.totals.carbs], ['Fat', summary.totals.fat]] as const).map(
    ([label, val]) => (
      <StatTile key={label} label={label} value={`${formatInt(val)}g`} sub="/ 150" progress={(val / 150) * 100} />
    ),
  )}
</div>
```

Error card → `<Card role="alert"><p>{err}</p><Button variant="outline" className="mt-2.5" onClick={() => void load()}>Retry</Button></Card>`.
Loading → `<div className="flex items-center gap-2 px-6 py-5 text-sm text-text-muted"><Spinner /> Loading your day…</div>`.
Empty meals → `<Empty align="left">No meal slots yet — add your first below.</Empty>`.
`.add-slot` input → `<TextInput>` + `<Button variant="outline" size="sm" loading={addingSlot} disabled={!newSlot.trim()}>Add slot</Button>`.
Hydration / Steps cards → `<Card>` + `<CardTitle>` + `<ProgressBar pct={…} tone="good" />` + `<Button variant="outline" size="sm">`.
Section wrappers `.sec` → `className="px-6 pt-5"`; `.sec-h` → `className="mb-3 flex items-baseline justify-between"`; `.sec-h .a` → `<button className="text-sm font-semibold text-accent hover:underline">`.
`.hero` keeps its `className="hero"` plus `px-6 pb-6 pt-5 border-b border-border` (the gradient/`::after` come from `effects.css`).

- [ ] **Step 3: Migrate `MealGroup.tsx`** — convert `.mealgrp`, `.gh`, `.meals`, `.mrow`, `.ic`, `.addmeal` per the mapping. The meal rows become a `<Card padding="none">` with `divide-y divide-border`; each row `flex items-center gap-3 p-3.5`; the icon chip `flex h-9 w-9 items-center justify-center rounded-md border border-accent-line bg-accent-soft [&_svg]:h-[18px] [&_svg]:w-[18px] [&_svg]:stroke-accent-ink`. `.addmeal` (dashed add button) → keep as a small local element: `className="mt-3 w-full rounded-lg border-[1.5px] border-dashed border-accent-line py-2.5 text-center text-sm font-semibold text-accent hover:bg-accent-soft"`.

- [ ] **Step 4: Delete the stylesheets**

```bash
git rm frontend/src/screens/today.css frontend/src/components/meals.css
grep -rn "today.css\|meals.css" frontend/src   # expect no matches
```

Remove the `import './today.css'` / `import './meals.css'` lines.

- [ ] **Step 5: Typecheck + test + build**

Run: `npx tsc -b && npx vitest run && npm run build`
Expected: PASS.

- [ ] **Step 6: Visual check (both themes)** — `npm run dev`, open `/today`. Hero gradient, balance card, meter fill animation, macro tiles with mini bars, meal groups collapse, hydration/steps bars. Toggle `data-theme=dark`: text legible, cards use `--color-raised`, accent-soft is a dark tint not a white wash.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/screens/Today.tsx frontend/src/components/MealGroup.tsx
git commit -m "refactor: migrate Today + MealGroup to tokens/primitives"
```

---

### Task 10: Migrate `AddFood` + `ScanSheet`

**Files:**
- Modify: `frontend/src/screens/AddFood.tsx`
- Modify: `frontend/src/components/ScanSheet.tsx`
- Delete: `frontend/src/screens/addfood.css`, `frontend/src/components/scansheet.css`

**Interfaces:**
- Consumes: `Button`, `Card`, `Field`, `TextInput`, `Select`, `Stepper`, `Segmented`, `Spinner`, `Empty`, `Modal` from `../components/ui`.

- [ ] **Step 1: Read** `AddFood.tsx`, `addfood.css`, `ScanSheet.tsx`, `scansheet.css` in full.
- [ ] **Step 2: Migrate `AddFood.tsx`** per the Shared Reference. Key pieces: `.subhead` → `flex items-center justify-between px-6 pb-3 pt-4`; `.backbtn` → `<button className="flex h-9 w-9 items-center justify-center rounded-md border border-border bg-raised text-text">`; `.searchwrap`/`.search`/`.scanbtn` → `<TextInput>` in a `relative` wrapper + an absolutely-positioned scan `<button>`; `.nutri`/`.ncell`/`.ncell.big` → a flex row of small tiles (`ncell.big` → `bg-accent-soft border-accent-line text-accent-ink`); `.steprow`/`.stepper` → `<Stepper>`; `.mealpills`/`.mp` → horizontal `flex gap-2 overflow-x-auto no-scrollbar` of pill `<button>`s (`.mp.on` → `bg-accent border-accent text-white`); quick-add block buttons → `<Button>`. The "New slot" inline control → `<Button variant="outline" size="sm">`.
- [ ] **Step 3: Migrate `ScanSheet.tsx`** — wrap its body in `<Modal>` (it already renders a modal-ish overlay) or `<Sheet>` if it slides from the bottom; match current behaviour. Buttons → `<Button variant="outline">Cancel</Button>` / `<Button>Look up</Button>`.
- [ ] **Step 4: Delete stylesheets**

```bash
git rm frontend/src/screens/addfood.css frontend/src/components/scansheet.css
grep -rn "addfood.css\|scansheet.css" frontend/src   # expect no matches
```

Remove the import lines.

- [ ] **Step 5: Typecheck + test + build**

Run: `npx tsc -b && npx vitest run && npm run build`
Expected: PASS.

- [ ] **Step 6: Visual check (both themes)** — food search, results list, food-detail nutri tiles, serving stepper, meal pills, quick-add, barcode sheet.
- [ ] **Step 7: Commit**

```bash
git add frontend/src/screens/AddFood.tsx frontend/src/components/ScanSheet.tsx
git commit -m "refactor: migrate AddFood + ScanSheet to tokens/primitives"
```

---

### Task 11: Migrate `ProfileGoals` + add the Light/System/Dark control

**Files:**
- Modify: `frontend/src/screens/ProfileGoals.tsx`
- Delete: `frontend/src/screens/profile.css`

**Interfaces:**
- Consumes: `Button`, `Card`, `Field`, `TextInput`, `Select`, `Segmented`, `Sheet` from `../components/ui`; `useApp` for `mode` / `setMode`.

- [ ] **Step 1: Read** `ProfileGoals.tsx` and `profile.css` in full.
- [ ] **Step 2: Migrate the screen** per the Shared Reference. `.avatar` → `flex h-13 w-13 items-center justify-center rounded-full bg-accent text-lg font-bold text-white` (13 = `h-[52px]`); `.strow` → `flex items-center gap-2.5 border-b border-border py-3.5 text-base last:border-0`; `.goalseg` → `<Segmented>`; `.goalout` → `mt-2.5 text-sm font-medium text-text-muted`; the theme `.sheet` → `<Sheet>`; `.swatches`/`.sw` → grid of swatch `<button>`s (keep `.sw.on` → `border-text`); `.custom-row` color input row → utilities. Import link → `<Button variant="outline" block>` wrapping `<Link>` (or `<Link className={…}>` with the Button classes — keep it a real anchor).
- [ ] **Step 3: Add the theme-mode control** inside the theme `<Sheet>`, above the accent swatches:

```tsx
const { mode, setMode } = useApp();
// …
<div className="mt-4">
  <span className="text-xs font-semibold text-text-muted">Appearance</span>
  <Segmented
    className="mt-2"
    aria-label="Appearance"
    value={mode}
    onChange={setMode}
    options={[
      { value: 'light', label: 'Light' },
      { value: 'system', label: 'System' },
      { value: 'dark', label: 'Dark' },
    ]}
  />
</div>
```

- [ ] **Step 4: Delete `profile.css`**

```bash
git rm frontend/src/screens/profile.css
grep -rn "profile.css" frontend/src   # expect no matches
```

Remove the import line.

- [ ] **Step 5: Typecheck + test + build**

Run: `npx tsc -b && npx vitest run && npm run build`
Expected: PASS.

- [ ] **Step 6: Visual check (both themes)** — profile stats rows, goal segmented control + computed output, theme sheet opens, **the new Light/System/Dark control switches the whole app live and survives reload**, accent swatches still work.
- [ ] **Step 7: Commit**

```bash
git add frontend/src/screens/ProfileGoals.tsx
git commit -m "refactor: migrate ProfileGoals to tokens/primitives; add appearance control"
```

---

### Task 12: Migrate `History`

**Files:**
- Modify: `frontend/src/screens/History.tsx`
- Delete: `frontend/src/screens/history.css`

**Interfaces:**
- Consumes: `Card`, `Empty`, `Spinner`, `Select` from `../components/ui`.

- [ ] **Step 1: Read** `History.tsx` and `history.css` in full.
- [ ] **Step 2: Migrate** per the Shared Reference. `.monthsel` → `<Select>` styled as a pill (`rounded-full`); `.weekstrip` → `flex gap-1.5 px-6 pb-3`; `.dpill` → day `<button>` (`flex-1 rounded-lg border border-border bg-raised …`; `.dpill.on` → `border-accent bg-accent-soft`; the `.ad` activity dot → `h-[5px] w-[5px] rounded-full` with `bg-good` / `bg-border` / `bg-warn`); `.daycard`/`.daygrid` → `<Card>` with a flex grid, dividers `[&>div+div]:border-l [&>div+div]:border-border [&>div+div]:pl-3.5`; `.v2.good` → `text-good-ink`, `.v2.bad` → `text-warn`. Missing-data state → `<Empty>`.
- [ ] **Step 3: Delete `history.css`**

```bash
git rm frontend/src/screens/history.css
grep -rn "history.css" frontend/src   # expect no matches
```

Remove the import line.

- [ ] **Step 4: Typecheck + test + build**

Run: `npx tsc -b && npx vitest run && npm run build`
Expected: PASS.

- [ ] **Step 5: Visual check (both themes)** — week strip, day selection, day detail grid, over/under colours.
- [ ] **Step 6: Commit**

```bash
git add frontend/src/screens/History.tsx
git commit -m "refactor: migrate History to tokens/primitives"
```

---

### Task 13: Migrate `Onboarding`

**Files:**
- Modify: `frontend/src/screens/Onboarding.tsx`
- Delete: `frontend/src/screens/onboarding.css`
- Possibly modify: `frontend/src/__tests__/onboarding.test.tsx`

**Interfaces:**
- Consumes: `Button`, `Field`, `TextInput`, `Spinner` from `../components/ui`.

- [ ] **Step 1: Read** `Onboarding.tsx`, `onboarding.css`, and `src/__tests__/onboarding.test.tsx` in full.
- [ ] **Step 2: Migrate** per the Shared Reference. **Keep `className="wordmark"`** on the wordmark element — the test selects `getByText(/SAOLRIAN/i, { selector: '.wordmark' })`. Add `wordmark` alongside utilities: `<span className="wordmark text-2xs font-bold uppercase tracking-[.06em] text-text-faint">`. Choice buttons → `<Button>` / `<Button variant="outline">`. The self-hosted URL form → `<Field>` + `<TextInput>`; keep it inside a `<form>` (the test does `fireEvent.submit(...closest('form'))`). Connecting / failure states → text + `<Spinner>` + `<Button>` for "Change endpoint".
- [ ] **Step 3: Delete `onboarding.css`**

```bash
git rm frontend/src/screens/onboarding.css
grep -rn "onboarding.css" frontend/src   # expect no matches
```

Remove the import line.

- [ ] **Step 4: Run the onboarding test specifically**

Run: `npx vitest run src/__tests__/onboarding.test.tsx`
Expected: PASS (5 tests). If a query broke purely on structure (not `.wordmark`), fix the JSX to restore the queried role/text rather than loosening the test.

- [ ] **Step 5: Typecheck + full test + build**

Run: `npx tsc -b && npx vitest run && npm run build`
Expected: PASS.

- [ ] **Step 6: Visual check (both themes)** — first-run choice screen, self-hosted URL entry + validation message, hosted connecting→failure.
- [ ] **Step 7: Commit**

```bash
git add frontend/src/screens/Onboarding.tsx frontend/src/__tests__/onboarding.test.tsx
git commit -m "refactor: migrate Onboarding to tokens/primitives"
```

---

### Task 14: Migrate `Welcome`

**Files:**
- Modify: `frontend/src/screens/Welcome.tsx`
- Delete: `frontend/src/screens/welcome.css`

**Interfaces:**
- Consumes: `Button`, `Field`, `TextInput`, `Select`, `Segmented` from `../components/ui`.

- [ ] **Step 1: Read** `Welcome.tsx` and `welcome.css` in full.
- [ ] **Step 2: Migrate** per the Shared Reference — the multi-step wizard: step container, progress indicator, name/body/goal steps' inputs → `<Field>` + `<TextInput>`/`<Select>`; any goal choice → `<Segmented>`; Back/Next/Finish → `<Button variant="outline">` / `<Button>` with `loading={saving}` on Finish.
- [ ] **Step 3: Delete `welcome.css`**

```bash
git rm frontend/src/screens/welcome.css
grep -rn "welcome.css" frontend/src   # expect no matches
```

Remove the import line.

- [ ] **Step 4: Typecheck + test + build**

Run: `npx tsc -b && npx vitest run && npm run build`
Expected: PASS.

- [ ] **Step 5: Visual check (both themes)** — each wizard step, disabled Next until valid, Finish spinner.
- [ ] **Step 6: Commit**

```bash
git add frontend/src/screens/Welcome.tsx
git commit -m "refactor: migrate Welcome wizard to tokens/primitives"
```

---

### Task 15: Migrate `Auth`

**Files:**
- Modify: `frontend/src/screens/Auth.tsx`
- Delete: `frontend/src/screens/auth.css`

**Interfaces:**
- Consumes: `Button`, `Field`, `TextInput` from `../components/ui`.

- [ ] **Step 1: Read** `Auth.tsx` and `auth.css` in full.
- [ ] **Step 2: Migrate** per the Shared Reference — email/password `<Field>` + `<TextInput type="email|password">`; submit → `<Button type="submit" loading={busy} block>`; the sign-in/sign-up toggle → `<Button variant="ghost">`; keep the `<form>` element and its `onSubmit`.
- [ ] **Step 3: Delete `auth.css`**

```bash
git rm frontend/src/screens/auth.css
grep -rn "auth.css" frontend/src   # expect no matches
```

Remove the import line.

- [ ] **Step 4: Typecheck + test + build**

Run: `npx tsc -b && npx vitest run && npm run build`
Expected: PASS.

- [ ] **Step 5: Visual check (both themes)** — sign-in form, validation/error text, toggle to sign-up.
- [ ] **Step 6: Commit**

```bash
git add frontend/src/screens/Auth.tsx
git commit -m "refactor: migrate Auth to tokens/primitives"
```

---

### Task 16: Migrate `EditEntry` + `Import`

**Files:**
- Modify: `frontend/src/screens/EditEntry.tsx`
- Modify: `frontend/src/screens/Import.tsx`
- Delete: `frontend/src/screens/edit-entry.css`, `frontend/src/screens/import.css`

**Interfaces:**
- Consumes: `Button`, `Card`, `Field`, `TextInput`, `Select`, `Stepper`, `Empty` from `../components/ui`.

- [ ] **Step 1: Read** all four files in full.
- [ ] **Step 2: Migrate `EditEntry.tsx`** — the entry edit form: `<Field>` + `<TextInput>` for name/kcal/macros, `<Stepper>` for servings/quantity, `<Select>` for meal slot; Save → `<Button loading={saving}>` (drop the `style={{ marginTop: 16 }}` → `className="mt-4"`); a Delete → `<Button variant="danger">`.
- [ ] **Step 3: Migrate `Import.tsx`** — the LoseIt import screen: file input, parsed-rows preview table/list, Import → `<Button loading={importing} disabled={rows.length === 0}>`, Export → `<Button variant="outline" loading={exporting}>`, back link → `<Button variant="ghost" block>` wrapping `<Link>`. Empty parse state → `<Empty>`. The rows preview → `<Card padding="none">` with `divide-y divide-border`.
- [ ] **Step 4: Delete stylesheets**

```bash
git rm frontend/src/screens/edit-entry.css frontend/src/screens/import.css
grep -rn "edit-entry.css\|import.css" frontend/src   # expect no matches
```

Remove the import lines.

- [ ] **Step 5: Typecheck + test + build**

Run: `npx tsc -b && npx vitest run && npm run build`
Expected: PASS.

- [ ] **Step 6: Visual check (both themes)** — edit an entry end to end; open Import, load a sample CSV, preview rows, run export.
- [ ] **Step 7: Commit**

```bash
git add frontend/src/screens/EditEntry.tsx frontend/src/screens/Import.tsx
git commit -m "refactor: migrate EditEntry + Import to tokens/primitives"
```

---

### Task 17: Teardown, full verification, baselines

**Files:**
- Delete: `frontend/src/styles/app.css`
- Delete: `frontend/src/styles/tokens.css`
- Modify: `frontend/src/styles/theme.css` (remove the legacy-alias `:root` block)
- Modify: `frontend/src/main.tsx` (drop the two dead imports)
- Modify: `frontend/src/styles/tokens.css` base rules → fold into `index.css` (see Step 2)
- Create: `docs/_shots/refine/` (new screenshots)

- [ ] **Step 1: Confirm nothing references the legacy sheets**

```bash
grep -rn "app.css\|tokens.css" frontend/src
```

Expected: only `main.tsx` (the imports about to be removed) and no CSS `--ink`/`--line`/`--faint`/`--muted`/`--good-ink`/`--bg` usages left in `frontend/src` outside `theme.css`:

```bash
grep -rn "var(--ink)\|var(--line)\|var(--faint)\|var(--muted)\|var(--bg)\|var(--good-ink)\|var(--surface)\|var(--danger)" frontend/src --include=*.tsx --include=*.css | grep -v styles/theme.css
```

Expected: no matches. If any remain, fix that screen before continuing.

- [ ] **Step 2: Move the base element rules out of `tokens.css`**

`tokens.css` still holds base rules (`*{box-sizing}`, `html,body{margin:0}`, `body{font-family…}`, `button{…}`, `input,select{…}`, `a{…}`, `#root{min-height:100dvh}`). Move those into `frontend/src/styles/index.css` (after the `@import`s), updating colours to tokens:

```css
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--color-bg);
  color: var(--color-text);
  font-family: 'Inter Tight', 'Inter', system-ui, sans-serif;
  font-size: 15px;
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
}
#root { min-height: 100dvh; }
button { font-family: inherit; cursor: pointer; }
input, select { font-family: inherit; color: var(--color-text); }
a { color: var(--color-accent-ink); }
input:focus-visible, select:focus-visible, button:focus-visible {
  outline: 2px solid var(--accent-glow);
  outline-offset: 1px;
}
```

- [ ] **Step 3: Delete the legacy sheets + alias block**

```bash
git rm frontend/src/styles/app.css frontend/src/styles/tokens.css
```

In `theme.css`, delete the `/* Legacy aliases */` `:root { --bg: …; … }` block.
In `main.tsx`, remove `import './styles/tokens.css';` and `import './styles/app.css';` (keep `import './styles/index.css';`).

- [ ] **Step 4: Typecheck + test + build**

Run: `npx tsc -b && npx vitest run && npm run build`
Expected: PASS. Record the built CSS size:

```bash
ls -l dist/assets/*.css
```

Note it in the commit body (before/after if you captured the pre-migration size).

- [ ] **Step 5: Full manual sweep**

`npm run dev`. At **375px** and **414px** widths, in **light and dark**, walk every screen:

- Onboarding → Auth → Welcome wizard → Today → AddFood (search + scan sheet) → History → ProfileGoals (theme sheet, appearance toggle, accent swatch) → EditEntry → Import.
- Check: route slide transition, toast on a save, bottom sheets slide + scrim, barcode `Modal` + Escape, `Stepper` +/−, `:focus-visible` rings on inputs/buttons, tab bar hides on Onboarding/AddFood/Auth, offline queue pill (throttle network) still styled.
- Dark: no white flashes, `accent-soft` reads as a dark tint, hairlines visible, shadows subtle.

Fix any regression found, re-running `tsc -b` + `vitest run` after each fix.

- [ ] **Step 6: Refresh screenshot baselines**

Capture the nine screens (light + dark) into `docs/_shots/refine/` — e.g. `refine/today-light.png`, `refine/today-dark.png`, etc. (Manual capture via the browser; no committed harness exists.)

- [ ] **Step 7: Commit**

```bash
git add frontend/src/styles/ frontend/src/main.tsx docs/_shots/refine/
git commit -m "refactor: remove legacy app.css/tokens.css; token system is now the only stylesheet"
```

- [ ] **Step 8: Update the spec status**

Edit `docs/superpowers/specs/2026-09-03-ui-foundation-tailwind-design.md` header: `Status: Implemented (<date>)`. Commit:

```bash
git add docs/superpowers/specs/2026-09-03-ui-foundation-tailwind-design.md
git commit -m "docs: mark UI foundation spec implemented"
```

---

## Self-Review

**1. Spec coverage**

| Spec section | Task(s) |
|---|---|
| §1 Tooling & build (Tailwind v4, `@tailwindcss/vite`, cva, cn, `index.css`, `main.tsx`) | Task 1 |
| §1 `prettier-plugin-tailwindcss` | **Deviation** — dropped. The project has no prettier setup; standing one up is out of proportion to this pass and not load-bearing. Noted here; revisit separately if desired. |
| §2 Radius / type / shadow / z / motion scales | Task 2 (z-index finalised in Task 8 Step 2) |
| §2 Semantic colors, light + dark, `@custom-variant dark`, `prefers-color-scheme` fallback | Task 2 |
| §2 Runtime accent preserved via `--accent` + `color-mix` tints | Task 2 (Steps 1, 4) |
| §2 Legacy var names kept working during migration | Task 2 (legacy alias block) → removed Task 17 |
| §3 `Button` | Task 4 |
| §3 `Card`, `CardTitle` | Task 4 |
| §3 `Field`, `TextInput`, `Select`, `Stepper`, `Segmented` | Task 5 |
| §3 `Sheet`, `Modal`, `Toast`, `Spinner`, `Empty` | Task 6 |
| §3 `StatTile`, `Meter`, `ProgressBar` | Task 7 |
| §3 `ui.tsx` → `ui/` folder, dead code removed | Task 7 (Step 5) |
| §3 `effects.css` (hero, meter fill, view transition, tabbar blur, hidden scrollbar, keyframes) | Task 8 |
| §4 Migration order 1–9 | Tasks 8–16 (1→8, 2→9, 3→10, 4→11, 5→12, 6→13, 7→14, 8→15, 9→16) |
| §4 Delete each screen `.css`; delete `app.css`/`ui.css`; absorb `tokens.css` | Per-task deletes; Task 17 |
| §4 Refinement per screen (padding, radii, type, states) | Shared Reference procedure step 4; each screen task |
| §5 `data-theme` on `<html>`, `mode` in AppContext, `saolrian-theme-mode`, default system, live `matchMedia` | Task 3 |
| §5 Light/System/Dark control in the theme sheet | Task 11 (Step 3) |
| §5 `<meta name="theme-color">` follows resolved theme | Task 3 (Step 4) |
| §5 Each screen verified both themes during its step | Each screen task, "Visual check (both themes)" |
| §6 `tsc -b`, `vitest run`, `npm run build` | Every task's verify steps; Task 17 Step 4 |
| §6 `onboarding.test.tsx` class-assertion check | Global Constraints + Task 13 (`.wordmark`) |
| §6 CSS bundle size delta | Task 17 (Step 4) |
| §6 Screenshot pass light+dark, `docs/_shots/refine/` | Task 17 (Steps 5–6) |
| §6 Manual sweep at narrow widths | Task 17 (Step 5) |

No spec requirement is left without a task (the one deliberate deviation is called out above).

**2. Placeholder scan** — No "TBD"/"handle edge cases"/"similar to Task N". Screen tasks (9–16) give a concrete conversion for the non-obvious blocks plus the Shared Reference mapping for the mechanical remainder; that is a shown transformation repeated, not an unspecified one. Code steps carry real code.

**3. Type consistency** — `cn(...inputs: ClassValue[]) => string` used consistently. `useToast()` signature unchanged from the current `ui.tsx` (`(text, kind?) => void`). `Modal` prop shape unchanged. `Segmented<T>` generic signature matches its Task 5 definition and its Task 11 use (`value={mode}` where `mode: 'light'|'dark'|'system'`, `onChange={setMode}`). `Meter` props (`value`, `max`, `over`) match Task 7 definition and Task 9 use. `data-fill` attribute is the shared hook the Task 7 tests query and the Task 7 implementation sets. `ThemeMode` type defined in `storage.ts` (Task 3 Step 3), imported by `AppContext` (Task 3 Step 4).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-03-ui-foundation-tailwind.md`.

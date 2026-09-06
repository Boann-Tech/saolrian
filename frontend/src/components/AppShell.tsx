import type { ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useApp } from '../state/AppContext';
import { queueDepth } from '../lib/offline';
import { cn } from '../lib/cn';

/** Bottom tab bar + content frame for signed-in screens.
 *  Visual system ported from the approved prototype: fixed glass tabbar
 *  (blur, hairline top border, SVG glyphs + labels), with the prototype's
 *  .no-tabs behavior — it slides away on AddFood / Import screens. */

const TABS = [
  {
    to: '/today',
    label: 'Today',
    glyph: (
      <svg viewBox="0 0 24 24" aria-hidden>
        <rect x="3" y="3" width="8" height="8" rx="2" />
        <rect x="13" y="3" width="8" height="8" rx="2" />
        <rect x="3" y="13" width="8" height="8" rx="2" />
        <rect x="13" y="13" width="8" height="8" rx="2" />
      </svg>
    ),
  },
  {
    to: '/add',
    label: 'Add',
    glyph: (
      <svg viewBox="0 0 24 24" aria-hidden>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v8M8 12h8" />
      </svg>
    ),
  },
  {
    to: '/history',
    label: 'History',
    glyph: (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d="M4 19h16M6 19V11M10 19V7M14 19v-8M18 19V9" />
      </svg>
    ),
  },
  {
    to: '/trends',
    label: 'Trends',
    glyph: (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d="M4 18l5-6 4 3 6-8" />
        <path d="M15 7h4v4" />
      </svg>
    ),
  },
  {
    to: '/profile',
    label: 'Profile',
    glyph: (
      <svg viewBox="0 0 24 24" aria-hidden>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21c1.5-4 5-6 8-6s6.5 2 8 6" />
      </svg>
    ),
  },
];

/** SVG glyph sizing/stroke — glyphs inherit `stroke: currentColor`, so the
 *  nav item's text colour (faint, or accent when active) drives the icon. */
const NV_GLYPH =
  '[&_svg]:size-[22px] [&_svg]:fill-none [&_svg]:stroke-current [&_svg]:[stroke-width:1.9] [&_svg]:[stroke-linecap:round] [&_svg]:[stroke-linejoin:round]';

export function AppShell({ children }: { children: ReactNode }) {
  const { clearEndpoint, pb } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const pending = queueDepth();
  const noTabs = location.pathname.startsWith('/add') || location.pathname.startsWith('/profile/import');

  const signOut = () => {
    pb?.authStore.clear();
    clearEndpoint();
    navigate('/onboarding', { replace: true });
  };

  return (
    <div className="mx-auto flex min-h-[100dvh] max-w-[640px] flex-col bg-bg">
      {/* fade+slide wrapper keyed on route — prototype view transitions */}
      <main
        className={cn(
          'view-wrap flex-1 [&>*]:min-h-full',
          // Reserve space matching the fixed tabbar so screen content
          // (e.g. a final Save button) can't scroll underneath it.
          !noTabs && '[&>*]:!pb-[calc(var(--tabbar-h)+env(safe-area-inset-bottom))]',
        )}
        key={location.pathname}
      >
        {children}
      </main>
      <nav
        className={cn(
          'flex px-3 pb-[calc(20px+env(safe-area-inset-bottom))] pt-2',
          'tabbar',
          noTabs && 'tabbar--hidden',
        )}
        aria-label="Main navigation"
      >
        {pending > 0 && (
          <span
            className="absolute -top-[34px] right-2.5 rounded-full border border-warn/30 bg-warn-soft px-2.5 py-0.5 text-xs font-semibold text-warn"
            title={`${pending} entr${pending === 1 ? 'y' : 'ies'} waiting to sync`}
          >
            ⇣{pending} offline
          </span>
        )}
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            className={({ isActive }) =>
              cn(
                'flex flex-1 flex-col items-center gap-[3px] text-2xs font-semibold no-underline',
                NV_GLYPH,
                isActive ? 'text-accent' : 'text-text-faint',
              )
            }
          >
            {t.glyph}
            <span>{t.label}</span>
          </NavLink>
        ))}
        <button
          className={cn(
            'flex flex-[0.55] flex-col items-center gap-[3px] border-none bg-transparent text-2xs font-semibold text-text-faint',
            NV_GLYPH,
          )}
          onClick={signOut}
          title="Sign out"
        >
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3" />
          </svg>
          <span>Sign out</span>
        </button>
      </nav>
    </div>
  );
}

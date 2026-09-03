import type { ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useApp } from '../state/AppContext';
import { queueDepth } from '../lib/offline';
import './shell.css';

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
    <div className={`shell${noTabs ? ' no-tabs' : ''}`}>
      {/* fade+slide wrapper keyed on route — prototype view transitions */}
      <main className="view-wrap" key={location.pathname}>
        {children}
      </main>
      <nav className="tabbar" aria-label="Main navigation">
        {pending > 0 && (
          <span
            className="queue-pill"
            style={{ position: 'absolute', top: -34, right: 10 }}
            title={`${pending} entr${pending === 1 ? 'y' : 'ies'} waiting to sync`}
          >
            ⇣{pending} offline
          </span>
        )}
        {TABS.map((t) => (
          <NavLink key={t.to} to={t.to} className={({ isActive }) => (isActive ? 'nv on' : 'nv')}>
            {t.glyph}
            <span>{t.label}</span>
          </NavLink>
        ))}
        <button className="nv nv-signout" onClick={signOut} title="Sign out">
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3" />
          </svg>
          <span>Sign out</span>
        </button>
      </nav>
    </div>
  );
}

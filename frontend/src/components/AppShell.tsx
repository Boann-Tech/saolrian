import type { ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useApp } from '../state/AppContext';
import { queueDepth } from '../lib/offline';
import './shell.css';

/** Bottom tab bar + content frame for signed-in screens. */

const TABS = [
  { to: '/today', label: 'Today', icon: '◎' },
  { to: '/add', label: 'Add', icon: '＋' },
  { to: '/history', label: 'History', icon: '▦' },
  { to: '/profile', label: 'Profile', icon: '☰' },
];

export function AppShell({ children }: { children: ReactNode }) {
  const { theme, clearEndpoint, pb, endpoint } = useApp();
  const navigate = useNavigate();
  const pending = queueDepth();

  const signOut = () => {
    pb?.authStore.clear();
    clearEndpoint();
    navigate('/onboarding', { replace: true });
  };

  return (
    <div className="shell">
      <header className="shell-top">
        <span className="logo">
          <span className="logo-dot" style={{ background: theme }} />
          Saolrian
        </span>
        <div className="shell-top-right">
          {pending > 0 && (
            <span className="queue-pill" title={`${pending} entr${pending === 1 ? 'y' : 'ies'} waiting to sync`}>
              ⇣{pending} offline
            </span>
          )}
          <button className="btn btn-ghost btn-sm" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>
      <main className="shell-main">{children}</main>
      <nav className="tabbar">
        {TABS.map((t) => (
          <NavLink key={t.to} to={t.to} className={({ isActive }) => (isActive ? 'tab tab-active' : 'tab')}>
            <span className="tab-icon" aria-hidden>
              {t.icon}
            </span>
            <span>{t.label}</span>
          </NavLink>
        ))}
      </nav>
      <footer className="shell-foot">{endpoint}</footer>
    </div>
  );
}

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

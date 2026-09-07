/**
 * Sign out used to be a sixth item in the bottom tab bar: a rare, destructive,
 * unconfirmed action sitting one thumb-slip from Profile. The tab bar is for
 * destinations.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppShell } from '../AppShell';
import { AppProvider } from '../../state/AppContext';

const fakePb = {
  baseUrl: 'http://localhost:8090',
  authStore: { isValid: true, record: { id: 'user-1' }, onChange: () => () => {}, clear: () => {} },
  collection: (name: string) => {
    if (name === 'profiles') return { getFullList: async () => [] };
    if (name === 'weights') return { getList: async () => ({ items: [] }) };
    if (name === 'meal_slots') return { getFullList: async () => [] };
    throw new Error(`unexpected collection ${name}`);
  },
};

vi.mock('../../lib/pb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pb')>();
  return { ...actual, getClient: () => fakePb };
});

function renderShell() {
  return render(
    <MemoryRouter initialEntries={['/today']}>
      <AppProvider>
        <AppShell>
          <div>content</div>
        </AppShell>
      </AppProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  localStorage.setItem('saolrian-endpoint', 'http://localhost:8090');
});
afterEach(() => cleanup());

describe('AppShell — the tab bar holds destinations only', () => {
  it('has no sign-out control', () => {
    renderShell();
    expect(screen.queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument();
  });

  it('still offers every navigation destination', () => {
    renderShell();
    const nav = screen.getByRole('navigation', { name: /main navigation/i });
    for (const label of ['Today', 'Add', 'History', 'Trends', 'Profile']) {
      expect(within(nav).getByRole('link', { name: label })).toBeInTheDocument();
    }
  });
});

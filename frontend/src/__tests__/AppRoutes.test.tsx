/**
 * The gate used to `return null` while the profile loaded, which showed a
 * blank screen for the length of the fetch — and permanently if it failed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppRoutes } from '../AppRoutes';
import { AppProvider } from '../state/AppContext';

let profileResolves = true;

const fakePb = {
  baseUrl: 'http://localhost:8090',
  authStore: { isValid: true, record: { id: 'user-1' }, onChange: () => () => {} },
  collection: (name: string) => {
    if (name === 'profiles') {
      return {
        getFullList: () => (profileResolves ? Promise.resolve([]) : new Promise(() => {})),
      };
    }
    if (name === 'weights') return { getList: async () => ({ items: [] }) };
    if (name === 'meal_slots') return { getFullList: async () => [] };
    throw new Error(`unexpected collection ${name}`);
  },
};

vi.mock('../lib/pb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/pb')>();
  return { ...actual, getClient: () => fakePb };
});

function renderRoutes() {
  return render(
    <MemoryRouter initialEntries={['/today']}>
      <AppProvider>
        <AppRoutes />
      </AppProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  localStorage.setItem('saolrian-endpoint', 'http://localhost:8090');
  profileResolves = true;
});
afterEach(() => cleanup());

describe('AppRoutes — cold start', () => {
  it('shows a splash while the profile is still loading', async () => {
    profileResolves = false;
    renderRoutes();

    expect(await screen.findByText(/getting your profile/i)).toBeInTheDocument();
  });

  it('does not leave the document empty', async () => {
    profileResolves = false;
    const { container } = renderRoutes();

    expect(container).not.toBeEmptyDOMElement();
  });
});

/**
 * The dashboard must render the user's own targets, not constants, and must
 * explain itself when the backend can't compute a budget.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Today from '../Today';
import { AppProvider } from '../../state/AppContext';

const authRecord = { id: 'user-1' };
let summaryResponse: Record<string, unknown> = {};
let metricRows: Record<string, unknown>[] = [];

const fakePb = {
  baseUrl: 'http://localhost:8090',
  authStore: { isValid: true, record: authRecord, onChange: () => () => {} },
  collection: (name: string) => {
    if (name === 'profiles') return { getFullList: async () => [] };
    if (name === 'weights') return { getList: async () => ({ items: [] }) };
    if (name === 'meal_slots') return { getFullList: async () => [] };
    if (name === 'daily_metrics') {
      return {
        getFullList: async () => metricRows,
        create: async (d: Record<string, unknown>) => d,
        update: async (_id: string, d: Record<string, unknown>) => d,
      };
    }
    if (name === 'diary_entries') return { getList: async () => ({ totalItems: 0 }), delete: async () => ({}) };
    throw new Error(`unexpected collection ${name}`);
  },
};

vi.mock('../../lib/pb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pb')>();
  return { ...actual, getClient: () => fakePb };
});

vi.mock('../../state/AppContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../state/AppContext')>();
  return { ...actual, saolrianSend: async () => summaryResponse };
});

function baseSummary(overrides: Record<string, unknown> = {}) {
  return {
    date: '2026-09-07',
    budget: 2000,
    groups: [],
    totals: { kcal: 900, protein: 60, carbs: 90, fat: 30 },
    ...overrides,
  };
}

function renderToday() {
  return render(
    <MemoryRouter>
      <AppProvider>
        <Today />
      </AppProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  localStorage.setItem('saolrian-endpoint', 'http://localhost:8090');
  summaryResponse = baseSummary();
  metricRows = [];
});
afterEach(() => cleanup());

describe('Today — macro targets come from the profile', () => {
  it('shows each macro against its own target', async () => {
    summaryResponse = baseSummary({
      targets: { protein_g: 180, carbs_g: 220, fat_g: 70, water_ml: 2000, steps: 10000 },
    });
    renderToday();

    expect(await screen.findByText('/ 180')).toBeInTheDocument();
    expect(screen.getByText('/ 220')).toBeInTheDocument();
    expect(screen.getByText('/ 70')).toBeInTheDocument();
  });

  it('omits the macro goal entirely when the API sends no targets', async () => {
    summaryResponse = baseSummary();
    renderToday();

    await screen.findByText('Macros');
    expect(screen.queryByText('/ 150')).not.toBeInTheDocument();
    // The tile shows the intake alone — no goal, no progress bar.
    for (const label of ['Protein', 'Carbs', 'Fat']) {
      const tile = screen.getByText(label).parentElement!;
      expect(tile.textContent).not.toMatch(/\//);
      expect(tile.querySelector('[data-fill]')).toBeNull();
    }
  });
});

describe('Today — water and step goals come from the profile', () => {
  it('renders the goals the API supplies', async () => {
    summaryResponse = baseSummary({
      targets: { protein_g: 0, carbs_g: 0, fat_g: 0, water_ml: 3000, steps: 12000 },
    });
    renderToday();

    expect(await screen.findByText(/\/ 3,000 ml/)).toBeInTheDocument();
    expect(screen.getByText(/\/ 12,000 steps/)).toBeInTheDocument();
  });
});

describe('Today — a missing budget explains itself', () => {
  it('surfaces the reason the backend gave instead of a bare dash', async () => {
    summaryResponse = baseSummary({
      budget: null,
      budget_message: 'weight required: log a weight entry or set calorie_target to compute the budget',
    });
    renderToday();

    expect(await screen.findByText(/log a weight entry/i)).toBeInTheDocument();
  });

  it('links the explanation to the screen that fixes it', async () => {
    summaryResponse = baseSummary({ budget: null, budget_message: 'weight required: log a weight entry' });
    renderToday();

    const fix = await screen.findByRole('link', { name: /profile/i });
    expect(fix).toHaveAttribute('href', '/profile');
  });
});

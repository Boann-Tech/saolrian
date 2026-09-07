/**
 * The dashboard must render the user's own targets, not constants, and must
 * explain itself when the backend can't compute a budget.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Today from '../Today';
import { ToastProvider } from '../../components/ui';
import { AppProvider } from '../../state/AppContext';

const authRecord = { id: 'user-1' };
let summaryResponse: Record<string, unknown> = {};
let metricRows: Record<string, unknown>[] = [];
const deleted: string[] = [];
const metricWrites: Record<string, unknown>[] = [];
const restored: Record<string, unknown>[] = [];
let storedEntry: Record<string, unknown> = {};

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
        create: async (d: Record<string, unknown>) => {
          metricWrites.push(d);
          return { id: 'm1', ...d };
        },
        update: async (_id: string, d: Record<string, unknown>) => {
          metricWrites.push(d);
          return d;
        },
      };
    }
    if (name === 'diary_entries') {
      return {
        getList: async () => ({ totalItems: 0 }),
        getOne: async (id: string) => ({ ...storedEntry, id }),
        delete: async (id: string) => {
          deleted.push(id);
          return {};
        },
        create: async (data: Record<string, unknown>) => {
          restored.push(data);
          return { id: 'entry-new', ...data };
        },
      };
    }
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
        <ToastProvider>
          <Today />
        </ToastProvider>
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
  deleted.length = 0;
  metricWrites.length = 0;
  restored.length = 0;
  storedEntry = {
    id: 'e1',
    user: 'user-1',
    meal_slot: 'slot-7',
    name_snapshot: 'Soup',
    brand_snapshot: 'Brand',
    grams: 300,
    kcal: 210,
    protein: 8,
    carbs: 20,
    fat: 9,
    logged_at: '2026-09-07T12:00:00Z',
    source: 'manual',
  };
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


const groupWithEntry = {
  slot_id: 'slot-7',
  slot_name: 'Lunch',
  sort_order: 1,
  entries: [
    {
      id: 'e1', name: 'Soup', brand: 'Brand', grams: 300, kcal: 210,
      protein: 8, carbs: 20, fat: 9,
      logged_at: '2026-09-07T12:00:00Z', source: 'manual',
    },
  ],
};

describe('Today — deleting an entry is reversible', () => {
  async function deleteTheEntry(user: ReturnType<typeof userEvent.setup>) {
    summaryResponse = baseSummary({ groups: [groupWithEntry] });
    renderToday();
    await user.click(await screen.findByRole('button', { name: /actions for soup/i }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
  }

  it('offers an undo instead of a confirmation', async () => {
    const user = userEvent.setup();
    await deleteTheEntry(user);

    await waitFor(() => expect(deleted).toEqual(['e1']));
    expect(await screen.findByRole('button', { name: /undo/i })).toBeInTheDocument();
  });

  it('restores the entry, with its macros, when undo is tapped', async () => {
    const user = userEvent.setup();
    await deleteTheEntry(user);

    await user.click(await screen.findByRole('button', { name: /undo/i }));

    await waitFor(() => expect(restored).toHaveLength(1));
    expect(restored[0]).toMatchObject({
      meal_slot: 'slot-7',
      name_snapshot: 'Soup',
      kcal: 210,
      protein: 8,
      carbs: 20,
      fat: 9,
      logged_at: '2026-09-07T12:00:00Z',
    });
  });
});


describe('Today — correcting the daily metrics', () => {
  it('lets steps be set to an exact figure, not just incremented', async () => {
    metricRows = [{ id: 'm1', water_ml: 500, steps: 12000 }];
    const user = userEvent.setup();
    renderToday();

    await user.click(await screen.findByRole('button', { name: /edit step count/i }));
    const field = screen.getByLabelText(/step count/i);
    await user.clear(field);
    await user.type(field, '7432');
    await user.tab();

    await waitFor(() => expect(metricWrites.some((w) => w['steps'] === 7432)).toBe(true));
  });

  it('lets water be corrected downward after a mis-tap', async () => {
    metricRows = [{ id: 'm1', water_ml: 2500, steps: 0 }];
    const user = userEvent.setup();
    renderToday();

    await user.click(await screen.findByRole('button', { name: /edit water amount/i }));
    const field = screen.getByLabelText(/water amount/i);
    await user.clear(field);
    await user.type(field, '2000');
    await user.tab();

    await waitFor(() => expect(metricWrites.some((w) => w['water_ml'] === 2000)).toBe(true));
  });
});

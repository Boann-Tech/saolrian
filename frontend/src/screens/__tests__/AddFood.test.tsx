import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import AddFood from '../AddFood';
import { AppProvider } from '../../state/AppContext';
import { todayISO } from '../../lib/format';

const authRecord = { id: 'user-1' };
const created: Record<string, unknown>[] = [];

const fakePb = {
  baseUrl: 'http://localhost:8090',
  authStore: { isValid: true, record: authRecord, onChange: () => () => {} },
  collection: (name: string) => {
    if (name === 'profiles') return { getFullList: async () => [] };
    if (name === 'weights') return { getList: async () => ({ items: [] }) };
    if (name === 'meal_slots')
      return {
        getFullList: async () => [
          { id: 'slot-1', name: 'Lunch', sort_order: 0, pct_allocation: null },
          { id: 'slot-2', name: 'Dinner', sort_order: 1, pct_allocation: null },
        ],
      };
    if (name === 'diary_entries') {
      return {
        create: async (data: Record<string, unknown>) => {
          created.push(data);
          return { id: 'entry-1', ...data };
        },
      };
    }
    throw new Error(`unexpected collection ${name}`);
  },
};

vi.mock('../../lib/pb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pb')>();
  return { ...actual, getClient: () => fakePb, saolrianSend: vi.fn().mockResolvedValue({ local: [], remote: [] }) };
});

vi.mock('../../lib/recipes', () => ({
  listRecipes: vi.fn().mockResolvedValue([
    { id: 'recipe-1', name: 'Chili', servings: 4, total_kcal: 800, total_protein: 60, total_carbs: 80, total_fat: 20 },
  ]),
}));

function renderAddFood(route = '/add') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AppProvider>
        <AddFood />
      </AppProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  localStorage.setItem('saolrian-endpoint', 'http://localhost:8090');
  created.length = 0;
});
afterEach(() => cleanup());

describe('AddFood — From recipe', () => {
  it('logs a scaled combined diary entry for a chosen number of servings', async () => {
    const user = userEvent.setup();
    renderAddFood();

    await user.click(await screen.findByRole('button', { name: /from recipe/i }));
    await user.click(await screen.findByText('Chili'));

    // per-serving macro card: 800/4=200 kcal, 60/4=15p, 80/4=20c, 20/4=5f.
    // "200" appears twice (the macro card's kcal cell and the "for 1
    // serving · 200 kcal per serving" caption), so assert on the
    // unambiguous protein/carbs/fat cells and just count the kcal ones.
    expect(await screen.findByText('15g')).toBeInTheDocument();
    expect(screen.getByText('20g')).toBeInTheDocument();
    expect(screen.getByText('5g')).toBeInTheDocument();
    expect(screen.getAllByText('200').length).toBeGreaterThan(0);

    // servings-to-log stepper defaults to 1; one click (step 0.5) makes it 1.5
    await user.click(screen.getByRole('button', { name: 'increase' }));
    await user.click(await screen.findByRole('button', { name: 'Lunch' }));
    await user.click(screen.getByRole('button', { name: /add to diary/i }));

    expect(created[0]).toMatchObject({
      source: 'recipe',
      food: null,
      name_snapshot: 'Chili',
      external_id: 'recipe-1',
      meal_slot: 'slot-1',
      kcal: 300, // 200/serving x 1.5 servings
      protein: 22.5,
      carbs: 30,
      fat: 7.5,
    });
  });
});


describe('AddFood — logging to a chosen day', () => {
  async function quickAdd(user: ReturnType<typeof userEvent.setup>, kcal = '250') {
    await user.click(await screen.findByRole('button', { name: /quick add/i }));
    await user.type(await screen.findByLabelText(/Calories/i), kcal);
    await user.click(screen.getByRole('button', { name: /^add$/i }));
  }

  it('stamps the entry with the date from the query string', async () => {
    const user = userEvent.setup();
    renderAddFood('/add?date=2026-09-01');

    await quickAdd(user);

    await waitFor(() => expect(created).toHaveLength(1));
    expect(String(created[0]['logged_at'])).toMatch(/^2026-09-01/);
  });

  it('stamps today when no date is given', async () => {
    const user = userEvent.setup();
    renderAddFood('/add');

    await quickAdd(user);

    await waitFor(() => expect(created).toHaveLength(1));
    expect(String(created[0]['logged_at']).slice(0, 10)).toBe(todayISO());
  });

  it('preselects the meal slot named in the query string', async () => {
    const user = userEvent.setup();
    renderAddFood('/add?slot=slot-2');

    await quickAdd(user);

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]['meal_slot']).toBe('slot-2');
  });

  it('names the day it is logging to when that day is not today', async () => {
    renderAddFood('/add?date=2026-09-01');
    expect(await screen.findByText(/1 September 2026/i)).toBeInTheDocument();
  });

  it('says nothing about the date when logging to today', async () => {
    renderAddFood('/add');
    await screen.findByRole('button', { name: /quick add/i });
    expect(screen.queryByTestId('logging-to')).not.toBeInTheDocument();
  });
});

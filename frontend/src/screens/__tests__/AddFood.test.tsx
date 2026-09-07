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
        getList: async () => ({ items: slotHistory }),
        create: async (data: Record<string, unknown>) => {
          created.push(data);
          return { id: 'entry-1', ...data };
        },
      };
    }
    throw new Error(`unexpected collection ${name}`);
  },
};

let searchResults: Record<string, unknown> = { local: [], remote: [] };
let slotHistory: Record<string, unknown>[] = [];

vi.mock('../../lib/pb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pb')>();
  return { ...actual, getClient: () => fakePb, saolrianSend: async () => searchResults };
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
  searchResults = { local: [], remote: [] };
  slotHistory = [];
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


describe('AddFood — food source attribution', () => {
  const food = {
    name: 'Hummus', brand: 'Acme', kcal_per_100g: 300,
    protein_per_100g: 8, carbs_per_100g: 12, fat_per_100g: 24,
    default_serving_g: 100, barcode: '3017620422003', local: false,
  };

  it('links the Open Food Facts credit to the product it came from', async () => {
    searchResults = { local: [], remote: [food] };
    const user = userEvent.setup();
    renderAddFood();

    await user.type(screen.getByPlaceholderText(/search foods/i), 'hummus');
    await user.click(await screen.findByText('Hummus'));

    const credit = await screen.findByRole('link', { name: /open food facts/i });
    expect(credit).toHaveAttribute('href', 'https://world.openfoodfacts.org/product/3017620422003');
  });

  it('does not dress the credit as a link when there is nothing to link to', async () => {
    searchResults = { local: [], remote: [{ ...food, barcode: undefined }] };
    const user = userEvent.setup();
    renderAddFood();

    await user.type(screen.getByPlaceholderText(/search foods/i), 'hummus');
    await user.click(await screen.findByText('Hummus'));

    await screen.findByText(/Add to meal/i);
    expect(screen.queryByRole('link', { name: /open food facts/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/↗/)).not.toBeInTheDocument();
  });
});


describe('AddFood — search results are real controls', () => {
  it('exposes each result as a button, not a div playing one', async () => {
    searchResults = {
      local: [],
      remote: [
        {
          name: 'Hummus', brand: 'Acme', kcal_per_100g: 300,
          protein_per_100g: 8, carbs_per_100g: 12, fat_per_100g: 24,
          default_serving_g: 100, local: false,
        },
      ],
    };
    const user = userEvent.setup();
    renderAddFood();

    await user.type(screen.getByPlaceholderText(/search foods/i), 'hummus');

    const row = await screen.findByRole('button', { name: /hummus/i });
    // A native button gets Enter *and* Space from the browser, without the
    // page scrolling on Space the way a role="button" div does.
    expect(row.tagName).toBe('BUTTON');

    row.focus();
    await user.keyboard(' ');
    expect(await screen.findByText(/Add to meal/i)).toBeInTheDocument();
  });
});


describe('AddFood — the meal slot is inferred from the time of day', () => {
  async function quickAddNow(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: /quick add/i }));
    await user.type(await screen.findByLabelText(/Calories/i), '250');
    await user.click(screen.getByRole('button', { name: /^add$/i }));
  }

  it('defaults to the slot the user usually logs into at this hour', async () => {
    const now = new Date();
    const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000).toISOString();
    // slot-2 is what gets used around now; slot-1 is used 8 hours away.
    slotHistory = [
      { meal_slot: 'slot-2', logged_at: now.toISOString() },
      { meal_slot: 'slot-2', logged_at: now.toISOString() },
      { meal_slot: 'slot-1', logged_at: hoursAgo(8) },
    ];
    const user = userEvent.setup();
    renderAddFood();

    await quickAddNow(user);

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]['meal_slot']).toBe('slot-2');
  });

  it('still lets an explicit ?slot= win over the inference', async () => {
    const now = new Date();
    slotHistory = [{ meal_slot: 'slot-2', logged_at: now.toISOString() }];
    const user = userEvent.setup();
    renderAddFood('/add?slot=slot-1');

    await quickAddNow(user);

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]['meal_slot']).toBe('slot-1');
  });
});


describe('AddFood — recents', () => {
  const recentRows = [
    {
      meal_slot: 'slot-1', name_snapshot: 'Porridge', brand_snapshot: 'Flahavans',
      grams: 200, kcal: 300, protein: 10, carbs: 50, fat: 6,
      logged_at: '2026-09-06T08:00:00Z',
    },
  ];

  it('offers recently logged foods before anything is typed', async () => {
    slotHistory = recentRows;
    renderAddFood();

    expect(await screen.findByText('Recently logged')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /porridge/i })).toBeInTheDocument();
  });

  it('opens a recent food pre-filled with the amount last logged', async () => {
    slotHistory = recentRows;
    const user = userEvent.setup();
    renderAddFood();

    await user.click(await screen.findByRole('button', { name: /porridge/i }));

    // 300 kcal for 200 g, pre-filled at 200 g again.
    expect(await screen.findByLabelText(/serving size in grams/i)).toHaveValue('200');
    expect(screen.getByText('300')).toBeInTheDocument();
  });

  it('hides the recents once a search is under way', async () => {
    slotHistory = recentRows;
    const user = userEvent.setup();
    renderAddFood();
    await screen.findByText('Recently logged');

    await user.type(screen.getByPlaceholderText(/search foods/i), 'hummus');

    await waitFor(() => expect(screen.queryByText('Recently logged')).not.toBeInTheDocument());
  });

  it('says nothing when there is no history to show', async () => {
    slotHistory = [];
    renderAddFood();

    await screen.findByRole('button', { name: /quick add/i });
    expect(screen.queryByText('Recently logged')).not.toBeInTheDocument();
  });
});

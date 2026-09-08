/**
 * Editing an entry's calories used to write kcal/grams/slot only, leaving the
 * stored macros at their original values — so the diary's macro totals no
 * longer matched its calorie total.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import EditEntry from '../EditEntry';
import { AppProvider } from '../../state/AppContext';

const authRecord = { id: 'user-1' };
let entry: Record<string, unknown> = {};
const updates: Record<string, unknown>[] = [];

const fakePb = {
  baseUrl: 'http://localhost:8090',
  authStore: { isValid: true, record: authRecord, onChange: () => () => {} },
  collection: (name: string) => {
    if (name === 'profiles') return { getFullList: async () => [] };
    if (name === 'weights') return { getList: async () => ({ items: [] }) };
    if (name === 'meal_slots')
      return { getFullList: async () => [{ id: 'slot-1', name: 'Lunch', sort_order: 0, pct_allocation: null }] };
    if (name === 'diary_entries') {
      return {
        getOne: async () => entry,
        update: async (_id: string, data: Record<string, unknown>) => {
          updates.push(data);
          return data;
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

function renderEdit() {
  return render(
    <MemoryRouter initialEntries={['/edit/entry-1']}>
      <AppProvider>
        <Routes>
          <Route path="/edit/:id" element={<EditEntry />} />
        </Routes>
      </AppProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  localStorage.setItem('saolrian-endpoint', 'http://localhost:8090');
  updates.length = 0;
  entry = {
    id: 'entry-1',
    name_snapshot: 'Chicken breast',
    kcal: 600,
    grams: 200,
    protein: 40,
    carbs: 60,
    fat: 20,
    meal_slot: 'slot-1',
  };
});
afterEach(() => cleanup());

describe('EditEntry — macros track the calorie edit', () => {
  it('scales macros by the calorie ratio', async () => {
    const user = userEvent.setup();
    renderEdit();

    const kcal = await screen.findByLabelText(/Calories/i);
    await waitFor(() => expect(kcal).toHaveValue(600));
    await user.clear(kcal);
    await user.type(kcal, '300');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]).toMatchObject({ kcal: 300, protein: 20, carbs: 30, fat: 10 });
  });

  it('leaves macros untouched when the calories are unchanged', async () => {
    const user = userEvent.setup();
    renderEdit();

    const kcal = await screen.findByLabelText(/Calories/i);
    await waitFor(() => expect(kcal).toHaveValue(600));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]).toMatchObject({ protein: 40, carbs: 60, fat: 20 });
  });

  it('writes no macros, rather than Infinity, when there is no ratio to scale by', async () => {
    entry = { ...entry, kcal: 0, protein: 0, carbs: 0, fat: 0 };
    const user = userEvent.setup();
    renderEdit();

    const kcal = await screen.findByLabelText(/Calories/i);
    await waitFor(() => expect(kcal).toHaveValue(0));
    await user.clear(kcal);
    await user.type(kcal, '250');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(updates).toHaveLength(1));
    const written = updates[0];
    expect(written).toMatchObject({ kcal: 250 });
    // An entry with no calories has no composition to preserve — leave the
    // stored macros untouched instead of dividing by zero.
    expect(written).not.toHaveProperty('protein');
    for (const v of Object.values(written)) {
      if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
    }
  });
});


describe('EditEntry — grams is the quantity, so calories follow it', () => {
  it('rescales calories and macros when the amount is reduced', async () => {
    const user = userEvent.setup();
    renderEdit();

    const grams = await screen.findByLabelText(/Grams/i);
    await waitFor(() => expect(grams).toHaveValue(200));
    await user.clear(grams);
    await user.type(grams, '100');

    // Half the food: the calorie field follows, visibly, before saving.
    await waitFor(() => expect(screen.getByLabelText(/Calories/i)).toHaveValue(300));

    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]).toMatchObject({ grams: 100, kcal: 300, protein: 20, carbs: 30, fat: 10 });
  });

  it('rescales upward too', async () => {
    const user = userEvent.setup();
    renderEdit();

    const grams = await screen.findByLabelText(/Grams/i);
    await waitFor(() => expect(grams).toHaveValue(200));
    await user.clear(grams);
    await user.type(grams, '300');

    await waitFor(() => expect(screen.getByLabelText(/Calories/i)).toHaveValue(900));
  });

  it('treats a direct calorie edit as an override, leaving the amount alone', async () => {
    const user = userEvent.setup();
    renderEdit();

    const kcal = await screen.findByLabelText(/Calories/i);
    await waitFor(() => expect(kcal).toHaveValue(600));
    await user.clear(kcal);
    await user.type(kcal, '500');

    // The user is correcting the database's number, not the portion.
    expect(screen.getByLabelText(/Grams/i)).toHaveValue(200);

    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]).toMatchObject({ grams: 200, kcal: 500 });
  });

  it('leaves calories alone for an entry that was logged without a weight', async () => {
    entry = { ...entry, grams: 0 };
    const user = userEvent.setup();
    renderEdit();

    const grams = await screen.findByLabelText(/Grams/i);
    await waitFor(() => expect(grams).toHaveValue(0));
    await user.clear(grams);
    await user.type(grams, '150');

    // Nothing to scale from — the calorie figure stands as logged.
    expect(screen.getByLabelText(/Calories/i)).toHaveValue(600);
  });
});


describe('EditEntry — grams scaling is exact', () => {
  it('scales macros by the gram ratio, not by the rounded calorie figure', async () => {
    // 3 g -> 2 g is exactly 2/3. Deriving macros from the rounded calorie
    // figure (100 -> 67) instead gives 16.8; the true answer is 16.7.
    entry = { ...entry, grams: 3, kcal: 100, protein: 25, carbs: 0, fat: 0 };
    const user = userEvent.setup();
    renderEdit();

    const grams = await screen.findByLabelText(/Grams/i);
    await waitFor(() => expect(grams).toHaveValue(3));
    await user.clear(grams);
    await user.type(grams, '2');

    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]).toMatchObject({ grams: 2, kcal: 67, protein: 16.7 });
  });

  it('still scales by the calorie ratio when calories are edited directly', async () => {
    entry = { ...entry, grams: 3, kcal: 100, protein: 25, carbs: 0, fat: 0 };
    const user = userEvent.setup();
    renderEdit();

    const kcal = await screen.findByLabelText(/Calories/i);
    await waitFor(() => expect(kcal).toHaveValue(100));
    await user.clear(kcal);
    await user.type(kcal, '67');

    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updates).toHaveLength(1));
    // No gram ratio involved here — the override is the source of truth.
    expect(updates[0]).toMatchObject({ grams: 3, kcal: 67, protein: 16.8 });
  });
});

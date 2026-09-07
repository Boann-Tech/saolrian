import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Recipes from '../Recipes';
import { AppProvider } from '../../state/AppContext';

const authRecord = { id: 'user-1' };
let recipeRows: Record<string, unknown>[] = [];

const fakePb = {
  baseUrl: 'http://localhost:8090',
  authStore: { isValid: true, record: authRecord, onChange: () => () => {} },
  collection: (name: string) => {
    if (name === 'recipes') return { getFullList: async () => recipeRows };
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

function renderRecipes() {
  return render(
    <MemoryRouter initialEntries={['/add', '/recipes']} initialIndex={1}>
      <AppProvider>
        <Routes>
          <Route path="/add" element={<div>add food screen</div>} />
          <Route path="/recipes" element={<Recipes />} />
          <Route path="/profile" element={<div>profile screen</div>} />
        </Routes>
      </AppProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  localStorage.setItem('saolrian-endpoint', 'http://localhost:8090');
  recipeRows = [];
});
afterEach(() => cleanup());

describe('Recipes list', () => {
  it('shows an empty state with no recipes', async () => {
    renderRecipes();
    expect(await screen.findByText(/No recipes yet/i)).toBeInTheDocument();
  });

  it('lists recipes with kcal per serving', async () => {
    recipeRows = [
      { id: 'r1', user: 'user-1', name: 'Chili', servings: 4, total_kcal: 800, total_protein: 60, total_carbs: 80, total_fat: 20 },
    ];
    renderRecipes();
    expect(await screen.findByText('Chili')).toBeInTheDocument();
    expect(screen.getByText('4 servings')).toBeInTheDocument();
    expect(screen.getByText('200')).toBeInTheDocument();
  });
});


describe('Recipes — back returns where you came from', () => {
  it('goes back to the screen that opened it, not always Profile', async () => {
    const user = userEvent.setup();
    renderRecipes();

    await user.click(await screen.findByRole('button', { name: /back/i }));

    expect(await screen.findByText('add food screen')).toBeInTheDocument();
  });
});

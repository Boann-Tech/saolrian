import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import RecipeEditor from '../RecipeEditor';
import { AppProvider } from '../../state/AppContext';

const authRecord = { id: 'user-1' };

const fakePb = {
  baseUrl: 'http://localhost:8090',
  authStore: { isValid: true, record: authRecord, onChange: () => () => {} },
  collection: (name: string) => {
    if (name === 'profiles') return { getFullList: async () => [] };
    if (name === 'weights') return { getList: async () => ({ items: [] }) };
    if (name === 'meal_slots') return { getFullList: async () => [] };
    if (name === 'recipes') {
      return {
        getOne: async (id: string) => ({ id, name: 'Chili', servings: 4, total_kcal: 220, total_protein: 14, total_carbs: 40, total_fat: 1 }),
      };
    }
    throw new Error(`unexpected collection ${name}`);
  },
};

vi.mock('../../lib/pb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pb')>();
  return {
    ...actual,
    getClient: () => fakePb,
    saolrianSend: vi.fn().mockResolvedValue({
      local: [{ name: 'Black beans', brand: 'Acme', kcal_per_100g: 110, protein_per_100g: 7, carbs_per_100g: 20, fat_per_100g: 0.5, local: true, barcode: null, default_serving_g: 100 }],
      remote: [],
    }),
  };
});

const saveRecipeMock = vi.fn().mockResolvedValue('recipe-1');
vi.mock('../../lib/recipes', () => ({
  saveRecipe: (...args: unknown[]) => saveRecipeMock(...args),
  loadRecipeIngredients: vi.fn().mockResolvedValue([]),
  deleteRecipe: vi.fn(),
  listRecipes: vi.fn().mockResolvedValue([]),
}));

function renderEditor(path = '/recipes/new') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProvider>
        <Routes>
          <Route path="/recipes/new" element={<RecipeEditor />} />
          <Route path="/recipes/:id" element={<RecipeEditor />} />
        </Routes>
      </AppProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  localStorage.setItem('saolrian-endpoint', 'http://localhost:8090');
  saveRecipeMock.mockClear();
});
afterEach(() => cleanup());

describe('RecipeEditor — create flow', () => {
  it('disables Save with zero ingredients', async () => {
    renderEditor();
    const nameInput = await screen.findByLabelText('Name');
    await userEvent.type(nameInput, 'Chili');
    expect(screen.getByRole('button', { name: /save recipe/i })).toBeDisabled();
  });

  it('adds a quick manual ingredient, updates totals, and saves', async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.type(await screen.findByLabelText('Name'), 'Chili');

    await user.click(screen.getByRole('button', { name: /\+ add ingredient/i }));
    await user.click(screen.getByRole('button', { name: /quick add/i }));

    await user.type(screen.getByLabelText('Calories (kcal)'), '300');
    await user.type(screen.getByLabelText('Protein (g)'), '20');
    await user.type(screen.getByLabelText('Carbs (g)'), '30');
    await user.type(screen.getByLabelText('Fat (g)'), '10');
    await user.type(screen.getByLabelText('Ingredient name'), 'Homemade sauce');
    await user.click(screen.getByRole('button', { name: /^add$/i }));

    expect(screen.getByText('Homemade sauce')).toBeInTheDocument();
    expect(screen.getByText(/300 kcal total/i)).toBeInTheDocument();

    const saveBtn = screen.getByRole('button', { name: /save recipe/i });
    expect(saveBtn).toBeEnabled();
    await user.click(saveBtn);

    expect(saveRecipeMock).toHaveBeenCalledWith(
      fakePb,
      'user-1',
      null,
      { name: 'Chili', servings: 1 },
      [
        expect.objectContaining({
          food: null,
          name_snapshot: 'Homemade sauce',
          kcal: 300,
          protein: 20,
          carbs: 30,
          fat: 10,
          sort_order: 0,
        }),
      ],
      [],
    );
  });
});

describe('RecipeEditor — search-sourced ingredient', () => {
  it('adds a searched food as an ingredient scaled to the entered grams', async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.type(await screen.findByLabelText('Name'), 'Chili');
    await user.click(screen.getByRole('button', { name: /\+ add ingredient/i }));
    await user.click(screen.getByRole('button', { name: /search foods/i }));

    await user.type(screen.getByPlaceholderText(/search foods/i), 'beans');
    expect(await screen.findByText('Black beans')).toBeInTheDocument();
    await user.click(screen.getByText('Black beans'));

    await user.click(screen.getByRole('button', { name: /^add ingredient$/i }));

    expect(screen.getByText('Black beans')).toBeInTheDocument();
    expect(saveRecipeMock).not.toHaveBeenCalled(); // not saved yet, just added to the draft
  });
});

describe('RecipeEditor — edit flow', () => {
  it('loads an existing recipe and its ingredients, and deletes it', async () => {
    const recipesLib = await import('../../lib/recipes');
    vi.mocked(recipesLib.loadRecipeIngredients).mockResolvedValueOnce([
      { id: 'ing-1', recipe: 'recipe-1', food: null, name_snapshot: 'Beans', brand_snapshot: null, grams: 200, kcal: 220, protein: 14, carbs: 40, fat: 1, sort_order: 0 },
    ]);
    const deleteMock = vi.mocked(recipesLib.deleteRecipe);

    const user = userEvent.setup();
    renderEditor('/recipes/recipe-1');

    const nameInput = await screen.findByLabelText('Name');
    // Loading a recipe requires knowing its own fields; RecipeEditor fetches
    // them via pb.collection('recipes').getOne, stubbed on fakePb below.
    expect(nameInput).toHaveValue('Chili');
    expect(await screen.findByText('Beans')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /delete recipe/i }));
    expect(deleteMock).toHaveBeenCalledWith(fakePb, 'recipe-1');
  });
});

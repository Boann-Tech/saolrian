import { describe, it, expect } from 'vitest';
import type PocketBase from 'pocketbase';
import { listRecipes, loadRecipeIngredients, saveRecipe, deleteRecipe } from './recipes';

function makeFakePb() {
  const recipes = new Map<string, Record<string, unknown>>();
  const ingredients = new Map<string, Record<string, unknown>>();
  let nextId = 1;

  const fake = {
    collection: (name: string) => {
      if (name === 'recipes') {
        return {
          create: async (data: Record<string, unknown>) => {
            const id = `recipe-${nextId++}`;
            const rec = { id, ...data };
            recipes.set(id, rec);
            return rec;
          },
          update: async (id: string, data: Record<string, unknown>) => {
            const rec = { ...(recipes.get(id) ?? {}), ...data };
            recipes.set(id, rec);
            return rec;
          },
          delete: async (id: string) => {
            recipes.delete(id);
          },
          getFullList: async (opts: { filter: string }) => {
            const uid = /user="([^"]+)"/.exec(opts.filter)?.[1];
            return [...recipes.values()].filter((r) => r.user === uid);
          },
        };
      }
      if (name === 'recipe_ingredients') {
        return {
          create: async (data: Record<string, unknown>) => {
            const id = `ing-${nextId++}`;
            const rec = { id, ...data };
            ingredients.set(id, rec);
            return rec;
          },
          update: async (id: string, data: Record<string, unknown>) => {
            const rec = { ...(ingredients.get(id) ?? {}), ...data };
            ingredients.set(id, rec);
            return rec;
          },
          delete: async (id: string) => {
            ingredients.delete(id);
          },
          getFullList: async (opts: { filter: string }) => {
            const recipeId = /recipe="([^"]+)"/.exec(opts.filter)?.[1];
            return [...ingredients.values()]
              .filter((i) => i.recipe === recipeId)
              .sort((a, b) => (a.sort_order as number) - (b.sort_order as number));
          },
        };
      }
      throw new Error(`unexpected collection ${name}`);
    },
  };

  return { fake: fake as unknown as PocketBase, recipes, ingredients };
}

describe('saveRecipe', () => {
  it('creates a recipe with denormalized totals and its ingredient rows', async () => {
    const { fake, recipes, ingredients } = makeFakePb();
    const { id } = await saveRecipe(
      fake,
      'user-1',
      null,
      { name: 'Chili', servings: 4 },
      [
        { food: 'food-1', name_snapshot: 'Beans', brand_snapshot: null, grams: 200, kcal: 220, protein: 14, carbs: 40, fat: 1, sort_order: 0 },
        { food: null, name_snapshot: 'Homemade sauce', brand_snapshot: null, grams: 0, kcal: 100, protein: 2, carbs: 10, fat: 5, sort_order: 1 },
      ],
      [],
    );
    expect(recipes.get(id)).toMatchObject({
      user: 'user-1',
      name: 'Chili',
      servings: 4,
      total_kcal: 320,
      total_protein: 16,
      total_carbs: 50,
      total_fat: 6,
    });
    expect(ingredients.size).toBe(2);
  });

  it('updates an existing recipe row instead of creating a new one', async () => {
    const { fake, recipes } = makeFakePb();
    const { id } = await saveRecipe(fake, 'user-1', null, { name: 'Soup', servings: 2 }, [], []);
    await saveRecipe(fake, 'user-1', id, { name: 'Soup v2', servings: 3 }, [], []);
    expect(recipes.size).toBe(1);
    expect(recipes.get(id)).toMatchObject({ name: 'Soup v2', servings: 3 });
  });

  it('deletes ingredient rows that were removed from the draft', async () => {
    const { fake, ingredients } = makeFakePb();
    const { id } = await saveRecipe(
      fake,
      'user-1',
      null,
      { name: 'Soup', servings: 2 },
      [{ food: null, name_snapshot: 'Stock', brand_snapshot: null, grams: 0, kcal: 50, protein: 1, carbs: 5, fat: 0, sort_order: 0 }],
      [],
    );
    const [onlyIngredient] = [...ingredients.values()];
    await saveRecipe(fake, 'user-1', id, { name: 'Soup', servings: 2 }, [], [onlyIngredient.id as string]);
    expect(ingredients.size).toBe(0);
  });

  it('returns the persisted ingredient ids in draft order, so re-saving with them attached does not duplicate rows', async () => {
    // Regression test for the bug where saveRecipe reported no ingredient
    // ids back to the caller: RecipeEditor would keep a fresh draft
    // ingredient id-less in memory after a first save, and re-save it as a
    // second, duplicate row. Here we simulate what the editor now does:
    // take the ids saveRecipe hands back and feed them into the next call.
    const { fake, ingredients } = makeFakePb();
    const { id, ingredientIds } = await saveRecipe(
      fake,
      'user-1',
      null,
      { name: 'Chili', servings: 4 },
      [{ food: null, name_snapshot: 'Beans', brand_snapshot: null, grams: 200, kcal: 220, protein: 14, carbs: 40, fat: 1, sort_order: 0 }],
      [],
    );
    expect(ingredientIds).toHaveLength(1);
    expect(ingredients.size).toBe(1);

    // Simulate the editor writing the returned id back onto its draft
    // (RecipeEditor.save's setIngredients) and saving again, e.g. after a
    // typo fix — same ingredient, now carrying its persisted id.
    const secondDraft = [
      {
        id: ingredientIds[0],
        food: null,
        name_snapshot: 'Beans (fixed typo)',
        brand_snapshot: null,
        grams: 200,
        kcal: 220,
        protein: 14,
        carbs: 40,
        fat: 1,
        sort_order: 0,
      },
    ];
    await saveRecipe(fake, 'user-1', id, { name: 'Chili', servings: 4 }, secondDraft, ingredientIds);

    expect(ingredients.size).toBe(1);
    expect([...ingredients.values()][0]).toMatchObject({ name_snapshot: 'Beans (fixed typo)' });
  });
});

describe('loadRecipeIngredients', () => {
  it('returns ingredients for a recipe sorted by sort_order', async () => {
    const { fake } = makeFakePb();
    const { id } = await saveRecipe(
      fake,
      'user-1',
      null,
      { name: 'Chili', servings: 4 },
      [
        { food: null, name_snapshot: 'B', brand_snapshot: null, grams: 0, kcal: 1, protein: 0, carbs: 0, fat: 0, sort_order: 1 },
        { food: null, name_snapshot: 'A', brand_snapshot: null, grams: 0, kcal: 1, protein: 0, carbs: 0, fat: 0, sort_order: 0 },
      ],
      [],
    );
    const loaded = await loadRecipeIngredients(fake, id);
    expect(loaded.map((i) => i.name_snapshot)).toEqual(['A', 'B']);
  });
});

describe('listRecipes', () => {
  it('returns only the given user\'s recipes', async () => {
    const { fake } = makeFakePb();
    await saveRecipe(fake, 'user-1', null, { name: 'Mine', servings: 1 }, [], []);
    await saveRecipe(fake, 'user-2', null, { name: 'Theirs', servings: 1 }, [], []);
    const mine = await listRecipes(fake, 'user-1');
    expect(mine.map((r) => r.name)).toEqual(['Mine']);
  });
});

describe('deleteRecipe', () => {
  it('deletes the recipe row (ingredient cleanup is server-side CascadeDelete)', async () => {
    const { fake, recipes } = makeFakePb();
    const { id } = await saveRecipe(fake, 'user-1', null, { name: 'X', servings: 1 }, [], []);
    await deleteRecipe(fake, id);
    expect(recipes.has(id)).toBe(false);
  });
});

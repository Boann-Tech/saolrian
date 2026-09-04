import type PocketBase from 'pocketbase';
import type { Recipe, RecipeIngredient } from './types';
import { sumIngredients } from './nutrition';

/** Persistence + diffing for recipes and their ingredient rows.
 *
 * Ingredients are edited as a local draft array (see RecipeEditor) and only
 * reconciled against the server on Save: existing rows are updated,
 * removed rows are deleted, and new rows (no `id`) are created.
 */

export interface IngredientDraft {
  id?: string;
  food: string | null;
  name_snapshot: string;
  brand_snapshot: string | null;
  grams: number;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  sort_order: number;
}

export async function listRecipes(pb: PocketBase, userId: string): Promise<Recipe[]> {
  const recs = await pb.collection('recipes').getFullList({
    filter: `user="${userId}"`,
    sort: 'name',
  });
  return recs as unknown as Recipe[];
}

export async function loadRecipeIngredients(pb: PocketBase, recipeId: string): Promise<RecipeIngredient[]> {
  const recs = await pb.collection('recipe_ingredients').getFullList({
    filter: `recipe="${recipeId}"`,
    sort: 'sort_order',
  });
  return recs as unknown as RecipeIngredient[];
}

export async function saveRecipe(
  pb: PocketBase,
  userId: string,
  recipeId: string | null,
  fields: { name: string; servings: number },
  ingredients: IngredientDraft[],
  originalIds: string[],
): Promise<{ id: string; ingredientIds: string[] }> {
  const totals = sumIngredients(ingredients);
  const recipePayload = {
    ...fields,
    total_kcal: totals.kcal,
    total_protein: totals.protein,
    total_carbs: totals.carbs,
    total_fat: totals.fat,
  };

  let id = recipeId;
  if (id) {
    await pb.collection('recipes').update(id, recipePayload);
  } else {
    const rec = await pb.collection('recipes').create({ user: userId, ...recipePayload });
    id = rec.id as string;
  }

  const keptIds = new Set(ingredients.filter((i) => i.id).map((i) => i.id as string));
  for (const origId of originalIds) {
    if (!keptIds.has(origId)) {
      await pb.collection('recipe_ingredients').delete(origId);
    }
  }

  // Collected in the same order as `ingredients` so callers can zip the
  // result back onto their draft array positionally (see RecipeEditor.save).
  const ingredientIds: string[] = [];
  for (const ing of ingredients) {
    const payload = {
      user: userId,
      recipe: id,
      food: ing.food,
      name_snapshot: ing.name_snapshot,
      brand_snapshot: ing.brand_snapshot ?? '',
      grams: ing.grams,
      kcal: ing.kcal,
      protein: ing.protein,
      carbs: ing.carbs,
      fat: ing.fat,
      sort_order: ing.sort_order,
    };
    if (ing.id) {
      await pb.collection('recipe_ingredients').update(ing.id, payload);
      ingredientIds.push(ing.id);
    } else {
      const rec = await pb.collection('recipe_ingredients').create(payload);
      ingredientIds.push(rec.id as string);
    }
  }

  return { id, ingredientIds };
}

export async function deleteRecipe(pb: PocketBase, recipeId: string): Promise<void> {
  await pb.collection('recipes').delete(recipeId);
}

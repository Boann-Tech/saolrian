import { describe, it, expect } from 'vitest';
import { recentFoods } from '../recentFoods';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'x',
  meal_slot: 'slot-1',
  name_snapshot: 'Porridge',
  brand_snapshot: 'Flahavans',
  grams: 200,
  kcal: 300,
  protein: 10,
  carbs: 50,
  fat: 6,
  logged_at: '2026-09-06T08:00:00Z',
  ...over,
});

describe('recentFoods', () => {
  it('derives per-100g values from the logged amount', () => {
    const [food] = recentFoods([row()]);
    // 300 kcal for 200 g => 150 per 100 g
    expect(food.kcal_per_100g).toBe(150);
    expect(food.protein_per_100g).toBe(5);
    expect(food.carbs_per_100g).toBe(25);
    expect(food.fat_per_100g).toBe(3);
  });

  it('remembers the amount last logged, so it can be pre-filled', () => {
    const [food] = recentFoods([row({ grams: 175, logged_at: '2026-09-06T09:00:00Z' })]);
    expect(food.default_serving_g).toBe(175);
  });

  it('collapses repeats of the same food, newest first', () => {
    const out = recentFoods([
      row({ name_snapshot: 'Porridge', logged_at: '2026-09-01T08:00:00Z' }),
      row({ name_snapshot: 'Eggs', logged_at: '2026-09-05T08:00:00Z' }),
      row({ name_snapshot: 'Porridge', logged_at: '2026-09-06T08:00:00Z', grams: 250 }),
    ]);

    expect(out.map((f) => f.name)).toEqual(['Porridge', 'Eggs']);
    // The most recent logging is the one whose amount gets remembered.
    expect(out[0].default_serving_g).toBe(250);
    expect(out[0].count).toBe(2);
  });

  it('treats the same name from different brands as different foods', () => {
    const out = recentFoods([
      row({ brand_snapshot: 'Flahavans' }),
      row({ brand_snapshot: 'Odlums', logged_at: '2026-09-07T08:00:00Z' }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('skips entries with no weight to derive from', () => {
    // Quick adds have no grams — the Quick add card already covers those.
    const out = recentFoods([row({ grams: 0 }), row({ grams: null })]);
    expect(out).toEqual([]);
  });

  it('skips entries with no calories', () => {
    expect(recentFoods([row({ kcal: 0 })])).toEqual([]);
  });

  it('caps the list', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      row({ name_snapshot: `Food ${i}`, logged_at: `2026-09-${String((i % 28) + 1).padStart(2, '0')}T08:00:00Z` }),
    );
    expect(recentFoods(many, 6)).toHaveLength(6);
  });
});

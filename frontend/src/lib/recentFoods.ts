import type { Food } from './types';

/** Recently logged foods, rebuilt from the diary.
 *
 * People eat the same twenty or thirty things over and over, so opening the
 * log screen on a bare "type at least 2 characters" prompt makes the common
 * case the slowest one. Diary entries carry a snapshot of what was logged, so
 * the recents list needs no new storage — only the per-100g values derived
 * back out of the amount that was recorded.
 *
 * Entries without a weight (quick adds) are skipped: there is nothing to
 * derive per-100g values from, and the Quick add card already covers them. */

export interface DiaryHistoryRow {
  name_snapshot?: string;
  brand_snapshot?: string;
  grams?: number | null;
  kcal?: number | null;
  protein?: number | null;
  carbs?: number | null;
  fat?: number | null;
  logged_at?: string;
}

export interface RecentFood extends Food {
  /** How many times this food appears in the history window. */
  count: number;
  last_logged_at: string;
}

const per100 = (value: number, grams: number) => Math.round((value / grams) * 100 * 10) / 10;

export function recentFoods(history: DiaryHistoryRow[], limit = 8): RecentFood[] {
  const byFood = new Map<string, RecentFood>();

  for (const row of history) {
    const name = (row.name_snapshot ?? '').trim();
    const grams = Number(row.grams ?? 0);
    const kcal = Number(row.kcal ?? 0);
    if (!name || !(grams > 0) || !(kcal > 0)) continue;

    const brand = (row.brand_snapshot ?? '').trim();
    const key = `${name.toLowerCase()}|${brand.toLowerCase()}`;
    const loggedAt = row.logged_at ?? '';
    const existing = byFood.get(key);

    if (existing) {
      existing.count += 1;
      // Keep the newest logging's amount — that's what to pre-fill.
      if (loggedAt > existing.last_logged_at) {
        existing.last_logged_at = loggedAt;
        existing.default_serving_g = grams;
        existing.kcal_per_100g = per100(kcal, grams);
        existing.protein_per_100g = per100(Number(row.protein ?? 0), grams);
        existing.carbs_per_100g = per100(Number(row.carbs ?? 0), grams);
        existing.fat_per_100g = per100(Number(row.fat ?? 0), grams);
      }
      continue;
    }

    byFood.set(key, {
      name,
      brand,
      kcal_per_100g: per100(kcal, grams),
      protein_per_100g: per100(Number(row.protein ?? 0), grams),
      carbs_per_100g: per100(Number(row.carbs ?? 0), grams),
      fat_per_100g: per100(Number(row.fat ?? 0), grams),
      default_serving_g: grams,
      local: true,
      count: 1,
      last_logged_at: loggedAt,
    } as RecentFood);
  }

  return [...byFood.values()]
    .sort((a, b) => (a.last_logged_at < b.last_logged_at ? 1 : -1))
    .slice(0, limit);
}

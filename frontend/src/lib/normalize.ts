import type { Food, Summary, SummaryGroup } from './types';

/** Normalize API responses that may come in either the documented shape or the
 * backend's evolved shape. Keeps screens agnostic to contract drift. */

interface RawSummaryLike {
  budget?: number | null;
  budget_message?: string | null;
  tdee?: number | null;
  goal?: string;
  groups?: SummaryGroup[];
  slots?: Array<{
    id: string;
    name: string;
    sort_order: number;
    pct_allocation?: number | null;
    entries: SummaryGroup['entries'];
    totals?: { kcal: number; protein: number; carbs: number; fat: number };
  }>;
  totals?: { kcal: number; protein: number; carbs: number; fat: number };
}

export function normalizeSummary(raw: RawSummaryLike): Summary {
  const groups: SummaryGroup[] =
    raw.groups ??
    (raw.slots ?? []).map((s) => ({
      slot_id: s.id,
      slot_name: s.name,
      sort_order: s.sort_order,
      entries: s.entries ?? [],
    }));
  const totals =
    raw.totals ??
    groups.reduce(
      (acc, g) => ({
        kcal: acc.kcal + g.entries.reduce((s, e) => s + e.kcal, 0),
        protein: acc.protein + g.entries.reduce((s, e) => s + e.protein, 0),
        carbs: acc.carbs + g.entries.reduce((s, e) => s + e.carbs, 0),
        fat: acc.fat + g.entries.reduce((s, e) => s + e.fat, 0),
      }),
      { kcal: 0, protein: 0, carbs: 0, fat: 0 },
    );
  return {
    budget: raw.budget ?? null,
    tdee: raw.tdee ?? null,
    goal: raw.goal ?? 'maintain',
    groups,
    totals,
  };
}

interface RawSearchLike {
  results?: Food[];
  local?: Food[];
  remote?: Food[];
}

export function normalizeSearch(raw: RawSearchLike): Food[] {
  if (raw.results) return raw.results;
  return [...(raw.local ?? []), ...(raw.remote ?? [])];
}

/** Barcode lookup may return the food directly or wrapped as {product: {...}}. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeBarcode(raw: any): Food | null {
  const f = raw?.product ?? raw;
  if (!f || !f.name) return null;
  return f as Food;
}

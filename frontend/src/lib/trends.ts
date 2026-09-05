import type PocketBase from 'pocketbase';
import { saolrianSend } from './pb';
import type { TrendsPayload, TrendDay } from './types';

export type CardId =
  | 'weight'
  | 'tdee'
  | 'intake'
  | 'balance'
  | 'consistency'
  | 'macros'
  | 'weekday'
  | 'meals'
  | 'water'
  | 'steps';

export interface CardMeta {
  id: CardId;
  title: string;
  /** One line describing what the card answers, shown in the customise sheet. */
  blurb: string;
  /** Days of range needed before the card renders instead of a stub. */
  minDays: number;
}

export const ALL_CARDS: CardMeta[] = [
  { id: 'weight', title: 'Weight trend', blurb: 'Weigh-ins, smoothed line, and the fitted rate', minDays: 7 },
  { id: 'tdee', title: 'Observed TDEE', blurb: 'What your own data says you burn', minDays: 14 },
  { id: 'intake', title: 'Intake vs budget', blurb: 'Daily calories against your target', minDays: 7 },
  { id: 'balance', title: 'Energy balance', blurb: 'Cumulative deficit or surplus, and what it predicts', minDays: 14 },
  { id: 'consistency', title: 'Logging consistency', blurb: 'Which days you logged', minDays: 7 },
  { id: 'macros', title: 'Macros', blurb: 'Protein, carbs and fat against your split', minDays: 7 },
  { id: 'weekday', title: 'Weekday pattern', blurb: 'Average intake by day of the week', minDays: 21 },
  { id: 'meals', title: 'Meal distribution', blurb: 'How your calories spread across meals', minDays: 7 },
  { id: 'water', title: 'Water', blurb: 'Daily water against your target', minDays: 7 },
  { id: 'steps', title: 'Steps', blurb: 'Daily steps and a rolling average', minDays: 7 },
];

/** Five on by default. A new user should not land on ten charts. */
export const DEFAULT_CARDS: CardId[] = ['weight', 'tdee', 'intake', 'balance', 'consistency'];

const KNOWN = new Set<string>(ALL_CARDS.map((c) => c.id));

/** Resolve the profile's stored `trend_cards` into an ordered card list.
 *
 * Null or absent means "never set" and yields the defaults, which is what
 * makes every pre-existing profile correct with no backfill. An explicitly
 * empty array is different: the user turned everything off, and we honour it.
 * Unknown ids are dropped rather than throwing, so a profile written by a
 * newer build degrades quietly on an older one. */
export function resolveCards(raw: unknown): CardId[] {
  if (!Array.isArray(raw)) return [...DEFAULT_CARDS];
  const seen = new Set<string>();
  const out: CardId[] = [];
  for (const v of raw) {
    if (typeof v !== 'string' || !KNOWN.has(v) || seen.has(v)) continue;
    seen.add(v);
    out.push(v as CardId);
  }
  return out;
}

export async function fetchTrends(pb: PocketBase, days: number): Promise<TrendsPayload> {
  return saolrianSend<TrendsPayload>(pb, 'GET', `/api/saolrian/trends?days=${days}`);
}

const KCAL_PER_KG = 7700;

/** Daily intake, with unlogged days as null so charts leave a gap instead of
 * drawing a zero the user never ate. */
export function intakeSeries(p: TrendsPayload): { values: (number | null)[]; budget: number | null } {
  return {
    values: p.days.map((d: TrendDay) => (d.logged ? d.kcal : null)),
    budget: p.budget,
  };
}

/** Trailing mean over `window` positions, ignoring nulls. Null until the
 * window contains at least one value. */
export function movingAverage(values: (number | null)[], window: number): (number | null)[] {
  return values.map((_, i) => {
    const slice = values.slice(Math.max(0, i - window + 1), i + 1).filter((v): v is number => v != null);
    if (slice.length === 0) return null;
    return slice.reduce((s, v) => s + v, 0) / slice.length;
  });
}

/** Cumulative energy balance: Σ(intake − TDEE) over logged days.
 *
 * Unlogged days hold the running total flat rather than assuming a deficit —
 * we have no idea what happened on those days, and inventing one would make
 * the reconciliation against actual weight change meaningless. */
export function balanceSeries(p: TrendsPayload): {
  values: number[];
  predictedKg: number;
  reference: 'observed' | 'formula';
  referenceTdee: number;
} {
  const useObserved = p.estimate.sufficient;
  const tdeeRef = useObserved ? p.estimate.observed_tdee : (p.formula_tdee ?? 0);

  let running = 0;
  const values = p.days.map((d: TrendDay) => {
    if (d.logged && tdeeRef > 0) running += d.kcal - tdeeRef;
    return running;
  });

  return {
    values,
    predictedKg: running / KCAL_PER_KG,
    reference: useObserved ? 'observed' : 'formula',
    referenceTdee: tdeeRef,
  };
}

/** Grade each day 0-3 by how much of the budget was logged, for the heatmap.
 * Level 0 is "nothing logged", which renders as an empty cell. */
export function consistencyCells(p: TrendsPayload): { date: string; level: 0 | 1 | 2 | 3 }[] {
  const budget = p.budget ?? 2000;
  return p.days.map((d: TrendDay) => {
    if (!d.logged) return { date: d.date, level: 0 as const };
    const frac = d.kcal / budget;
    if (frac < 0.35) return { date: d.date, level: 1 as const };
    if (frac < 0.75) return { date: d.date, level: 2 as const };
    return { date: d.date, level: 3 as const };
  });
}

/** Mean intake per weekday, index 0 = Sunday. Unlogged days are excluded, so a
 * skipped Sunday does not read as a 0 kcal Sunday. NaN-free: a weekday with no
 * logged days returns 0 and the card renders it as absent. */
export function weekdayAverages(p: TrendsPayload): number[] {
  const sums = new Array(7).fill(0);
  const counts = new Array(7).fill(0);
  for (const d of p.days) {
    if (!d.logged) continue;
    // Parse as UTC to match the payload's bucketing.
    const idx = new Date(`${d.date}T00:00:00Z`).getUTCDay();
    sums[idx] += d.kcal;
    counts[idx] += 1;
  }
  return sums.map((s, i) => (counts[i] > 0 ? s / counts[i] : 0));
}

/** Average kcal per meal slot across the range, as StackedBar rows. */
export function mealRows(p: TrendsPayload): { label: string; parts: { label: string; value: number }[] }[] {
  const totals = new Map<string, number>();
  let loggedDays = 0;
  for (const d of p.days) {
    if (!d.logged) continue;
    loggedDays += 1;
    for (const [slotId, kcal] of Object.entries(d.by_slot)) {
      totals.set(slotId, (totals.get(slotId) ?? 0) + kcal);
    }
  }
  if (loggedDays === 0) return [];

  const parts = p.slots.map((s) => ({
    label: s.name,
    value: (totals.get(s.id) ?? 0) / loggedDays,
  }));
  return [{ label: 'Average day', parts }];
}

/** Label roughly six evenly spaced positions and blank the rest, so the axis
 * stays readable at 30, 90 and 365 days without measuring text. */
export function sparseLabels(dates: string[]): string[] {
  if (dates.length === 0) return [];
  const step = Math.max(1, Math.ceil(dates.length / 6));
  return dates.map((d, i) => (i % step === 0 ? d.slice(5) : ''));
}

/** The fitted regression line across the estimate window, as a series aligned
 * to the full day range — the visual proof of where the TDEE number came from.
 * Null outside the window so the line is drawn only where it applies. */
export function regressionOverlay(p: TrendsPayload): (number | null)[] {
  if (!p.estimate.sufficient || p.ema.length === 0) return p.days.map(() => null);

  const windowStart = Math.max(0, p.days.length - p.estimate.window_days);
  const slopePerDay = p.estimate.slope_kg_per_week / 7;

  // Anchor the line at the EMA value on the window's first day, so the overlay
  // sits on the trend rather than floating away from it.
  const startDate = p.days[windowStart]?.date;
  const anchor = p.ema.find((e) => e.date === startDate)?.kg ?? p.ema[0].kg;

  return p.days.map((_, i) => (i < windowStart ? null : anchor + slopePerDay * (i - windowStart)));
}

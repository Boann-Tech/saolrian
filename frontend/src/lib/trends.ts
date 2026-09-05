import type PocketBase from 'pocketbase';
import { saolrianSend } from './pb';
import type { TrendsPayload } from './types';

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

import type { MealSlot } from './types';

/** Which meal slot a new entry most likely belongs to, given the time of day.
 *
 * Defaulting to slots[0] meant every entry after breakfast needed a deliberate
 * extra tap — and a missed tap filed food under the wrong meal silently, which
 * only shows up later in the meal-split trend.
 *
 * Slots are user-defined ("second breakfast", "pre-workout"), so nothing here
 * hardcodes meal names: the usual time of a slot is learned from when the user
 * actually logs into it, and falls back to spreading the slots evenly across
 * the waking day. */

/** The window a day's meals are assumed to sit in, when we know nothing else. */
const WAKING_START = 7;
const WAKING_END = 22;

export interface LoggedAt {
  meal_slot: string;
  logged_at: string;
}

/** Fractional hour of a timestamp, in local time. */
function hourOf(iso: string): number | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.getHours() + d.getMinutes() / 60;
}

export function defaultSlotForTime(
  slots: MealSlot[],
  history: LoggedAt[],
  now: Date = new Date(),
): string | null {
  if (slots.length === 0) return null;
  const ordered = [...slots].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const nowHour = now.getHours() + now.getMinutes() / 60;

  // Mean logging hour per slot, over whatever history we were given.
  const sums = new Map<string, { total: number; n: number }>();
  for (const row of history) {
    const h = hourOf(row.logged_at);
    if (h == null) continue;
    const acc = sums.get(row.meal_slot) ?? { total: 0, n: 0 };
    acc.total += h;
    acc.n += 1;
    sums.set(row.meal_slot, acc);
  }

  const known = ordered
    .map((s) => {
      const acc = sums.get(s.id);
      return acc && acc.n > 0 ? { id: s.id, hour: acc.total / acc.n } : null;
    })
    .filter((v): v is { id: string; hour: number } => v !== null);

  if (known.length > 0) {
    let best = known[0];
    for (const candidate of known) {
      if (Math.abs(candidate.hour - nowHour) < Math.abs(best.hour - nowHour)) best = candidate;
    }
    return best.id;
  }

  // No history: divide the waking day into one block per slot, and clamp
  // anything outside it to the first or last block.
  const span = (WAKING_END - WAKING_START) / ordered.length;
  const index = Math.floor((nowHour - WAKING_START) / span);
  return ordered[Math.min(ordered.length - 1, Math.max(0, index))].id;
}

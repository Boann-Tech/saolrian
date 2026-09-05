import { describe, it, expect } from 'vitest';
import { ALL_CARDS, DEFAULT_CARDS, resolveCards } from './trends';

describe('resolveCards', () => {
  it('falls back to defaults when the profile has never been set', () => {
    expect(resolveCards(null)).toEqual(DEFAULT_CARDS);
    expect(resolveCards(undefined)).toEqual(DEFAULT_CARDS);
  });

  it('falls back to defaults for a non-array value', () => {
    expect(resolveCards('weight')).toEqual(DEFAULT_CARDS);
    expect(resolveCards({ weight: true })).toEqual(DEFAULT_CARDS);
  });

  it('treats an explicitly empty array as "all cards off"', () => {
    // Distinct from "never set" — the user turned everything off on purpose.
    expect(resolveCards([])).toEqual([]);
  });

  it('preserves the stored order', () => {
    expect(resolveCards(['intake', 'weight'])).toEqual(['intake', 'weight']);
  });

  it('drops ids it does not recognise', () => {
    // A profile written by a newer build must degrade quietly on an older one.
    expect(resolveCards(['weight', 'nonsense', 'intake'])).toEqual(['weight', 'intake']);
  });

  it('drops duplicates, keeping the first position', () => {
    expect(resolveCards(['weight', 'intake', 'weight'])).toEqual(['weight', 'intake']);
  });
});

describe('ALL_CARDS', () => {
  it('has a unique id for every card', () => {
    const ids = ALL_CARDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('defaults are all real cards', () => {
    const ids = new Set(ALL_CARDS.map((c) => c.id));
    for (const id of DEFAULT_CARDS) expect(ids.has(id)).toBe(true);
  });
});

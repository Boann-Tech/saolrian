import { describe, it, expect } from 'vitest';
import { defaultSlotForTime } from '../slotDefault';
import type { MealSlot } from '../types';

const slots = [
  { id: 'b', name: 'Breakfast', sort_order: 1 },
  { id: 'l', name: 'Lunch', sort_order: 2 },
  { id: 'd', name: 'Dinner', sort_order: 3 },
] as MealSlot[];

const at = (hour: number) => new Date(2026, 8, 7, hour, 0, 0);
const logged = (slot: string, hour: number) => ({
  meal_slot: slot,
  logged_at: new Date(2026, 8, 1, hour, 0, 0).toISOString(),
});

describe('defaultSlotForTime — learned from the user’s own history', () => {
  const history = [
    logged('b', 8), logged('b', 7),
    logged('l', 13), logged('l', 12),
    logged('d', 19), logged('d', 20),
  ];

  it('picks the slot whose usual time is nearest to now', () => {
    expect(defaultSlotForTime(slots, history, at(8))).toBe('b');
    expect(defaultSlotForTime(slots, history, at(12))).toBe('l');
    expect(defaultSlotForTime(slots, history, at(19))).toBe('d');
  });

  it('resolves times between two meals to the closer one', () => {
    // Breakfast averages 7.5, lunch 12.5 — 10am is nearer breakfast.
    expect(defaultSlotForTime(slots, history, at(10))).toBe('b');
    expect(defaultSlotForTime(slots, history, at(11))).toBe('l');
  });

  it('ignores slots the user has never logged into', () => {
    const withUnused = [...slots, { id: 'x', name: 'Supper', sort_order: 4 } as MealSlot];
    expect(defaultSlotForTime(withUnused, history, at(21))).toBe('d');
  });
});

describe('defaultSlotForTime — without history', () => {
  it('spreads the slots evenly across the waking day', () => {
    // Three slots across 07:00–22:00 => breakfast, lunch, dinner blocks.
    expect(defaultSlotForTime(slots, [], at(8))).toBe('b');
    expect(defaultSlotForTime(slots, [], at(14))).toBe('l');
    expect(defaultSlotForTime(slots, [], at(20))).toBe('d');
  });

  it('clamps before and after the waking day to the first and last slot', () => {
    expect(defaultSlotForTime(slots, [], at(4))).toBe('b');
    expect(defaultSlotForTime(slots, [], at(23))).toBe('d');
  });

  it('returns null when there are no slots at all', () => {
    expect(defaultSlotForTime([], [], at(12))).toBeNull();
  });

  it('honours sort order, not array order', () => {
    const shuffled = [
      { id: 'd', name: 'Dinner', sort_order: 3 },
      { id: 'b', name: 'Breakfast', sort_order: 1 },
      { id: 'l', name: 'Lunch', sort_order: 2 },
    ] as MealSlot[];
    expect(defaultSlotForTime(shuffled, [], at(8))).toBe('b');
  });
});

import { describe, it, expect } from 'vitest';
import { addMonths, monthTitle, monthGrid, dateFromOffset } from '../format';

describe('addMonths', () => {
  it('moves forward and back by whole months', () => {
    expect(addMonths('2026-09-01', 1)).toBe('2026-10-01');
    expect(addMonths('2026-09-01', -1)).toBe('2026-08-01');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
  });

  it('clamps to the last day when the target month is shorter', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
  });
});

describe('monthTitle', () => {
  it('formats the month and year in full', () => {
    expect(monthTitle('2026-09-15')).toBe('September 2026');
  });
});

describe('monthGrid', () => {
  it('returns 6 Sunday-first weeks that cover the whole month', () => {
    const grid = monthGrid('2026-09-15');
    expect(grid).toHaveLength(6);
    for (const week of grid) {
      expect(week).toHaveLength(7);
      expect(new Date(week[0] + 'T12:00:00').getDay()).toBe(0);
    }

    const flat = grid.flat();
    expect(flat).toContain('2026-09-01');
    expect(flat).toContain('2026-09-30');
    expect(flat[0] <= '2026-09-01').toBe(true);
    expect(flat[0] > '2026-08-24').toBe(true);

    for (let i = 1; i < flat.length; i++) {
      expect(flat[i]).toBe(dateFromOffset(1, flat[i - 1]));
    }
  });
});

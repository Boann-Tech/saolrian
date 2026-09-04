import { describe, it, expect } from 'vitest';
import { toIsoDate, parseLoseItCsv } from './loseit';

describe('toIsoDate', () => {
  it('converts LoseIt MM/DD/YYYY dates to YYYY-MM-DD', () => {
    expect(toIsoDate('05/02/2023')).toBe('2023-05-02');
    expect(toIsoDate('12/1/2026')).toBe('2026-12-01');
  });

  it('passes through an already-ISO date unchanged', () => {
    expect(toIsoDate('2026-04-04')).toBe('2026-04-04');
  });
});

describe('parseLoseItCsv', () => {
  it('emits ISO dates so the backend\'s time.Parse("2006-01-02", ...) succeeds', () => {
    const csv = 'Date,Name,Meal,Quantity,Units,Calories\n05/02/2023,Toast,Breakfast,1,Servings,200\n';
    const rows = parseLoseItCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe('2023-05-02');
  });
});

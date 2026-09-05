import { describe, it, expect } from 'vitest';
import {
  ALL_CARDS,
  DEFAULT_CARDS,
  resolveCards,
  intakeSeries,
  balanceSeries,
  consistencyCells,
  weekdayAverages,
  movingAverage,
  sparseLabels,
} from './trends';
import type { TrendsPayload, TrendDay } from './types';

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

function day(date: string, kcal: number, logged = kcal > 0): TrendDay {
  return {
    date, kcal, protein: 0, carbs: 0, fat: 0,
    entries: logged ? 1 : 0, logged, water_ml: 0, steps: 0, by_slot: {},
  };
}

function payload(days: TrendDay[], over: Partial<TrendsPayload> = {}): TrendsPayload {
  return {
    range: { from: days[0]?.date ?? '2026-01-01', to: days.at(-1)?.date ?? '2026-01-01', days: days.length },
    days, weights: [], ema: [], budget: 2000, formula_tdee: 2200,
    goal: 'lose', goal_rate: -0.5, target_source: '', target_set_at: '',
    targets: { protein_g: 150, carbs_g: 200, fat_g: 60, water_ml: 2000, steps: 10000 },
    slots: [],
    estimate: {
      sufficient: false, reason: 'no_data', window_days: 28, observed_tdee: 0,
      margin: 0, slope_kg_per_week: 0, mean_intake: 0, qualifying_days: 0,
      weigh_ins: 0, span_days: 0, suggested_target: 0,
    },
    ...over,
  };
}

describe('intakeSeries', () => {
  it('gives an unlogged day null, not zero', () => {
    const p = payload([day('2026-01-01', 2000), day('2026-01-02', 0, false)]);
    expect(intakeSeries(p).values).toEqual([2000, null]);
  });
});

describe('movingAverage', () => {
  it('averages only the non-null values in the window', () => {
    expect(movingAverage([2, null, 4], 3)?.at(-1)).toBeCloseTo(3);
  });

  it('is null until the window has any data', () => {
    expect(movingAverage([null, null], 2)).toEqual([null, null]);
  });
});

describe('balanceSeries', () => {
  it('accumulates intake minus TDEE across logged days only', () => {
    const p = payload(
      [day('2026-01-01', 1500), day('2026-01-02', 0, false), day('2026-01-03', 1500)],
      {
        estimate: {
          sufficient: true, reason: '', window_days: 28, observed_tdee: 2000,
          margin: 100, slope_kg_per_week: -0.5, mean_intake: 1500,
          qualifying_days: 2, weigh_ins: 10, span_days: 25, suggested_target: 1450,
        },
      },
    );
    const s = balanceSeries(p);
    // -500 on day 1, unchanged across the unlogged day, -1000 by day 3.
    expect(s.values[0]).toBeCloseTo(-500);
    expect(s.values[1]).toBeCloseTo(-500);
    expect(s.values[2]).toBeCloseTo(-1000);
    expect(s.predictedKg).toBeCloseTo(-1000 / 7700);
    expect(s.reference).toBe('observed');
  });

  it('falls back to the formula TDEE when the estimate is insufficient', () => {
    const p = payload([day('2026-01-01', 1500)]);
    expect(balanceSeries(p).reference).toBe('formula');
  });
});

describe('consistencyCells', () => {
  it('grades a day by how much of the budget was logged', () => {
    const p = payload([day('2026-01-01', 0, false), day('2026-01-02', 500), day('2026-01-03', 1900)]);
    expect(consistencyCells(p).map((c) => c.level)).toEqual([0, 1, 3]);
  });
});

describe('weekdayAverages', () => {
  it('averages by day of week over logged days only', () => {
    // 2026-01-01 is a Thursday.
    const p = payload([
      day('2026-01-01', 2000), day('2026-01-08', 3000),
      day('2026-01-02', 1000), day('2026-01-09', 0, false),
    ]);
    const avgs = weekdayAverages(p);
    expect(avgs[4]).toBeCloseTo(2500); // Thursday
    expect(avgs[5]).toBeCloseTo(1000); // Friday, ignoring the unlogged day
  });
});

describe('sparseLabels', () => {
  it('labels roughly six positions and blanks the rest', () => {
    const dates = Array.from({ length: 30 }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`);
    const labels = sparseLabels(dates);
    expect(labels).toHaveLength(30);
    expect(labels.filter(Boolean).length).toBeLessThanOrEqual(7);
    expect(labels[0]).toBeTruthy();
  });
});

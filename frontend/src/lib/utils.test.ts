import { describe, it, expect } from 'vitest';
import {
  computeBmr,
  computeTdee,
  computeCalorieTarget,
  macroSplit,
  foodMath,
  ACTIVITY_FACTORS,
} from './nutrition';
import { parseLoseItCsv } from './loseit';
import { formatNumber, todayISO, dateFromOffset } from './format';
import { toCsv, buildExportFilename } from './export';

const adult = {
  height_cm: 180,
  birth_year: 1990,
  sex: 'male' as const,
  activity_level: 'moderate' as const,
  body_fat_pct: null,
  weight_kg: 80,
  tdee_formula: 'mifflin' as const,
};

describe('nutrition math (must mirror the Go backend)', () => {
  it('computes Mifflin-St Jeor BMR', () => {
    // 10*80 + 6.25*180 - 5*36 + 5 = 800 + 1125 - 180 + 5 = 1750
    expect(computeBmr(adult)).toBe(1750);
  });

  it('computes Katch-McArdle BMR from lean mass', () => {
    const p = { ...adult, body_fat_pct: 20, tdee_formula: 'katch' as const };
    // 370 + 21.6*(80*0.8) = 370 + 1382.4 = 1752.4
    expect(computeBmr(p, 'katch')).toBeCloseTo(1752.4, 5);
  });

  it('scales BMR by activity factor and returns null when data is missing', () => {
    expect(computeTdee(adult)).toBeCloseTo(1750 * ACTIVITY_FACTORS.moderate, 5);
    expect(computeTdee({ ...adult, weight_kg: null })).toBeNull();
  });

  it('applies goal adjustments', () => {
    const tdee = computeTdee(adult)!;
    expect(computeCalorieTarget(adult, 'maintain')).toBe(tdee);
    expect(computeCalorieTarget(adult, 'lose')).toBe(tdee - 500);
    expect(computeCalorieTarget(adult, 'gain')).toBe(tdee + 350);
  });

  it('clamps carbs to 0% when protein+fat exceed 100', () => {
    // 2000 kcal: protein 40% = 800, fat 70% = 1400, carbs clamped to 0
    expect(macroSplit(2000, 40, 70)).toMatchObject({ carbsPct: 0, proteinKcal: 800, fatKcal: 1400 });
  });

  it('computes per-serving food math', () => {
    expect(foodMath(250, 10, 30, 8, 150)).toEqual({ kcal: 375, protein: 15, carbs: 45, fat: 12 });
  });
});

describe('Lose It! CSV parser', () => {
  it('parses a standard export with header detection and column mapping', () => {
    const csv = [
      'Date,Name,Quantity,Units,Meal,Calories,Fat (g),Protein (g),Carbohydrates (g)',
      '2026-08-01,Oats,1,serving,Breakfast,150,3,5,27',
      '2026-08-01,Chicken breast,200,g,Lunch,330,7,62,0',
    ].join('\n');
    const rows = parseLoseItCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      date: '2026-08-01',
      name: 'Oats',
      quantity: 1,
      unit: 'serving',
      meal: 'Breakfast',
      kcal: 150,
      protein_g: 5,
      carbs_g: 27,
      fat_g: 3,
    });
    expect(rows[1].kcal).toBe(330);
  });

  it('skips blank lines and non-data rows without a name', () => {
    const csv = 'Date,Name,Quantity,Units,Meal,Calories,Fat (g),Protein (g),Carbohydrates (g)\n\n,\n';
    expect(parseLoseItCsv(csv)).toHaveLength(0);
  });

  it('handles decimal quantities', () => {
    const csv =
      'Date,Name,Quantity,Units,Meal,Calories,Fat (g),Protein (g),Carbohydrates (g)\n2026-08-02,Apple,1.5,fruit,Snacks,95,0.3,0.5,25';
    expect(parseLoseItCsv(csv)[0].quantity).toBe(1.5);
  });

  it('handles quoted fields containing commas', () => {
    const csv =
      'Date,Name,Quantity,Units,Meal,Calories,Fat (g),Protein (g),Carbohydrates (g)\n2026-08-02,"Soup, tomato",1,bowl,Lunch,120,2,4,18';
    const rows = parseLoseItCsv(csv);
    expect(rows[0].name).toBe('Soup, tomato');
  });

  it('returns empty array when no recognizable header exists', () => {
    expect(parseLoseItCsv('random,junk\n1,2')).toEqual([]);
  });
});

describe('format helpers', () => {
  it('formats numbers with Intl.NumberFormat', () => {
    expect(formatNumber(8340)).toBe('8,340');
    expect(formatNumber(1720.25, { maximumFractionDigits: 1 })).toBe('1,720.3');
  });

  it('produces local ISO dates', () => {
    expect(todayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(todayISO()).toBe(dateFromOffset(0));
  });

  it('steps dates across month boundaries', () => {
    const d = dateFromOffset(-1, '2026-03-01');
    expect(d).toBe('2026-02-28');
  });
});

describe('diary export', () => {
  it('serializes entries to CSV with quoting', () => {
    const csv = toCsv([
      {
        name: 'Soup, tomato',
        brand: 'Cup-a',
        meal: 'Lunch',
        grams: 250,
        kcal: 180,
        protein: 6,
        carbs: 22,
        fat: 7,
        logged_at: '2026-09-01',
      },
    ]);
    expect(csv).toContain('"Soup, tomato"');
    expect(csv.split('\n')[0]).toContain('kcal');
    expect(csv).toContain('2026-09-01');
  });

  it('builds a dated filename', () => {
    expect(buildExportFilename('2026-09-03')).toBe('saolrian-diary-2026-09-03.csv');
  });
});

import { describe, it, expect } from 'vitest';
import { toIsoDate, parseLoseItCsv, parseDateValueCsv, parseLoseItWeightCsv, parseLoseItExerciseCsv, parseLoseItFoodCatalogCsv, parseLoseItProfileCsv } from './loseit';

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

  it('skips rows marked Deleted (1/true/yes, case-insensitive)', () => {
    const csv =
      'Date,Name,Meal,Quantity,Units,Calories,Deleted\n' +
      '05/02/2023,Toast,Breakfast,1,Servings,200,0\n' +
      '05/03/2023,Bagel,Breakfast,1,Servings,250,1\n' +
      '05/04/2023,Eggs,Breakfast,2,Servings,150,true\n' +
      '05/05/2023,Bacon,Breakfast,3,Servings,300,TRUE\n';
    const rows = parseLoseItCsv(csv);
    expect(rows.map((r) => r.name)).toEqual(['Toast']);
  });
});

describe('parseDateValueCsv', () => {
  it('parses steps/water/body-fat/sleep-shaped CSVs', () => {
    const csv = 'Date,Value,Secondary Value,Last Updated\n04/04/2026,8416.0,0.0,2026-04-04T00:00:00+0100\n';
    const rows = parseDateValueCsv(csv);
    expect(rows).toEqual([{ date: '2026-04-04', value: 8416 }]);
  });
});

describe('parseLoseItWeightCsv', () => {
  it('parses weight rows and skips deleted ones', () => {
    const csv = 'Date,Weight,Last Updated,Deleted\n05/02/2023,91.99,2023-05-02T23:21:13+0100,false\n05/03/2023,90.5,2023-05-03T00:00:00+0100,true\n';
    const rows = parseLoseItWeightCsv(csv);
    expect(rows).toEqual([{ date: '2023-05-02', kg: 91.99 }]);
  });
});

describe('parseLoseItExerciseCsv', () => {
  it('parses minutes-based exercise rows and skips deleted ones', () => {
    const csv = 'Date,Name,Icon,Type,Quantity,Units,Calories,Deleted\n05/05/2023,Garmin Adjustment,Garmin,Exercise,30,minutes,-176.0,0\n05/06/2023,Run,Run,Exercise,20,minutes,150,1\n';
    const rows = parseLoseItExerciseCsv(csv);
    expect(rows).toEqual([{ date: '2023-05-05', name: 'Garmin Adjustment', minutes: 30, kcal: -176 }]);
  });
});

describe('parseLoseItFoodCatalogCsv', () => {
  it('parses custom-foods.csv rows (has Brand)', () => {
    const csv =
      'Name,UniqueId,Brand,Image,Quantity,Measure,Calories,Fat (g),Protein (g),Carbohydrates (g),Saturated Fat (g),Sugars (g),Fiber (g),Cholesterol (mg),Sodium (mg)\n' +
      'Black Bean Sauce,abc123,WAI MAI,Sauce,500,Grams,300,5,10,40,1,50,2,0,9\n';
    const rows = parseLoseItFoodCatalogCsv(csv);
    expect(rows).toEqual([
      { name: 'Black Bean Sauce', unique_id: 'abc123', brand: 'WAI MAI', quantity: 500, measure: 'Grams', kcal: 300, protein_g: 10, carbs_g: 40, fat_g: 5 },
    ]);
  });

  it('parses recipes.csv rows (no Brand column)', () => {
    const csv =
      'Name,UniqueId,Quantity,Measure,Author,Image Name,Calories,Fat (g),Protein (g),Carbohydrates (g),Saturated Fat (g),Sugars (g),Fiber (g),Cholesterol (mg),Sodium (mg)\n' +
      'Chicken Satay,def456,6,Serving,,Recipe,900,120,240,60,45,92,0,132\n';
    const rows = parseLoseItFoodCatalogCsv(csv);
    expect(rows).toEqual([
      { name: 'Chicken Satay', unique_id: 'def456', brand: '', quantity: 6, measure: 'Serving', kcal: 900, protein_g: 240, carbs_g: 60, fat_g: 120 },
    ]);
  });
});

describe('parseLoseItProfileCsv', () => {
  it('maps LoseIt profile.csv key/value pairs to this app\'s enums', () => {
    const csv = [
      'Name,Value',
      'Birthday,06/06/1990',
      'Gender,Male',
      'Height,178.0',
      'Calorie Adjustment,0.0',
      'Current EER,2383.33',
      'Plan,maintain',
      'Activity Level,Somewhat Active',
    ].join('\n');
    const snap = parseLoseItProfileCsv(csv);
    expect(snap).toEqual({
      birth_year: 1990,
      sex: 'male',
      height_cm: 178,
      goal: 'maintain',
      activity_level: 'moderate',
    });
  });

  it('includes calorie_target only when LoseIt records a non-zero adjustment', () => {
    const csv = ['Name,Value', 'Calorie Adjustment,150', 'Current EER,2400'].join('\n');
    const snap = parseLoseItProfileCsv(csv);
    expect(snap.calorie_target).toBe(2550);
  });
});

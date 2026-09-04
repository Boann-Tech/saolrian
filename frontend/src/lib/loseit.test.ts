import { describe, it, expect } from 'vitest';
import { toIsoDate, parseLoseItCsv, parseDateValueCsv, parseLoseItWeightCsv, parseLoseItExerciseCsv } from './loseit';

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

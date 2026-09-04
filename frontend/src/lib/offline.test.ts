import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createDiaryEntry } from './offline';

const created: Record<string, unknown>[] = [];
const fakePb = {
  collection: (name: string) => {
    if (name !== 'diary_entries') throw new Error(`unexpected collection ${name}`);
    return {
      create: async (data: Record<string, unknown>) => {
        created.push(data);
        return { id: 'entry-1', ...data };
      },
    };
  },
};

vi.mock('./pb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pb')>();
  return { ...actual, getClient: () => fakePb };
});

beforeEach(() => {
  created.length = 0;
  localStorage.clear();
});

describe('createDiaryEntry source override', () => {
  it('defaults to source "manual"', async () => {
    const result = await createDiaryEntry('http://localhost:8090', 'user-1', {
      name_snapshot: 'Oats',
      meal_slot: 'slot-1',
      kcal: 150,
    });
    expect(result).toEqual({ ok: true, queued: false });
    expect(created[0]).toMatchObject({ source: 'manual', user: 'user-1', name_snapshot: 'Oats' });
  });

  it('passes a custom source through', async () => {
    await createDiaryEntry(
      'http://localhost:8090',
      'user-1',
      { name_snapshot: 'Chili', meal_slot: 'slot-1', kcal: 400 },
      'recipe',
    );
    expect(created[0]).toMatchObject({ source: 'recipe' });
  });
});

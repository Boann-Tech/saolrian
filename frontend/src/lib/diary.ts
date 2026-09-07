import type PocketBase from 'pocketbase';

/** Fields that make a diary entry what it is — everything needed to put one
 *  back exactly as it was. Kept in one place so an undo can't quietly drop
 *  the macros or the food relation the way a hand-rolled restore would. */
const RESTORABLE = [
  'user',
  'meal_slot',
  'food',
  'external_id',
  'name_snapshot',
  'brand_snapshot',
  'grams',
  'kcal',
  'protein',
  'carbs',
  'fat',
  'logged_at',
  'source',
] as const;

export type RestorableEntry = Record<string, unknown>;

/** Delete an entry, returning a snapshot that `restoreEntry` can put back.
 *  The record is read before deleting precisely so the restore is lossless. */
export async function deleteEntryWithUndo(pb: PocketBase, id: string): Promise<RestorableEntry> {
  const rec = (await pb.collection('diary_entries').getOne(id)) as unknown as Record<string, unknown>;
  const snapshot: RestorableEntry = {};
  for (const key of RESTORABLE) {
    if (rec[key] !== undefined && rec[key] !== null && rec[key] !== '') snapshot[key] = rec[key];
  }
  await pb.collection('diary_entries').delete(id);
  return snapshot;
}

/** Re-create a deleted entry. The new record gets a new id — the content is
 *  what the user cares about getting back. */
export async function restoreEntry(pb: PocketBase, snapshot: RestorableEntry): Promise<void> {
  await pb.collection('diary_entries').create(snapshot);
}

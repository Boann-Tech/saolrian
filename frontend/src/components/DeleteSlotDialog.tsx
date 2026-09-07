import { useState } from 'react';
import type PocketBase from 'pocketbase';
import { Button, Modal } from './ui';

/** Deleting a meal slot cascades to every entry ever logged in it, on every
 *  date — so it needs the blast radius stated before it happens. This lives in
 *  one place because the same action is offered from Today and from Profile,
 *  and only one of them used to say so. */

export interface PendingSlotDelete {
  id: string;
  name: string;
  count: number;
}

/** How many diary entries a slot would take with it. */
export async function countSlotEntries(pb: PocketBase, slotId: string): Promise<number> {
  const res = await pb.collection('diary_entries').getList(1, 1, { filter: `meal_slot="${slotId}"` });
  return res.totalItems;
}

export function DeleteSlotDialog({
  pending,
  deleting,
  onCancel,
  onConfirm,
}: {
  pending: PendingSlotDelete | null;
  deleting?: boolean;
  onCancel: () => void;
  onConfirm: (pending: PendingSlotDelete) => void;
}) {
  return (
    <Modal open={!!pending} onClose={onCancel} title={`Delete “${pending?.name}”?`}>
      <p className="text-sm text-text-muted">
        This removes the meal category and permanently deletes {pending?.count} logged item
        {pending?.count === 1 ? '' : 's'} across all dates, not just today. This can’t be undone.
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="danger" size="sm" loading={deleting} onClick={() => pending && onConfirm(pending)}>
          Delete
        </Button>
      </div>
    </Modal>
  );
}

/** Shared state machine: check the slot, delete it outright when it's empty,
 *  otherwise stage a confirmation. */
export function useSlotDeletion(pb: () => PocketBase, onDeleted: (name: string) => Promise<void> | void, onError: (msg: string) => void) {
  const [pending, setPending] = useState<PendingSlotDelete | null>(null);
  const [deleting, setDeleting] = useState(false);

  const doDelete = async (id: string, name: string) => {
    setDeleting(true);
    try {
      await pb().collection('meal_slots').delete(id);
      await onDeleted(name);
    } catch (ex) {
      onError(ex instanceof Error ? ex.message : 'Could not delete meal slot');
    } finally {
      setDeleting(false);
      setPending(null);
    }
  };

  const request = async (id: string, name: string) => {
    try {
      const count = await countSlotEntries(pb(), id);
      if (count === 0) await doDelete(id, name);
      else setPending({ id, name, count });
    } catch (ex) {
      onError(ex instanceof Error ? ex.message : 'Could not check meal slot');
    }
  };

  return { pending, deleting, request, confirm: doDelete, cancel: () => setPending(null) };
}

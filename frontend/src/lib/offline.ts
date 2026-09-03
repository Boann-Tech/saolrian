import { useEffect } from 'react';
import { getClient, saolrianSend } from './pb';
import { enqueueCreate, isDuplicateQueued, readQueue, writeQueue } from './storage';

/** Offline queue for diary_entries creates.
 *
 * When a diary create fails because the network is down (TypeError / Failed to
 * fetch), the payload is persisted to localStorage under 'saolrian-offline-queue'
 * and replayed automatically when the app next comes online or is reloaded.
 * Queue is plain JSON: [{endpoint, payload, queued_at}] — simplest thing that
 * keeps a day of food logging intact on a flaky connection.
 */

export interface CreateResult {
  ok: boolean;
  queued: boolean;
  error?: string;
}

export async function createDiaryEntry(
  endpoint: string,
  userId: string,
  payload: Record<string, unknown>,
): Promise<CreateResult> {
  if (isDuplicateQueued(endpoint, payload)) {
    return { ok: false, queued: false, error: 'Similar entry is already waiting in the offline queue' };
  }
  try {
    const pb = getClient(endpoint);
    await pb.collection('diary_entries').create({
      ...payload,
      user: userId,
      source: 'manual',
    });
    return { ok: true, queued: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isNetwork =
      message.includes('fetch') || message.includes('NetworkError') || err instanceof TypeError;
    if (isNetwork) {
      enqueueCreate(endpoint, payload);
      return { ok: true, queued: true };
    }
    return { ok: false, queued: false, error: message };
  }
}

export function queueDepth(): number {
  return readQueue().length;
}

/** Try to flush pending creates; returns how many were sent successfully. */
export async function flushQueue(): Promise<number> {
  const q = readQueue();
  if (q.length === 0) return 0;
  const remaining: typeof q = [];
  let sent = 0;
  for (const item of q) {
    try {
      const pb = getClient(item.endpoint);
      await pb.collection('diary_entries').create(item.payload);
      sent++;
    } catch {
      remaining.push(item);
    }
  }
  writeQueue(remaining);
  return sent;
}

/** Wire a window listener that flushes the queue when connectivity returns. */
export function useOfflineFlush(onFlushed?: (n: number) => void): void {
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const n = await flushQueue();
      if (!cancelled && n > 0) onFlushed?.(n);
    };
    window.addEventListener('online', run);
    void run();
    return () => {
      cancelled = true;
      window.removeEventListener('online', run);
    };
  }, [onFlushed]);
}

export { saolrianSend };

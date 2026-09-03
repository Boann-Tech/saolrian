/** Endpoint + theme persistence, keyed by the app's agreed localStorage names. */

export const ENDPOINT_KEY = 'saolrian-endpoint';
export const THEME_KEY = 'saolrian-theme';

export function getStoredEndpoint(): string {
  try {
    return localStorage.getItem(ENDPOINT_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setStoredEndpoint(url: string): void {
  try {
    localStorage.setItem(ENDPOINT_KEY, url);
  } catch {
    /* storage unavailable (private mode) — endpoint lives for the session only */
  }
}

export function getStoredTheme(): string {
  try {
    return localStorage.getItem(THEME_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setStoredTheme(color: string): void {
  try {
    localStorage.setItem(THEME_KEY, color);
  } catch {
    /* ignore */
  }
}

/** Offline queue for diary creates: [{endpoint, payload}] flushed on reconnect. */
export const QUEUE_KEY = 'saolrian-offline-queue';

export interface QueuedCreate {
  endpoint: string;
  payload: Record<string, unknown>;
  queued_at: string;
}

export function readQueue(): QueuedCreate[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as QueuedCreate[]) : [];
  } catch {
    return [];
  }
}

export function writeQueue(q: QueuedCreate[]): void {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  } catch {
    /* ignore */
  }
}

export function enqueueCreate(endpoint: string, payload: Record<string, unknown>): void {
  const q = readQueue();
  q.push({ endpoint, payload, queued_at: new Date().toISOString() });
  writeQueue(q);
}

/** True if a create is queued for the same meal slot + name in the last 30s (double-tap guard). */
export function isDuplicateQueued(endpoint: string, payload: Record<string, unknown>): boolean {
  const cutoff = Date.now() - 30_000;
  return readQueue().some(
    (q) =>
      q.endpoint === endpoint &&
      q.payload.name_snapshot === payload.name_snapshot &&
      q.payload.meal_slot === payload.meal_slot &&
      new Date(q.queued_at).getTime() > cutoff,
  );
}

import PocketBase, { type SendOptions } from 'pocketbase';

/** Endpoint persistence + API client factory.
 *
 * The endpoint lives in localStorage ('saolrian-endpoint'). A '' value means
 * "not set yet" and routes the user to onboarding.
 */

export const HOSTED_ENDPOINT = 'https://saolrian.example.com';

let pb: PocketBase | null = null;

export function getClient(endpoint: string): PocketBase {
  if (!pb || pb.baseUrl !== endpoint) {
    pb = new PocketBase(endpoint);
  }
  return pb;
}

export function resetClient(): void {
  pb = null;
}

export class UnreachableError extends Error {
  constructor() {
    super('Server unreachable');
    this.name = 'UnreachableError';
  }
}

function classify(err: unknown): Error {
  if (err instanceof Error) {
    if (
      err.message === 'NetworkError when attempting to fetch resource.' ||
      err.message === 'Failed to fetch' ||
      err.name === 'TypeError' ||
      err.name === 'AbortError'
    ) {
      return new UnreachableError();
    }
    return err;
  }
  return new Error(String(err));
}

/** Authenticated custom-endpoint call. Throws UnreachableError on network failure. */
export async function saolrianSend<T>(
  pb: PocketBase,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const opts: SendOptions = {};
  if (body !== undefined) {
    opts.body = body;
  }
  try {
    return (await pb.send(path, { method, ...opts })) as T;
  } catch (err) {
    throw classify(err);
  }
}

/** Health probe used during onboarding. */
export async function probeEndpoint(endpoint: string): Promise<boolean> {
  const pb = new PocketBase(endpoint);
  try {
    await pb.health.check({ $autoCancel: false });
    return true;
  } catch {
    return false;
  }
}

export function normalizeUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

export function isValidHttpUrl(raw: string): boolean {
  try {
    const u = new URL(normalizeUrl(raw));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

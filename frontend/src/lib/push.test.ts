import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ensurePushSubscription } from './push';

vi.mock('./pb', () => ({
  getClient: () => ({}),
  saolrianSend: vi.fn(),
}));

import { saolrianSend } from './pb';

describe('ensurePushSubscription', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns false without calling Notification when the server has no VAPID key configured', async () => {
    (saolrianSend as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ enabled: false, publicKey: '' });
    vi.stubGlobal('Notification', { requestPermission: vi.fn() });
    vi.stubGlobal('navigator', { serviceWorker: {} });
    vi.stubGlobal('PushManager', function () {});

    const result = await ensurePushSubscription('http://localhost:8090');

    expect(result).toBe(false);
    expect(saolrianSend).toHaveBeenCalledWith(expect.anything(), 'GET', '/api/saolrian/push/vapid-key');
    expect((globalThis.Notification as unknown as { requestPermission: ReturnType<typeof vi.fn> }).requestPermission).not.toHaveBeenCalled();
  });

  it('returns false without subscribing when the user denies notification permission', async () => {
    (saolrianSend as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ enabled: true, publicKey: 'QUJD' }); // vapid-key lookup

    vi.stubGlobal('Notification', { requestPermission: vi.fn().mockResolvedValue('denied') });

    const registration = {
      pushManager: {
        getSubscription: vi.fn(),
        subscribe: vi.fn(),
      },
    };
    vi.stubGlobal('navigator', {
      serviceWorker: { ready: Promise.resolve(registration) },
    });
    vi.stubGlobal('PushManager', function () {});

    const result = await ensurePushSubscription('http://localhost:8090');

    expect(result).toBe(false);
    // Only the vapid-key lookup should have happened — no subscribe POST.
    expect(saolrianSend).toHaveBeenCalledTimes(1);
    // Proves execution actually stopped at the permission guard rather
    // than merely erroring out later (e.g. on an undefined
    // navigator.serviceWorker.ready) and being swallowed by the
    // try/catch — if the guard were ever removed, these would fire.
    expect(registration.pushManager.getSubscription).not.toHaveBeenCalled();
    expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
  });

  it('subscribes and posts the subscription when permission is granted', async () => {
    (saolrianSend as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ enabled: true, publicKey: 'QUJD' }) // vapid-key lookup
      .mockResolvedValueOnce({ ok: true }); // subscribe POST

    vi.stubGlobal('Notification', { requestPermission: vi.fn().mockResolvedValue('granted') });

    const fakeSubscription = {
      toJSON: () => ({ endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } }),
    };
    const registration = {
      pushManager: {
        getSubscription: vi.fn().mockResolvedValue(null),
        subscribe: vi.fn().mockResolvedValue(fakeSubscription),
      },
    };
    vi.stubGlobal('navigator', {
      serviceWorker: { ready: Promise.resolve(registration) },
    });
    vi.stubGlobal('PushManager', function () {});

    const result = await ensurePushSubscription('http://localhost:8090');

    expect(result).toBe(true);
    expect(registration.pushManager.subscribe).toHaveBeenCalled();
    expect(saolrianSend).toHaveBeenCalledWith(
      expect.anything(),
      'POST',
      '/api/saolrian/push/subscribe',
      { endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } },
    );
  });
});

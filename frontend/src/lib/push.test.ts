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

    const result = await ensurePushSubscription('http://localhost:8090');

    expect(result).toBe(false);
    expect((globalThis.Notification as unknown as { requestPermission: ReturnType<typeof vi.fn> }).requestPermission).not.toHaveBeenCalled();
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

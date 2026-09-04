/** Requests notification permission and subscribes this browser to Web
 * Push, registering the subscription with the backend. A no-op (returns
 * false) if push isn't supported, permission is denied, or the server
 * has no VAPID key configured — the import still works via in-app
 * realtime updates and toasts in every one of those cases. */
import { getClient, saolrianSend } from './pb';

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const base64Safe = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64Safe);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export async function ensurePushSubscription(endpoint: string): Promise<boolean> {
  if (!('serviceWorker' in navigator) || typeof PushManager === 'undefined') return false;

  const pb = getClient(endpoint);
  const config = await saolrianSend<{ enabled: boolean; publicKey: string }>(
    pb,
    'GET',
    '/api/saolrian/push/vapid-key',
  );
  if (!config.enabled) return false;

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return false;

  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.publicKey),
    });
  }

  const json = subscription.toJSON();
  await saolrianSend(pb, 'POST', '/api/saolrian/push/subscribe', {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
  });
  return true;
}

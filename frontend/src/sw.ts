/// <reference lib="webworker" />
import { precacheAndRoute, createHandlerBoundToURL } from 'workbox-precaching';
import { registerRoute, NavigationRoute } from 'workbox-routing';
import { NetworkFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';

declare let self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);

// Preserves the SPA offline-navigation fallback that the previous
// generateSW config provided via its `workbox.navigateFallback` option —
// that option has no effect under injectManifest, so it's reimplemented
// here: any navigation request not itself precached falls back to the
// cached app shell, letting client-side routes (e.g. /profile) work
// offline/on reload.
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html')));

// Preserves the network-first API caching that the previous generateSW
// config provided via its `workbox.runtimeCaching` option — that option
// has no effect under injectManifest, so it's reimplemented here.
registerRoute(
  ({ url }) => url.pathname.includes('/api/'),
  new NetworkFirst({
    cacheName: 'saolrian-api',
    networkTimeoutSeconds: 4,
    plugins: [new ExpirationPlugin({ maxEntries: 100, maxAgeSeconds: 60 * 60 })],
  }),
);

self.addEventListener('push', (event: PushEvent) => {
  if (!event.data) return;
  const data = event.data.json() as { title: string; body: string };
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',
    }),
  );
});

self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return (client as WindowClient).focus();
      }
      return self.clients.openWindow('/');
    }),
  );
});

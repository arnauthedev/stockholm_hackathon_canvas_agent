/* Push-only service worker logic (no caching). Used directly in dev, and imported by the
   generated production service worker (workbox importScripts). */
self.addEventListener("push", (event) => {
  let m = { title: "Canvas Agent", body: "", url: "/" };
  try {
    m = { ...m, ...event.data.json() };
  } catch {
    if (event.data) m.body = event.data.text();
  }
  event.waitUntil(
    self.registration.showNotification(m.title, {
      body: m.body,
      tag: m.tag,
      renotify: !!m.tag,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: m.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of all) {
        if ("focus" in c) {
          c.postMessage({ type: "navigate", url });
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    })(),
  );
});

// dev SW: activate immediately
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

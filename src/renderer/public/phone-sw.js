// Wanigan's phone service worker. It only shows the notifications the Mac
// sends (already decrypted by the browser) and opens Wanigan when one is
// tapped. It caches nothing: the page is always the Mac's current one.
self.addEventListener('push', (event) => {
  let message = { title: 'Wanigan', body: 'Something needs you.', tag: 'wanigan' };
  try { message = { ...message, ...event.data.json() }; } catch { /* the defaults */ }
  event.waitUntil(self.registration.showNotification(message.title, {
    body: message.body,
    tag: message.tag,
    icon: 'phone-icon-192.png',
    badge: 'phone-icon-192.png',
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (open[0]) return open[0].focus();
    return self.clients.openWindow(self.registration.scope);
  })());
});

/* Painel AVL — service worker mínimo para avisos automáticos de novos pedidos.
   Publicar este arquivo junto do admin.html, na mesma pasta. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/admin.html';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const aberto = list.find(c => c.url.includes('admin.html')) || list[0];
      if (aberto && 'focus' in aberto) return aberto.focus();
      return self.clients.openWindow(url);
    })
  );
});

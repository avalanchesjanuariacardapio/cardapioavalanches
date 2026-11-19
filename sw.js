/* Painel AVL — service worker para avisos automáticos de novos pedidos.
   Publicar este arquivo junto do admin.html, na mesma pasta.

   IMPORTANTE: não usa skipWaiting()/clients.claim() de propósito.
   Este arquivo apenas mostra notificações e não "assume" o controle de
   nenhuma aba, para não atrapalhar quem estiver fazendo pedido. */

/* Aviso com prioridade alta: vibração longa, permanece na tela e volta
   a aparecer se chegar outro pedido com a mesma tag. */
function aviso(d) {
  const titulo = (d && d.title) || 'Novo pedido';
  const opcoes = {
    body: (d && d.body) || '',
    tag: (d && d.tag) || 'pedido-avl',
    renotify: true,
    requireInteraction: true,
    silent: false,
    urgency: 'high',
    ttl: 0,
    timestamp: Date.now(),
    vibrate: [300, 120, 300, 120, 300],
    icon: 'logo-app.png',
    badge: 'logo-app.png',
    data: { url: (d && d.url) || '/admin.html' }
  };
  return self.registration.showNotification(titulo, opcoes);
}

/* Recebe push de servidor (quando houver push configurado) e mantém
   o mesmo padrão de aviso prioritário usado pelo painel aberto. */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(aviso(d));
});

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

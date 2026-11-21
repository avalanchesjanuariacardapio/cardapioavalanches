/* AVL — Worker enxuto do Cloudflare Pages.
   Em vez de embutir 1,9 MB em base64, busca os arquivos publicados no repo.
   A URL do repo é fixa; o cache do Cloudflare evita uma ida ao GitHub em cada acesso. */
const BASE = 'https://raw.githubusercontent.com/avalanchesjanuariacardapio/cardapioavalanches/main/';
const VER = 'f0378f1'; /* muda a cada publicacao para furar o cache do raw.githubusercontent */
const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml'
};
const ROTAS = {
  '/': 'index.html', '/index.html': 'index.html', '/admin.html': 'admin.html',
  '/ativar.html': 'ativar.html', '/sw.js': 'sw.js',
  '/admin.webmanifest': 'admin.webmanifest', '/manifest.webmanifest': 'manifest.webmanifest',
  '/logo-app.png': 'logo-app.png', '/icon-192.png': 'icon-192.png',
  '/icon-512.png': 'icon-512.png', '/icon-180.png': 'icon-180.png', '/icon.svg': 'icon.svg'
};

/* Cabecalhos de seguranca. O _headers NAO e aplicado quando um Worker responde,
   entao eles ficam aqui. geolocation=(self) e necessario: o cardapio usa a localizacao do cliente. */
const SEG = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(self), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups'
};
const NOINDEX = new Set(['admin.html', 'ativar.html']);

export default {
  async fetch(req) {
    const u = new URL(req.url);
    let p = u.pathname;
    try { p = decodeURIComponent(p); } catch (e) {}
    if (p === '' || p === '/') p = '/index.html';
    const arquivo = ROTAS[p];
    if (!arquivo) return new Response('Não encontrado', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    try {
      const r = await fetch(BASE + arquivo + '?v=' + VER, { cf: { cacheTtl: 60 }, headers: { 'User-Agent': 'avl-painel' } });
      if (!r.ok) return new Response('Não encontrado', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      const ext = arquivo.slice(arquivo.lastIndexOf('.'));
      return new Response(r.body, {
        headers: {
          ...SEG,
          ...(NOINDEX.has(arquivo) ? { 'X-Robots-Tag': 'noindex, nofollow' } : {}),
          'Content-Type': TIPOS[ext] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
          'Service-Worker-Allowed': '/'
        }
      });
    } catch (e) {
      return new Response('Indisponível', { status: 502, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  }
};

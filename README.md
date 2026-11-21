# Cardápio Avalanches

Site do cardápio para clientes (`index.html`) e painel administrativo (`admin.html`).

## Arquivos

- `index.html` — cardápio dos clientes (PIX, WhatsApp, cupons, banners)
- `admin.html` — painel (pedidos, cardápio, cupons, entregas, relatórios)
- `ativar.html` — ativação das notificações do painel
- `sw.js`, `admin.webmanifest`, `manifest.webmanifest` — service worker e manifestos
- `_worker.js` — Worker do Cloudflare Pages (enxuto; gerado a partir de `site-lean-worker.js`)
- `avl_mp_pix_worker.js` — cópia do Worker do PIX implantado em `avl-mp-pix`

## PIX

Fluxo: o cliente gera o pedido em `index.html` → `POST /pix` no Worker do Mercado Pago →
QR Code → webhook `/webhook` confirma o pagamento com a API do MP → o Worker grava o pedido
no Firestore, reclama o cupom e dispara o push no painel → `GET /status?id=...` é consultado
pelo cliente a cada 1 s (e uma vez imediata) para liberar “Acompanhar pedido”.

O **webhook é a única fonte da verdade**. O painel nunca marca um PIX como pago por conta
própria: `verPix()` consulta `/status` e sinaliza “PIX não confirmado” quando o pedido não
existe no Worker.

- Worker: `avl-mp-pix` (`https://avl-mp-pix.marcosolive321-ss.workers.dev`)
- Secret: `MP_TOKEN` (token do Mercado Pago — **nunca** vai para o repositório)
- KV: `AVL_MP` (`pix:<id>` por 24 h; `chk:<id>` e `push:<id>` são auxiliares)
- Compatibility flag: `global_fetch_strictly_public` (necessária para chamar `avl-push`)
- Rotas: `/health`, `/pix`, `/status`, `/webhook`
- Limite: 10 `/pix` e 120 `/status` por minuto por IP, em memória do Worker
- Preço: `/pix` confere item, adicionais, desconto e total contra `cardapio/config` e `cupons`
- O ID do pedido tem 15 caracteres (`P` + hora em base 36 + 6 aleatórios)

### Risco que ainda depende de configuração externa

As regras do Firestore hoje permitem criação pública em `/pedidos` (o site e o Worker usam
a mesma API REST sem login). Isso é necessário para o Worker gravar o pedido. Para eliminar
de vez a criação de pedidos falsos direto no banco, o Worker precisa gravar com **conta de
serviço do Firebase** (chave privada como secret) e as regras passam a negar `create` público.
Enquanto isso não é feito, o painel sinaliza PIX não confirmado e o dono confere antes de
aceitar.

Para reduzir vazamento de dados pela rota `/status`, o ID do pedido é aleatório; o CORS ainda
é `*` por causa do APK. Se quiser restringir, use um domínio próprio do Worker e libere
apenas as origens do site e do app.

## Fotos

O painel reduz imagens antes de enviar para o Firestore: itens a 560 px / JPEG 0,72,
capa a 900 px / JPEG 0,74, perfil a 360 px e importações a 0,82. Não aumentar esses
valores — base64 grande deixa o cardápio lento no 4G.

## Publicação

1. `node checkall.js` — valida o JavaScript dos HTMLs e dos Workers.
2. `node sync_all.js` — replica HTMLs/deploy/Downloads/APK e gera os Workers.
3. `gradlew assembleRelease` + `sign_apk.ps1` — gera e assina o APK.
4. `git add/commit/push` em `avl-deploy`.
5. Deploy Pages com `manifest:'{}'`, `_worker.js` e `_headers` (o `_headers` não muda).

O `site-lean-worker.js` busca os arquivos no repositório GitHub (cache de 60 s), o que
reduz o `_worker.js` de ~1,9 MB para ~2 KB. A versão antiga, com tudo em base64, fica em
`site-worker-full.js` no diretório de trabalho como reserva. Se o GitHub estiver fora,
o deploy com a versão enxuta volta a servir 502 — nesse caso, copie `site-worker-full.js`
para `_worker.js` e faça o deploy novamente.

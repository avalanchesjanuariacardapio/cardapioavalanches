# Cardápio Avalanches

Site do cardápio para clientes (`index.html`) e painel administrativo (`admin.html`).

## Arquivos

- `index.html` — cardápio dos clientes (PIX, WhatsApp, cupons, banners)
- `admin.html` — painel (pedidos, cardápio, cupons, entregas, relatórios)
- `ativar.html` — ativação das notificações do painel
- `sw.js`, `admin.webmanifest`, `manifest.webmanifest` — service worker e manifestos
- `_worker.js` — Worker do Cloudflare Pages (enxuto; gerado a partir de `site-lean-worker.js`)
- `avl_mp_pix_worker.js` — cópia do Worker do PIX implantado em `avl-mp-pix`
- `firestore.rules` — regras do Firestore (publicar no console do Firebase)

## PIX

Fluxo: o cliente gera o pedido em `index.html` → `POST /pix` no Worker do Mercado Pago →
QR Code → webhook `/webhook` confirma o pagamento com a API do MP → o Worker grava o pedido
no Firestore, reclama o cupom e dispara o push no painel → `GET /status?id=...` é consultado
pelo cliente a cada 1 s (e uma vez imediata) para liberar “Acompanhar pedido”.

O **webhook é a única fonte da verdade**. O painel nunca marca um PIX como pago por conta
própria: `verPix()` consulta `/status` e sinaliza “PIX não confirmado” quando o pedido não
existe no Worker.

Pedidos em dinheiro/cartão usam `POST /order` no mesmo Worker. O navegador **não escreve**
mais em `/pedidos`: a gravação é feita pelo Worker com a service account. `/order` recusa
`pag: 'pix'` — PIX sem webhook confirmado não entra no painel.

- Worker: `avl-mp-pix` (URL configurada no Cloudflare; não repetir aqui)
- Secrets: `MP_TOKEN` (token do Mercado Pago) e `FB_SERVICE_ACCOUNT` (JSON da service account do Firebase). **Nunca** vão para o repositório.
- KV: `AVL_MP` (`pix:<id>` por 24 h; `chk:<id>` e `push:<id>` são auxiliares)
- Compatibility flag: `global_fetch_strictly_public` (necessária para chamar `avl-push`)
- Endpoints: `/health`, `/pix`, `/status`, `/order`, `/webhook`
- Monitorar `/health` com alerta no celular buscando `"fb":true`. Se `fb` cair, a gravação falha e o cliente fica sem pedido.
- Limite: 10 `/pix` e 10 `/order` e 120 `/status` por minuto por IP, em memória do Worker
- Preço: `/pix` e `/order` conferem item, adicionais, desconto, taxa e total contra `cardapio/config`, `cardapio/entregas` e `cupons`
- O ID do pedido tem 15 caracteres (`P` + hora em base 36 + 6 aleatórios)
- `/health` devolve `fb: true` quando o token OAuth da service account foi obtido (nunca devolve o token)

## Regras do Firestore

`firestore.rules` já está preparado para negar `create` público em `/pedidos`. O Worker usa
token OAuth2 da service account (`https://www.googleapis.com/auth/datastore`), que é
autorizado pelo IAM e **ignora** as regras — por isso continua gravando normalmente.

Regras publicadas via Firebase Rules API com a service account. Confirmação: criação pública em
`/pedidos` retorna `403 PERMISSION_DENIED`. IDs de release/ruleset ficam só no console do Firebase.
Se alterar `firestore.rules`, publique de novo pelo console (**Firestore Database → Rules → Publish**)
ou com `firebase deploy --only firestore:rules`.

`/cupom_usos` continua com criação pública porque é o site que registra o uso do cupom por
telefone no checkout; fechar isso quebraria a validação de cupom.

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
6. Se `firestore.rules` mudou, publicar no console do Firebase.

O `site-lean-worker.js` busca os arquivos no repositório GitHub (cache de 60 s), o que
reduz o `_worker.js` de ~1,9 MB para ~2 KB. Por isso o repositório **precisa continuar
público**: se virar privado, o site cai com 502. Qualquer commit na `main` vai ao ar
automaticamente, então mantenha proteção da branch com pull request obrigatório.

A versão antiga, com tudo em base64, fica em `site-worker-full.js` no diretório de trabalho
como reserva. Se o GitHub estiver fora, o deploy enxuto volta a servir 502 — nesse caso,
copie `site-worker-full.js` para `_worker.js` e faça o deploy novamente.

## Checklist de segurança externo

- **GitHub:** repositório público, `main` protegida (exigir PR). Nunca commitar senhas.
  Se `avl2026` aparecer no histórico do Git, a senha do keystore está comprometida: troque-a.
- **Firebase Authentication:** desativar criação pública de contas (o painel só faz login;
  não cria usuários). A chave de API do `admin.html` é pública por natureza — não restringir
  por domínio sem testar o login do app Android.
- **`/status`:** a rota devolve nome/telefone/endereço para quem souber o ID do pedido.
  O ID é aleatório e o CORS continua `*` por causa do APK. Mantido assim.
- **Preço:** `/pix` e `/order` rejeitam item fora do cardápio, quantidade fora de 1–50,
  cupom inexistente com desconto e divergência entre o valor aprovado no MP e o total do pedido.

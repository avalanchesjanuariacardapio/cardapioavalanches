/* AVL MP PIX — cria cobranca PIX no Mercado Pago, recebe webhook,
   registra o pedido no Firestore e dispara push no painel APK.
   O token fica somente no secret MP_TOKEN.
   IMPORTANTE: este Worker precisa da compatibility flag
   global_fetch_strictly_public para chamar o Worker de push. */

const FS_BASE = 'https://firestore.googleapis.com/v1/projects/avalanches-4a953/databases/(default)/documents';
const PUSH_URL = 'https://avl-push.marcosolive321-ss.workers.dev';
const MP_API = 'https://api.mercadopago.com/v1/payments';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const json = (o, status = 200) => new Response(JSON.stringify(o), {
  status,
  headers: { ...CORS, 'Content-Type': 'application/json;charset=utf-8' }
});

const cleanId = id => String(id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20);
const txt = (v, n) => String(v == null ? '' : v).slice(0, n);
const money = v => Math.round(Number(v) * 100) / 100;

async function mpGet(paymentId, token) {
  if (!token) return null;
  const r = await fetch(MP_API + '/' + encodeURIComponent(paymentId), {
    headers: { Authorization: 'Bearer ' + token },
    cf: { cacheTtl: 0 }
  });
  if (!r.ok) return null;
  return r.json();
}

const isApprovedPix = p => !!p && String(p.status) === 'approved' && String(p.payment_method_id) === 'pix';

async function postFirestore(id, o) {
  const body = {
    fields: {
      t: { integerValue: String(Date.now()) },
      status: { stringValue: 'novo' },
      extra: { integerValue: '0' },
      json: { stringValue: JSON.stringify(o) }
    }
  };
  try {
    const r = await fetch(FS_BASE + '/pedidos?documentId=' + encodeURIComponent(id), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    /* 409 = pedido ja gravado por outra rota; nao pode travar a confirmacao. */
    return r.ok || r.status === 409;
  } catch (e) { return false; }
}

async function claimCupom(o) {
  if (!o || !o.cupom || !o.fone) return;
  const key = txt(o.cupom, 60) + '_' + txt(o.fone, 20);
  if (key.length > 80) return;
  try {
    await fetch(FS_BASE + '/cupom_usos?documentId=' + encodeURIComponent(key), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { t: { integerValue: String(Date.now()) }, o: { stringValue: txt(o.id, 20) } } })
    });
  } catch (e) {}
}

/* Aviso ao painel/APK. Antes era ctx.waitUntil() com erro silencioso:
   se a chamada falhava, o pedido ficava pago mas sem notificacao.
   Agora e await com retries e marca pushOk no estado do PIX. */
async function pushPanel(o, env) {
  const payload = {
    id: String(o.id),
    title: 'Novo pedido #' + String(o.id).slice(-5) + (o.ant ? ' (antecipado)' : ''),
    body: txt(o.nome, 60) + ' · R$ ' + money(o.total).toFixed(2).replace('.', ',') + '. Pagamento PIX confirmado. Abra o painel para ver os detalhes.',
    url: 'https://avl-painel.pages.dev/admin.html',
    force: 1,
    icon: 'https://avl-painel.pages.dev/logo-app.png'
  };
  for (let tent = 0; tent < 3; tent++) {
    try {
      const r = await fetch(PUSH_URL + '/notify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      let j = null;
      try { j = await r.json(); } catch (e) {}
      if (r.ok && (!j || j.ok !== false)) {
        try { await env.AVL_MP.put('push:' + payload.id, String(Date.now()), { expirationTtl: 86400 }); } catch (e) {}
        return true;
      }
    } catch (e) {}
    if (tent < 2) await new Promise(res => setTimeout(res, 350 * (tent + 1)));
  }
  return false;
}

/* Registro unico: Firestore + cupom + push. Chamado pelo webhook e,
   como fallback, pelo /status quando a aba do cliente esta aberta. */
async function confirmPayment(id, st, env) {
  if (st.registered) {
    /* Pedido ja gravado: reenvia o aviso se ele ficou sem push. */
    if (st.pago && !st.pushOk && st.paidAt && Date.now() - st.paidAt < 7200000) {
      if (await pushPanel(st.order, env)) {
        st.pushOk = true;
        try { await env.AVL_MP.put('pix:' + id, JSON.stringify(st), { expirationTtl: 86400 }); } catch (e) {}
      }
    }
    return { ok: true, ja_registrado: true, pago: true, push: !!st.pushOk };
  }
  const saved = await postFirestore(id, st.order);
  if (!saved) return { ok: false, erro: 'firestore' };
  await claimCupom(st.order);
  st.pago = true;
  st.registered = true;
  st.paidAt = Date.now();
  await env.AVL_MP.put('pix:' + id, JSON.stringify(st), { expirationTtl: 86400 });
  /* Await de verdade: nada de waitUntil, que terminava antes do fetch. */
  st.pushOk = await pushPanel(st.order, env);
  if (st.pushOk) { try { await env.AVL_MP.put('pix:' + id, JSON.stringify(st), { expirationTtl: 86400 }); } catch (e) {} }
  return { ok: true, pago: true, registrado: true, push: !!st.pushOk };
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/health') {
      return json({ ok: true, token: !!env.MP_TOKEN, kv: !!env.AVL_MP });
    }

    if (path === '/status' && req.method === 'GET') {
      const id = cleanId(url.searchParams.get('id'));
      if (!id) return json({ ok: false, erro: 'id' }, 400);
      const raw = await env.AVL_MP.get('pix:' + id);
      if (!raw) return json({ ok: false, erro: 'nao_encontrado' });
      const st = JSON.parse(raw);
      if (!st.pago && st.paymentId) {
        const last = Number(await env.AVL_MP.get('chk:' + id) || 0);
        /* Antes era 20s: com o polling do site isso atrasava a confirmacao.
           Agora acompanha o polling (3s) sem abrir excecao deseguranca. */
        if (Date.now() - last > 4000) {
          await env.AVL_MP.put('chk:' + id, String(Date.now()), { expirationTtl: 30 });
          const p = await mpGet(st.paymentId, env.MP_TOKEN);
          if (isApprovedPix(p)) {
            const r = await confirmPayment(id, st, env);
            if (r.ok) {
              const fresh = await env.AVL_MP.get('pix:' + id);
              if (fresh) Object.assign(st, JSON.parse(fresh));
            }
          }
        }
      }
      /* Se o pagamento ja foi confirmado e o aviso nao chegou ao painel,
         tenta de novo enquanto o cliente estiver acompanhando o pedido. */
      if (st.pago && !st.pushOk && st.paidAt && Date.now() - st.paidAt < 7200000) {
        if (await pushPanel(st.order, env)) {
          st.pushOk = true;
          try { await env.AVL_MP.put('pix:' + id, JSON.stringify(st), { expirationTtl: 86400 }); } catch (e) {}
        }
      }
      return json({
        ok: true,
        pago: !!st.pago,
        qr: st.qr || '',
        qrBase64: st.qrBase64 || '',
        paymentId: st.paymentId || '',
        expira: st.expira || 1800,
        order: st.order || null,
        debug: { pago: !!st.pago, pushOk: !!st.pushOk, paidAt: st.paidAt || 0, diff: Date.now() - (st.paidAt || 0) }
      });
    }

    if (path === '/pix' && req.method === 'POST') {
      if (!env.MP_TOKEN) return json({ ok: false, erro: 'token_nao_configurado' }, 500);
      let b;
      try { b = await req.json(); } catch (e) { return json({ ok: false, erro: 'json' }, 400); }
      const id = cleanId(b.id);
      const total = money(b.total);
      if (!id || !(total > 0)) return json({ ok: false, erro: 'pedido_invalido' }, 400);

      const order = {
        id,
        nome: txt(b.nome, 80),
        fone: txt(b.fone, 20),
        end: txt(b.end, 160),
        num: txt(b.num, 100),
        pag: 'pix',
        itens: Array.isArray(b.itens) ? b.itens.slice(0, 60) : [],
        cupom: txt(b.cupom, 40),
        desc: Number(b.desc) || 0,
        taxa: Number(b.taxa) || 0,
        total,
        ant: !!b.ant,
        loc: txt(b.loc, 300),
        prazo: txt(b.prazo, 80),
        troco: Number(b.troco) || 0
      };

      const payload = {
        transaction_amount: total,
        description: 'Pedido #' + id.slice(-5) + ' - Avalanches',
        payment_method_id: 'pix',
        payer: {
          email: 'cliente@avl-pedidos.com.br',
          first_name: (order.nome || 'Cliente').split(' ')[0].slice(0, 30)
        },
        external_reference: id,
        notification_url: new URL('/webhook', req.url).href,
        date_of_expiration: new Date(Date.now() + 30 * 60000).toISOString()
      };

      let r, p;
      try {
        r = await fetch(MP_API, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + env.MP_TOKEN,
            'X-Idempotency-Key': 'avl-' + id
          },
          body: JSON.stringify(payload)
        });
        p = await r.json();
      } catch (e) { return json({ ok: false, erro: 'rede' }, 502); }

      const td = (p && p.point_of_interaction && p.point_of_interaction.transaction_data) || {};
      if (!r.ok || !td.qr_code_base64) {
        return json({ ok: false, erro: 'mp', detalhe: txt(p && (p.message || p.error || p.status_detail), 160) }, 502);
      }

      const st = {
        id,
        order,
        paymentId: String(p.id || ''),
        qr: td.qr_code || '',
        qrBase64: td.qr_code_base64,
        expira: 1800,
        pago: false,
        registered: false,
        t: Date.now()
      };
      await env.AVL_MP.put('pix:' + id, JSON.stringify(st), { expirationTtl: 86400 });
      if (st.paymentId) await env.AVL_MP.put('pay:' + st.paymentId, id, { expirationTtl: 86400 });

      return json({ ok: true, qr: st.qr, qrBase64: st.qrBase64, paymentId: st.paymentId, expira: st.expira, id });
    }

    if (path === '/webhook' && req.method === 'POST') {
      let j;
      try { j = await req.json(); } catch (e) { return json({ ok: true }); }
      const paymentId = String((j.data && j.data.id) || j.id || '').replace(/\D/g, '');
      if (!paymentId) return json({ ok: true });

      const p = await mpGet(paymentId, env.MP_TOKEN);
      if (!isApprovedPix(p)) return json({ ok: true, pago: false });

      const id = cleanId(p.external_reference);
      const raw = id ? await env.AVL_MP.get('pix:' + id) : null;
      if (!raw) return json({ ok: true, pedido_nao_encontrado: true });

      const st = JSON.parse(raw);
      const r = await confirmPayment(id, st, env);
      return json(r, r.ok ? 200 : 500);
    }

    return json({ ok: false, erro: 'rota' }, 404);
  }
};

/* AVL MP PIX — cria cobranca PIX no Mercado Pago, recebe webhook,
   registra o pedido no Firestore e dispara push no painel APK.
   O token fica somente no secret MP_TOKEN.
   IMPORTANTE: este Worker precisa da compatibility flag
   global_fetch_strictly_public para chamar o Worker de push. */

const FS_BASE = 'https://firestore.googleapis.com/v1/projects/avalanches-4a953/databases/(default)/documents';
const PUSH_URL = 'https://avl-push.avalanches.workers.dev';
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

/* Service account do Firebase: o Worker assina um JWT RS256 e troca por um
   token OAuth2. O JSON fica só no secret FB_SERVICE_ACCOUNT e nunca sai daqui.
   Se o secret falhar, escreve sem Authorization (comportamento antigo). */
let FB_TOKEN = { value: '', exp: 0, who: '', scope: '' };
const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
async function fbToken(env, scope = 'https://www.googleapis.com/auth/datastore') {
  const raw = env.FB_SERVICE_ACCOUNT;
  if (!raw) return '';
  let sa;
  try { sa = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return ''; }
  if (!sa.client_email || !sa.private_key) return '';
  const agora = Date.now();
  if (FB_TOKEN.value && FB_TOKEN.who === sa.client_email && FB_TOKEN.scope === scope && agora < FB_TOKEN.exp) return FB_TOKEN.value;
  try {
    const pem = String(sa.private_key).replace(/\\n/g, '\n').replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
    const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const enc = new TextEncoder();
    const head = b64u(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
    const now = Math.floor(agora / 1000);
    const claim = b64u(enc.encode(JSON.stringify({
      iss: sa.client_email,
      scope,
      aud: sa.token_uri || 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600
    })));
    const sign = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(head + '.' + claim));
    const jwt = head + '.' + claim + '.' + b64u(sign);
    const r = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + encodeURIComponent(jwt)
    });
    if (!r.ok) return '';
    const j = await r.json();
    if (!j.access_token) return '';
    FB_TOKEN = { value: j.access_token, exp: agora + Math.max(60, (+j.expires_in || 3600) - 60) * 1000, who: sa.client_email, scope };
    return FB_TOKEN.value;
  } catch (e) { return ''; }
}

async function fsWrite(p, body, env) {
  const headers = { 'Content-Type': 'application/json' };
  const token = await fbToken(env);
  if (token) headers.Authorization = 'Bearer ' + token;
  return fetch(FS_BASE + p, { method: 'POST', headers, body: JSON.stringify(body) });
}

/* Limite de abuso em memoria por IP. Nao gera escrita no KV e barra robos
   antes da chamada ao Mercado Pago. Cada isolamento tem sua propria memoria:
   e uma protecao best-effort, nao um limite global. */
const HITS = new Map();
function rateOk(req, rota, agora) {
  const ip = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || '?';
  const max = rota === '/pix' || rota === '/order' ? 10 : 120;
  const k = rota + '|' + ip, e = HITS.get(k);
  if (!e || agora - e.t > 60000) {
    if (HITS.size > 5000) HITS.clear();
    HITS.set(k, { n: 1, t: agora });
    return true;
  }
  if (e.n >= max) return false;
  e.n++;
  return true;
}

/* Confere o preco enviado pelo navegador contra o cardapio publicado.
   Se o cardapio nao puder ser lido, libera o pedido para nao parar a loja. */
const fsGet = p => fetch(FS_BASE + p).then(r => r.ok ? r.json() : null).catch(() => null);
const fsJson = d => { try { return JSON.parse(d.fields.json.stringValue); } catch (e) { return null; } };
function precoItem(it, hoje) {
  const p = +it.price || 0, pr = it.promo;
  if (!pr || !(+pr.valor > 0) || (pr.ate && hoje > pr.ate)) return [p];
  const promo = pr.tipo === 'fixo' ? Math.min(+pr.valor, p) : Math.round(p * (100 - Math.min(+pr.valor, 100))) / 100;
  return promo === p ? [p] : [p, promo];
}
async function precoValido(o) {
  try {
    const [cfgDoc, entDoc] = await Promise.all([fsGet('/cardapio/config'), fsGet('/cardapio/entregas')]);
    const cfg = cfgDoc && fsJson(cfgDoc);
    if (!cfg || !Array.isArray(cfg.items)) return true;
    const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
    const precos = new Map(), addons = new Map();
    cfg.items.forEach(i => { if (i && i.name) precos.set(String(i.name).toLowerCase(), precoItem(i, hoje)); });
    (cfg.addons || []).forEach(a => { if (a && a.name) addons.set(String(a.name).toLowerCase(), +a.price || 0); });

    const itens = Array.isArray(o.itens) ? o.itens : [];
    if (!itens.length) return false;
    for (const it of itens) {
      const aceitos = precos.get(String(it.n || '').toLowerCase());
      if (!aceitos) return true; /* item fora do cardapio atual: nao bloqueia */
      const p = +it.p || 0;
      if (!aceitos.some(x => Math.abs(x - p) < 0.011)) return false;
      const ax = (Array.isArray(it.ex) ? it.ex : []).reduce((s, x) => s + (addons.get(String(x).toLowerCase()) || 0), 0);
      if (Math.abs(ax - (+it.ax || 0)) > 0.011) return false;
    }

    /* Cupom, desconto e taxa: so o cardapio publicado define os limites. */
    let maxDesc = 0, freteGratis = false;
    if (o.cupom) {
      const cd = await fsGet('/cupons/' + encodeURIComponent(o.cupom));
      const cupom = cd && fsJson(cd);
      if (!cupom) return true; /* cupom revogado entre checkout e pagamento: nao bloqueia */
      freteGratis = cupom.tipo === 'frete';
      const sub0 = itens.reduce((s, it) => s + (+it.q || 0) * ((+it.p || 0) + (+it.ax || 0)), 0);
      const v = +cupom.valor || 0;
      maxDesc = freteGratis ? 0 : cupom.tipo === 'pct' ? Math.round(sub0 * Math.min(v, 100)) / 100
        : cupom.tipo === 'fixo' ? Math.min(v, sub0) : 0;
    }
    if ((+o.desc || 0) > maxDesc + 0.011) return false;

    const ent = entDoc && fsJson(entDoc);
    let taxaCfg = +((cfg.loja || {}).fee) || 0;
    if (ent && ent.fee !== null && ent.fee !== undefined && ent.fee !== '' && Number.isFinite(+ent.fee) && +ent.fee >= 0) taxaCfg = +ent.fee;
    if (freteGratis) { if ((+o.taxa || 0) !== 0) return false; }
    else if (Math.abs((+o.taxa || 0) - taxaCfg) > 0.011) return false;

    const sub = itens.reduce((s, it) => s + (+it.q || 0) * ((+it.p || 0) + (+it.ax || 0)), 0);
    const esperado = money(sub - (+o.desc || 0) + (+o.taxa || 0));
    return Math.abs(esperado - money(o.total)) <= 0.05;
  } catch (e) { return true; }
}

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

async function postFirestore(id, o, env) {
  const body = {
    fields: {
      t: { integerValue: String(Date.now()) },
      status: { stringValue: 'novo' },
      extra: { integerValue: '0' },
      json: { stringValue: JSON.stringify(o) }
    }
  };
  try {
    const r = await fsWrite('/pedidos?documentId=' + encodeURIComponent(id), body, env);
    /* 409 = pedido ja gravado por outra rota; nao pode travar a confirmacao. */
    return r.ok || r.status === 409;
  } catch (e) { return false; }
}

async function claimCupom(o, env) {
  if (!o || !o.cupom || !o.fone) return;
  const key = txt(o.cupom, 60) + '_' + txt(o.fone, 20);
  if (key.length > 80) return;
  try {
    await fsWrite('/cupom_usos?documentId=' + encodeURIComponent(key), {
      fields: { t: { integerValue: String(Date.now()) }, o: { stringValue: txt(o.id, 20) } }
    }, env);
  } catch (e) {}
}

/* Aviso ao painel/APK. Antes era ctx.waitUntil() com erro silencioso:
   se a chamada falhava, o pedido ficava pago mas sem notificacao.
   Agora e await com retries e marca pushOk no estado do PIX. */
async function pushPanel(o, env, pago = true) {
  const PG = { dinheiro: 'Dinheiro', pix: 'PIX', credito: 'Cartão de crédito', debito: 'Cartão de débito', cartao: 'Cartão' };
  const fim = pago ? 'Pagamento PIX confirmado.' : 'Pagamento: ' + (PG[String(o.pag || '').toLowerCase()] || 'a combinar') + '.';
  const payload = {
    id: String(o.id),
    title: 'Novo pedido #' + String(o.id).slice(-5) + (o.ant ? ' (antecipado)' : ''),
    body: txt(o.nome, 60) + ' · R$ ' + money(o.total).toFixed(2).replace('.', ',') + '. ' + fim + ' Abra o painel para ver os detalhes.',
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
  const saved = await postFirestore(id, st.order, env);
  if (!saved) return { ok: false, erro: 'firestore' };
  await claimCupom(st.order, env);
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
      /* fb informa apenas se o token foi obtido; nunca devolve o token nem o JSON. */
      const fb = !!(await fbToken(env));
      return json({ ok: true, token: !!env.MP_TOKEN, kv: !!env.AVL_MP, fb });
    }

    if (path === '/status' && req.method === 'GET') {
      if (!rateOk(req, '/status', Date.now())) return json({ ok: false, erro: 'muitas_tentativas' }, 429);
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
      if (!rateOk(req, '/pix', Date.now())) return json({ ok: false, erro: 'muitas_tentativas' }, 429);
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

      if (!await precoValido(order)) return json({ ok: false, erro: 'preco' }, 400);

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
      /* O indice pay: nao era lido em lugar nenhum e gastava a 2a escrita do KV. */

      return json({ ok: true, qr: st.qr, qrBase64: st.qrBase64, paymentId: st.paymentId, expira: st.expira, id });
    }

    /* Pedidos dinheiro/cartao tambem passam pelo Worker: assim a criacao publica
       no Firestore pode ser negada sem quebrar o cardapio. PIX NAO entra aqui —
       ele so existe depois que o webhook confirma o pagamento. */
    if (path === '/order' && req.method === 'POST') {
      if (!rateOk(req, '/order', Date.now())) return json({ ok: false, erro: 'muitas_tentativas' }, 429);
      let b;
      try { b = await req.json(); } catch (e) { return json({ ok: false, erro: 'json' }, 400); }
      const id = cleanId(b.id), total = money(b.total);
      const pag = String(b.pag || '').toLowerCase();
      if (!id || !(total > 0) || !['dinheiro', 'credito', 'debito', 'cartao'].includes(pag)) {
        return json({ ok: false, erro: 'pedido_invalido' }, 400);
      }
      const order = {
        id,
        nome: txt(b.nome, 80),
        fone: txt(b.fone, 20),
        end: txt(b.end, 160),
        num: txt(b.num, 100),
        pag,
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
      if (!await precoValido(order)) return json({ ok: false, erro: 'preco' }, 400);
      if (!await postFirestore(id, order, env)) return json({ ok: false, erro: 'firestore' }, 500);
      await claimCupom(order, env);
      const push = await pushPanel(order, env, false);
      return json({ ok: true, id, push });
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

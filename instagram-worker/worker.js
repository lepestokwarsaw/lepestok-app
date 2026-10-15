/**
 * Lepestok — Instagram → лиды в мини-приложении.
 * Cloudflare Worker: принимает вебхуки Instagram (новые сообщения в Direct),
 * создаёт/дополняет лид в общей базе data.json (приватный репо GitHub)
 * и присылает уведомление в Telegram.
 *
 * Секреты (Settings → Variables and Secrets, тип Secret) — вводятся вручную, в коде их нет:
 *   VERIFY_TOKEN   — любая строка, та же вписывается в Meta при настройке вебхука
 *   APP_SECRET     — Instagram app secret из Meta for Developers (проверка подписи)
 *   IG_TOKEN       — Instagram access token (чтобы узнать @ник отправителя)
 *   GH_TOKEN       — тот же GitHub-ключ доступа к lepestok-data, что в приложении
 *   TG_BOT_TOKEN   — токен @LepestokWarsawBot (необязательно)
 *   TG_CHAT_ID     — куда слать уведомления: твой id или id группы (необязательно)
 */
const DATA_API = 'https://api.github.com/repos/lepestokwarsaw/lepestok-data/contents/data.json';
const LEAD_WINDOW_MS = 14 * 24 * 3600 * 1000; // новое сообщение в течение 2 недель дописывается в тот же лид

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname !== '/ig') return new Response('Lepestok Instagram webhook', {status: 200});

    // подтверждение вебхука от Meta
    if (req.method === 'GET') {
      const ok = url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === env.VERIFY_TOKEN;
      return ok ? new Response(url.searchParams.get('hub.challenge')) : new Response('forbidden', {status: 403});
    }
    if (req.method !== 'POST') return new Response('method', {status: 405});

    const raw = await req.text();
    if (!(await validSignature(raw, req.headers.get('x-hub-signature-256'), env.APP_SECRET)))
      return new Response('bad signature', {status: 401});

    const body = JSON.parse(raw);
    const msgs = [];
    for (const entry of body.entry || []) {
      for (const ev of entry.messaging || []) {
        const m = ev.message;
        if (!m || m.is_echo || m.is_deleted) continue; // свои ответы и удалённые пропускаем
        const text = m.text || (m.attachments ? '📎 ' + m.attachments.map(a => a.type).join(', ') : '');
        msgs.push({igId: ev.sender.id, t: ev.timestamp || Date.now(), text});
      }
    }
    if (msgs.length) await handle(msgs, env);
    return new Response('EVENT_RECEIVED');
  },
};

async function validSignature(raw, header, secret) {
  if (!secret || !header || !header.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
  const exp = header.slice(7);
  if (hex.length !== exp.length) return false;
  let diff = 0; for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ exp.charCodeAt(i);
  return diff === 0;
}

async function igProfile(igId, env) {
  if (!env.IG_TOKEN) return {};
  try {
    const r = await fetch(`https://graph.instagram.com/v21.0/${igId}?fields=username,name&access_token=${env.IG_TOKEN}`);
    return r.ok ? await r.json() : {};
  } catch { return {}; }
}

const gh = env => ({Authorization: 'Bearer ' + env.GH_TOKEN, Accept: 'application/vnd.github+json', 'User-Agent': 'lepestok-ig-worker'});
const b64dec = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, '')), c => c.charCodeAt(0)));
function b64enc(str) {
  const bytes = new TextEncoder().encode(str); let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function handle(msgs, env) {
  const profiles = {};
  for (const m of msgs) if (!profiles[m.igId]) profiles[m.igId] = await igProfile(m.igId, env);

  const notes = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(DATA_API + '?t=' + Date.now(), {headers: gh(env)});
    let data = {items: [], leads: []}, sha;
    if (r.ok) { const j = await r.json(); data = JSON.parse(b64dec(j.content)); sha = j.sha; }
    else if (r.status !== 404) throw new Error('GitHub ' + r.status);
    data.leads = data.leads || [];
    notes.length = 0;

    for (const m of msgs) {
      const p = profiles[m.igId] || {};
      let lead = data.leads.filter(l => l.igId === m.igId && Date.now() - (l.lastMsg || l.t) < LEAD_WINDOW_MS).sort((a, b) => b.t - a.t)[0];
      const isNew = !lead;
      if (isNew) {
        lead = {id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), t: m.t, by: 'Instagram', source: 'instagram',
                igId: m.igId, ig: p.username || '', name: p.name || (p.username ? '@' + p.username : 'Instagram'),
                contact: '', note: '', bouquet: '', qty: 0, sale: 0, paid: false, courier: 'Самовывоз', deliv: 0, msgs: []};
        data.leads.push(lead);
      }
      lead.msgs = (lead.msgs || []).concat({t: m.t, text: m.text}).slice(-30);
      lead.lastMsg = m.t; lead.unread = true;
      if (p.username && !lead.ig) lead.ig = p.username;
      notes.push(`${isNew ? '🆕 Новый лид' : '💬 Сообщение'} из Instagram\n👤 ${lead.name}${lead.ig ? ' (@' + lead.ig + ')' : ''}\n${m.text}`);
    }

    const put = await fetch(DATA_API, {method: 'PUT', headers: Object.assign(gh(env), {'Content-Type': 'application/json'}),
      body: JSON.stringify(Object.assign({message: 'Instagram: ' + msgs.length + ' сообщ.', content: b64enc(JSON.stringify(data, null, 1))}, sha ? {sha} : {}))});
    if (put.ok) break;
    if (put.status !== 409 && put.status !== 422) throw new Error('GitHub PUT ' + put.status);
  }

  if (env.TG_BOT_TOKEN && env.TG_CHAT_ID)
    for (const text of notes)
      await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({chat_id: env.TG_CHAT_ID, text})});
}

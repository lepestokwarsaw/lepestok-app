/**
 * Lepestok — Instagram ⇄ Telegram.
 * Cloudflare Worker:
 *   /ig    — вебхук Instagram: новые сообщения в Direct → лид в общей базе data.json + уведомление в Telegram
 *   /send  — ответ клиенту из мини-приложения (авторизация тем же ключом доступа к базе)
 *   /tg    — вебхук бота: ответ (reply) на уведомление в Telegram уходит клиенту в Instagram
 *
 * Секреты (Settings → Variables and Secrets, тип Secret) — вводятся вручную, в коде их нет:
 *   VERIFY_TOKEN   — любая строка, та же вписывается в Meta при настройке вебхука
 *   APP_SECRET     — Instagram app secret из Meta for Developers (проверка подписи вебхука)
 *   IG_TOKEN       — Instagram access token (чтение профиля и отправка сообщений)
 *   GH_TOKEN       — тот же GitHub-ключ доступа к lepestok-data, что в приложении
 *   TG_BOT_TOKEN   — токен @LepestokWarsawBot
 *   TG_CHAT_ID     — куда слать уведомления и откуда принимать ответы: твой id или id группы
 *   TG_SECRET      — любая строка, защищает /tg (передаётся Telegram при setWebhook)
 */
const DATA_REPO = 'lepestokwarsaw/lepestok-data';
const DATA_API = `https://api.github.com/repos/${DATA_REPO}/contents/data.json`;
const APP_ORIGIN = 'https://lepestokwarsaw.github.io';
const GRAPH = 'https://graph.instagram.com/v21.0';
const LEAD_WINDOW_MS = 14 * 24 * 3600 * 1000; // новое сообщение в течение 2 недель дописывается в тот же лид

const cors = {'Access-Control-Allow-Origin': APP_ORIGIN, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type'};
const json = (o, status = 200, extra = {}) => new Response(JSON.stringify(o), {status, headers: Object.assign({'Content-Type': 'application/json'}, extra)});

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname === '/ig') return await igWebhook(req, url, env);
      if (url.pathname === '/send') return await sendFromApp(req, env);
      if (url.pathname === '/tg') return await tgWebhook(req, env);
      // однократная привязка бота: /setup?key=TG_SECRET — сервер сам вызывает setWebhook своим токеном
      if (url.pathname === '/setup') {
        if (!env.TG_SECRET || url.searchParams.get('key') !== env.TG_SECRET) return new Response('forbidden', {status: 403});
        const r = await tg(env, 'setWebhook', {url: url.origin + '/tg', secret_token: env.TG_SECRET, allowed_updates: ['message']});
        return json(await r.json());
      }
    } catch (e) {
      return json({error: String(e.message || e)}, 500, url.pathname === '/send' ? cors : {});
    }
    return new Response('Lepestok Instagram ⇄ Telegram', {status: 200});
  },
};

// ---------------- Instagram → лиды ----------------
async function igWebhook(req, url, env) {
  if (req.method === 'GET') { // подтверждение вебхука от Meta
    const ok = url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === env.VERIFY_TOKEN;
    return ok ? new Response(url.searchParams.get('hub.challenge')) : new Response('forbidden', {status: 403});
  }
  const raw = await req.text();
  if (!(await validSignature(raw, req.headers.get('x-hub-signature-256'), env.APP_SECRET)))
    return new Response('bad signature', {status: 401});

  const body = JSON.parse(raw), events = [];
  for (const entry of body.entry || []) {
    for (const ev of entry.messaging || []) {
      const m = ev.message;
      if (!m || m.is_deleted) continue;
      const text = m.text || (m.attachments ? '📎 ' + m.attachments.map(a => a.type).join(', ') : '');
      // is_echo — наш ответ (в т.ч. отправленный прямо из Instagram): клиент = получатель
      events.push(m.is_echo ? {igId: ev.recipient.id, t: ev.timestamp || Date.now(), text, me: true, by: 'Instagram'}
                            : {igId: ev.sender.id, t: ev.timestamp || Date.now(), text});
    }
  }
  if (events.length) await saveMessages(events, env, true);
  return new Response('EVENT_RECEIVED');
}

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
    const r = await fetch(`${GRAPH}/${igId}?fields=username,name&access_token=${env.IG_TOKEN}`);
    return r.ok ? await r.json() : {};
  } catch { return {}; }
}

// ---------------- общая база (GitHub) ----------------
const gh = token => ({Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'User-Agent': 'lepestok-ig-worker'});
const b64dec = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, '')), c => c.charCodeAt(0)));
function b64enc(str) {
  const bytes = new TextEncoder().encode(str); let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
async function mutateData(env, fn, msg) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(DATA_API + '?t=' + Date.now(), {headers: gh(env.GH_TOKEN)});
    let data = {items: [], leads: []}, sha;
    if (r.ok) { const j = await r.json(); data = JSON.parse(b64dec(j.content)); sha = j.sha; }
    else if (r.status !== 404) throw new Error('GitHub ' + r.status);
    data.leads = data.leads || [];
    const out = fn(data);
    const put = await fetch(DATA_API, {method: 'PUT', headers: Object.assign(gh(env.GH_TOKEN), {'Content-Type': 'application/json'}),
      body: JSON.stringify(Object.assign({message: msg, content: b64enc(JSON.stringify(data, null, 1))}, sha ? {sha} : {}))});
    if (put.ok) return out;
    if (put.status !== 409 && put.status !== 422) throw new Error('GitHub PUT ' + put.status);
  }
  throw new Error('GitHub: конфликт сохранения');
}

const recentLead = (data, igId) => data.leads.filter(l => l.igId === igId && Date.now() - (l.lastMsg || l.t) < LEAD_WINDOW_MS).sort((a, b) => b.t - a.t)[0];

// сохранить сообщения (входящие и наши) в лиды; уведомить о входящих
async function saveMessages(events, env, notify) {
  const profiles = {};
  for (const e of events) if (!e.me && !profiles[e.igId]) profiles[e.igId] = await igProfile(e.igId, env);

  const notes = await mutateData(env, data => {
    const notes = [];
    for (const e of events) {
      const p = profiles[e.igId] || {};
      let lead = recentLead(data, e.igId);
      if (!lead && e.me) continue; // наш ответ клиенту, которого нет в базе — пропускаем
      const isNew = !lead;
      if (isNew) {
        lead = {id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), t: e.t, by: 'Instagram', source: 'instagram',
                igId: e.igId, ig: p.username || '', name: p.name || (p.username ? '@' + p.username : 'Instagram'),
                contact: '', note: '', bouquet: '', qty: 0, sale: 0, paid: false, courier: 'Самовывоз', deliv: 0, msgs: []};
        data.leads.push(lead);
      }
      const msgs = lead.msgs || [];
      if (e.me && msgs.some(m => m.me && m.text === e.text && Math.abs(m.t - e.t) < 120000)) continue; // уже записано при отправке
      lead.msgs = msgs.concat(e.me ? {t: e.t, text: e.text, me: true, by: e.by} : {t: e.t, text: e.text}).slice(-50);
      lead.lastMsg = e.t;
      if (!e.me) {
        lead.unread = true;
        if (p.username && !lead.ig) lead.ig = p.username;
        notes.push(`${isNew ? '🆕 Новый лид' : '💬 Сообщение'} из Instagram\n👤 ${lead.name}${lead.ig ? ' (@' + lead.ig + ')' : ''}\n\n${e.text}\n\n↩️ Ответь на это сообщение — ответ уйдёт клиенту в Instagram\n🆔 ig:${e.igId}`);
      }
    }
    return notes;
  }, 'Instagram: ' + events.length + ' сообщ.');

  if (notify && env.TG_BOT_TOKEN && env.TG_CHAT_ID)
    for (const text of notes) await tg(env, 'sendMessage', {chat_id: env.TG_CHAT_ID, text});
}

// ---------------- отправка в Instagram ----------------
async function igSend(env, igId, text) {
  const r = await fetch(`${GRAPH}/me/messages`, {method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + env.IG_TOKEN},
    body: JSON.stringify({recipient: {id: igId}, message: {text}})});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = j.error || {};
    if (e.error_subcode === 2534022 || /outside of allowed window/i.test(e.message || ''))
      throw new Error('Прошло больше 24 часов с последнего сообщения клиента — Instagram не даёт ответить. Напиши клиенту из самого Instagram.');
    throw new Error('Instagram: ' + (e.message || r.status));
  }
  return j;
}
async function recordSent(env, igId, text, by) {
  await mutateData(env, data => {
    const lead = recentLead(data, igId) || data.leads.filter(l => l.igId === igId).sort((a, b) => b.t - a.t)[0];
    if (!lead) return;
    lead.msgs = (lead.msgs || []).concat({t: Date.now(), text, me: true, by}).slice(-50);
    lead.lastMsg = Date.now(); delete lead.unread;
  }, 'Ответ в Instagram');
}

// из мини-приложения: {key, igId, text, by}; key = ключ доступа к базе (проверяем у GitHub)
async function sendFromApp(req, env) {
  if (req.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors});
  if (req.method !== 'POST') return json({error: 'method'}, 405, cors);
  const {key, igId, text, by} = await req.json();
  if (!key || !igId || !String(text || '').trim()) return json({error: 'Пустое сообщение'}, 400, cors);
  const auth = await fetch(`https://api.github.com/repos/${DATA_REPO}`, {headers: gh(key)});
  if (!auth.ok) return json({error: 'Нет доступа'}, 403, cors);
  try {
    await igSend(env, igId, text.trim());
    await recordSent(env, igId, text.trim(), by || 'приложение');
    return json({ok: true}, 200, cors);
  } catch (e) { return json({error: e.message}, 400, cors); }
}

// ---------------- Telegram-бот ----------------
const tg = (env, method, body) => fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${method}`,
  {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});

async function tgWebhook(req, env) {
  if (req.method !== 'POST' || req.headers.get('x-telegram-bot-api-secret-token') !== env.TG_SECRET)
    return new Response('forbidden', {status: 403});
  const upd = await req.json(), m = upd.message;
  if (!m || String(m.chat.id) !== String(env.TG_CHAT_ID)) return new Response('ok');
  const orig = m.reply_to_message && (m.reply_to_message.text || '');
  const found = orig && orig.match(/🆔 ig:(\d+)/);
  if (!found) {
    if (m.text && !m.text.startsWith('/'))
      await tg(env, 'sendMessage', {chat_id: m.chat.id, reply_to_message_id: m.message_id,
        text: 'Чтобы ответить клиенту, нажми «Ответить» (reply) на уведомление о его сообщении.'});
    return new Response('ok');
  }
  const by = m.from && m.from.username ? '@' + m.from.username : (m.from && m.from.first_name) || 'Telegram';
  try {
    await igSend(env, found[1], m.text || '');
    await recordSent(env, found[1], m.text || '', by);
    await tg(env, 'setMessageReaction', {chat_id: m.chat.id, message_id: m.message_id, reaction: [{type: 'emoji', emoji: '👍'}]});
  } catch (e) {
    await tg(env, 'sendMessage', {chat_id: m.chat.id, reply_to_message_id: m.message_id, text: '⚠️ Не отправлено: ' + e.message});
  }
  return new Response('ok');
}

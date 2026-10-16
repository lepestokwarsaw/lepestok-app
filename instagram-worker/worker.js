/**
 * Lepestok — Instagram ⇄ Telegram.
 * Cloudflare Worker:
 *   /ig    — вебхук Instagram: новые сообщения в Direct → лид в общей базе data.json + уведомление в Telegram
 *   /send  — ответ клиенту из мини-приложения (авторизация тем же ключом доступа к базе)
 *   /tg    — вебхук бота: ответ (reply) на уведомление в Telegram уходит клиенту в Instagram (текст или фото)
 *   /media — отдаёт фото для Instagram по подписанной ссылке (фото из бота или из приложения)
 *   /subscribe, /unsubscribe — вход/выход в мини-приложении: кто вошёл, тому бот шлёт уведомления и от того принимает ответы
 *
 * Секреты (Settings → Variables and Secrets, тип Secret) — вводятся вручную, в коде их нет:
 *   VERIFY_TOKEN   — любая строка, та же вписывается в Meta при настройке вебхука
 *   APP_SECRET     — Instagram app secret из Meta for Developers (проверка подписи вебхука)
 *   IG_TOKEN       — Instagram access token (чтение профиля и отправка сообщений)
 *   GH_TOKEN       — тот же GitHub-ключ доступа к lepestok-data, что в приложении
 *   TG_BOT_TOKEN   — токен @LepestokWarsawBot
 *   TG_CHAT_ID     — владелец: получает уведомления всегда (плюс все, кто вошёл в приложение — список в KV 'subs')
 *   TG_SECRET      — любая строка, защищает /tg (передаётся Telegram при setWebhook)
 *
 * KV (binding IG_KV): ключ 'ig_token' = {token, expires_at, refreshed_at} — продлённый токен.
 * Cron Trigger "0 6 * * 1" → scheduled(): раз в неделю продлевает токен (живёт ~60 дней).
 * Ручной запуск: /refresh?key=TG_SECRET
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
      if (url.pathname === '/media') return await serveMedia(url, env);
      if (url.pathname === '/subscribe' || url.pathname === '/unsubscribe') return await subscription(req, env, url.pathname === '/subscribe');
      // однократная привязка бота: /setup?key=TG_SECRET — сервер сам вызывает setWebhook своим токеном
      if (url.pathname === '/setup') {
        if (!env.TG_SECRET || url.searchParams.get('key') !== env.TG_SECRET) return new Response('forbidden', {status: 403});
        const r = await tg(env, 'setWebhook', {url: url.origin + '/tg', secret_token: env.TG_SECRET, allowed_updates: ['message']});
        return json(await r.json());
      }
      if (url.pathname === '/refresh') {
        if (!env.TG_SECRET || url.searchParams.get('key') !== env.TG_SECRET) return new Response('forbidden', {status: 403});
        return json(await refreshToken(env));
      }
    } catch (e) {
      return json({error: String(e.message || e)}, 500, url.pathname === '/send' ? cors : {});
    }
    return new Response('Lepestok Instagram ⇄ Telegram', {status: 200});
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshToken(env).catch(async e => {
      if (env.TG_BOT_TOKEN && env.TG_CHAT_ID)
        await tg(env, 'sendMessage', {chat_id: env.TG_CHAT_ID, text: '⚠️ Не удалось продлить Instagram-токен: ' + e.message + '\nОбнови секрет IG_TOKEN вручную, иначе Instagram перестанет работать.'});
    }));
  },
};

// ---------------- Instagram-токен (продление) ----------------
const KV_TOKEN = 'ig_token';
async function getToken(env) {
  if (env.IG_KV) {
    const v = await env.IG_KV.get(KV_TOKEN, 'json');
    if (v && v.token) return v.token;
  }
  return env.IG_TOKEN;
}
async function refreshToken(env) {
  if (!env.IG_KV) throw new Error('нет KV-привязки IG_KV');
  const cur = await getToken(env);
  if (!cur) throw new Error('нет токена');
  const r = await fetch('https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=' + encodeURIComponent(cur));
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('Instagram: ' + ((j.error && j.error.message) || r.status));
  const rec = {token: j.access_token, expires_at: Date.now() + (j.expires_in || 0) * 1000, refreshed_at: Date.now()};
  await env.IG_KV.put(KV_TOKEN, JSON.stringify(rec));
  return {ok: true, expires_in: j.expires_in, expires_at: new Date(rec.expires_at).toISOString()};
}

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
    // журнал (Cloudflare → Observability): что именно прислала Meta, без текста сообщений
    console.log('ig event', JSON.stringify({changes: (entry.changes || []).map(c => c.field),
      messaging: (entry.messaging || []).map(ev => ({from: ev.sender && ev.sender.id, to: ev.recipient && ev.recipient.id,
        kind: ev.message ? (ev.message.is_echo ? 'echo' : ev.message.is_deleted ? 'deleted' : 'message') : Object.keys(ev).filter(k => !['sender', 'recipient', 'timestamp'].includes(k)).join(',')}))}));
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
  const token = await getToken(env);
  if (!token) return {};
  try {
    const r = await fetch(`${GRAPH}/${igId}?fields=username,name&access_token=${token}`);
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

// удалённые в приложении лиды остаются в базе с deleted:true — их не трогаем
const recentLead = (data, igId) => data.leads.filter(l => !l.deleted && l.igId === igId && Date.now() - (l.lastMsg || l.t) < LEAD_WINDOW_MS).sort((a, b) => b.t - a.t)[0];

// сохранить сообщения (входящие и наши) в лиды; уведомить о входящих
async function saveMessages(events, env, notify) {
  const profiles = {};
  for (const e of events) if (!profiles[e.igId]) profiles[e.igId] = await igProfile(e.igId, env);

  const notes = await mutateData(env, data => {
    const notes = [];
    for (const e of events) {
      const p = profiles[e.igId] || {};
      let lead = recentLead(data, e.igId);
      // магазин сам написал клиенту, которого нет в базе (например, лид удалили) — тоже заводим лид
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
      if (e.me && p.username && !lead.ig) lead.ig = p.username;
      if (!e.me) {
        lead.unread = true;
        if (p.username && !lead.ig) lead.ig = p.username;
        notes.push(`${isNew ? '🆕 Новый лид' : '💬 Сообщение'} из Instagram\n👤 ${lead.name}${lead.ig ? ' (@' + lead.ig + ')' : ''}\n\n${e.text}\n\n↩️ Ответь на это сообщение — ответ уйдёт клиенту в Instagram\n🆔 ig:${e.igId}`);
      }
    }
    return notes;
  }, 'Instagram: ' + events.length + ' сообщ.');

  if (notify && env.TG_BOT_TOKEN) {
    const to = await recipients(env);
    for (const text of notes) for (const chat_id of to) await tg(env, 'sendMessage', {chat_id, text}).catch(() => {});
  }
}

// ---------------- фото для Instagram ----------------
// Instagram забирает картинку по публичной ссылке. Даём ссылку на этот же сервер с HMAC-подписью (TG_SECRET),
// без неё /media ничего не отдаёт. Источник: файл Telegram (tg:<file_id>) или фото из приложения в KV (kv:<id>, живёт 2 дня).
async function hmacHex(key, text) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function mediaUrl(origin, env, src) {
  return `${origin}/media?src=${encodeURIComponent(src)}&s=${(await hmacHex(env.TG_SECRET, src)).slice(0, 32)}`;
}
async function serveMedia(url, env) {
  const src = url.searchParams.get('src') || '';
  if (!env.TG_SECRET || url.searchParams.get('s') !== (await hmacHex(env.TG_SECRET, src)).slice(0, 32)) return new Response('forbidden', {status: 403});
  if (src.startsWith('tg:')) {
    const f = await (await tg(env, 'getFile', {file_id: src.slice(3)})).json();
    if (!f.ok) return new Response('not found', {status: 404});
    const r = await fetch(`https://api.telegram.org/file/bot${env.TG_BOT_TOKEN}/${f.result.file_path}`);
    return new Response(r.body, {status: r.status, headers: {'Content-Type': r.headers.get('content-type') || 'image/jpeg', 'Cache-Control': 'private, max-age=3600'}});
  }
  if (src.startsWith('kv:') && env.IG_KV) {
    const buf = await env.IG_KV.get('img:' + src.slice(3), 'arrayBuffer');
    if (!buf) return new Response('not found', {status: 404});
    return new Response(buf, {headers: {'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600'}});
  }
  return new Response('not found', {status: 404});
}

// ---------------- отправка в Instagram ----------------
async function igSend(env, igId, text, imageUrl) {
  const message = imageUrl ? {attachment: {type: 'image', payload: {url: imageUrl}}} : {text};
  const r = await fetch(`${GRAPH}/me/messages`, {method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + (await getToken(env))},
    body: JSON.stringify({recipient: {id: igId}, message})});
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
    const lead = recentLead(data, igId) || data.leads.filter(l => !l.deleted && l.igId === igId).sort((a, b) => b.t - a.t)[0];
    if (!lead) return;
    lead.msgs = (lead.msgs || []).concat({t: Date.now(), text, me: true, by}).slice(-50);
    lead.lastMsg = Date.now(); delete lead.unread;
  }, 'Ответ в Instagram');
}

// из мини-приложения: {key, igId, text, by}; key = ключ доступа к базе (проверяем у GitHub)
async function sendFromApp(req, env) {
  if (req.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors});
  if (req.method !== 'POST') return json({error: 'method'}, 405, cors);
  const {key, igId, text, by, image} = await req.json();
  const t = String(text || '').trim();
  if (!key || !igId || (!t && !image)) return json({error: 'Пустое сообщение'}, 400, cors);
  const auth = await fetch(`https://api.github.com/repos/${DATA_REPO}`, {headers: gh(key)});
  if (!auth.ok) return json({error: 'Нет доступа'}, 403, cors);
  try {
    if (image) {
      if (!env.IG_KV) throw new Error('на сервере нет хранилища для фото (IG_KV)');
      const bin = Uint8Array.from(atob(String(image).replace(/^data:[^,]*,/, '')), c => c.charCodeAt(0));
      if (bin.length > 8 * 1024 * 1024) throw new Error('фото слишком большое');
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      await env.IG_KV.put('img:' + id, bin, {expirationTtl: 2 * 24 * 3600});
      await igSend(env, igId, '', await mediaUrl(new URL(req.url).origin, env, 'kv:' + id));
      await recordSent(env, igId, '📷 фото', by || 'приложение');
    }
    if (t) { await igSend(env, igId, t); await recordSent(env, igId, t, by || 'приложение'); }
    return json({ok: true}, 200, cors);
  } catch (e) { return json({error: e.message}, 400, cors); }
}

// ---------------- подписчики уведомлений ----------------
// Кто вошёл в мини-приложение (есть ключ доступа к базе + проверенные данные Telegram), тот в списке 'subs'.
async function recipients(env) {
  const subs = env.IG_KV ? (await env.IG_KV.get('subs', 'json')) || [] : [];
  return [...new Set([env.TG_CHAT_ID, ...subs.map(s => s.id)].filter(Boolean).map(String))];
}
// проверка initData мини-приложения (подпись Telegram ключом бота)
async function tgUser(initData, env) {
  const p = new URLSearchParams(initData || ''), hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const check = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const k1 = await crypto.subtle.importKey('raw', new TextEncoder().encode('WebAppData'), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const secret = await crypto.subtle.sign('HMAC', k1, new TextEncoder().encode(env.TG_BOT_TOKEN));
  const k2 = await crypto.subtle.importKey('raw', secret, {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const sig = [...new Uint8Array(await crypto.subtle.sign('HMAC', k2, new TextEncoder().encode(check)))].map(b => b.toString(16).padStart(2, '0')).join('');
  if (sig !== hash) return null;
  try { return JSON.parse(p.get('user')); } catch { return null; }
}
async function subscription(req, env, on) {
  if (req.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors});
  const {key, initData} = await req.json();
  const auth = await fetch(`https://api.github.com/repos/${DATA_REPO}`, {headers: gh(key || '')});
  if (!auth.ok) return json({error: 'Нет доступа'}, 403, cors);
  const u = await tgUser(initData, env);
  if (!u || !u.id) return json({error: 'Открой приложение через бота'}, 400, cors);
  if (!env.IG_KV) return json({error: 'нет хранилища IG_KV'}, 500, cors);
  const subs = ((await env.IG_KV.get('subs', 'json')) || []).filter(s => String(s.id) !== String(u.id));
  if (on) subs.push({id: String(u.id), name: u.username ? '@' + u.username : [u.first_name, u.last_name].filter(Boolean).join(' '), t: Date.now()});
  await env.IG_KV.put('subs', JSON.stringify(subs));
  return json({ok: true, subscribed: on, count: subs.length}, 200, cors);
}

// ---------------- Telegram-бот ----------------
const tg = (env, method, body) => fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${method}`,
  {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});

async function tgWebhook(req, env) {
  if (req.method !== 'POST' || req.headers.get('x-telegram-bot-api-secret-token') !== env.TG_SECRET)
    return new Response('forbidden', {status: 403});
  const upd = await req.json(), m = upd.message;
  if (!m) return new Response('ok');
  if (!(await recipients(env)).includes(String(m.chat.id))) {
    if (m.text && m.text.startsWith('/start'))
      await tg(env, 'sendMessage', {chat_id: m.chat.id, text: '🌸 Lepestok: нажми кнопку «Открыть» и войди в приложение — после входа сюда будут приходить сообщения клиентов из Instagram, и на них можно отвечать.'});
    return new Response('ok');
  }
  const orig = m.reply_to_message && (m.reply_to_message.text || '');
  const found = orig && orig.match(/🆔 ig:(\d+)/);
  if (!found) {
    if ((m.text && !m.text.startsWith('/')) || m.photo)
      await tg(env, 'sendMessage', {chat_id: m.chat.id, reply_to_message_id: m.message_id,
        text: 'Чтобы ответить клиенту, нажми «Ответить» (reply) на уведомление о его сообщении.'});
    return new Response('ok');
  }
  const by = m.from && m.from.username ? '@' + m.from.username : (m.from && m.from.first_name) || 'Telegram';
  const photo = m.photo && m.photo.length ? m.photo[m.photo.length - 1].file_id
    : m.document && /^image\//.test(m.document.mime_type || '') ? m.document.file_id : null;
  const text = (m.text || m.caption || '').trim();
  try {
    if (!photo && !text) throw new Error('можно отправить текст или фото');
    if (photo) {
      await igSend(env, found[1], '', await mediaUrl(new URL(req.url).origin, env, 'tg:' + photo));
      await recordSent(env, found[1], '📷 фото', by);
    }
    if (text) { await igSend(env, found[1], text); await recordSent(env, found[1], text, by); }
    await tg(env, 'setMessageReaction', {chat_id: m.chat.id, message_id: m.message_id, reaction: [{type: 'emoji', emoji: '👍'}]});
  } catch (e) {
    await tg(env, 'sendMessage', {chat_id: m.chat.id, reply_to_message_id: m.message_id, text: '⚠️ Не отправлено: ' + e.message});
  }
  return new Response('ok');
}

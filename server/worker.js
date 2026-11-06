// Grindboard server: accounts, sync, phone notifications and the AI coach. Runs on Cloudflare Workers. No secrets in this file.
const VAPID_PUBLIC = "BPAevOlTry9dJFulfjc_aFErrAS1yDGua_m365qrCRiTOkiCfAjjwm7KxLV3AwPnH9AdBBn4TJ0dLoMBqP9jpnI";
let VAPID_PRIVATE_JWK = null;   // kept in Cloudflare as the secret VAPID_JWK
const APP = "https://omareleter.github.io";
const CONTACT = "https://omareleter.github.io/grindboard/";
const MODEL = "claude-haiku-5-5";

const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; a.forEach(x => { o.set(x, i); i += x.length; }); return o; };
async function hmac(key, data){ const k = await crypto.subtle.importKey("raw", key, {name:"HMAC", hash:"SHA-256"}, false, ["sign"]); return new Uint8Array(await crypto.subtle.sign("HMAC", k, data)); }

async function vapidHeader(endpoint){
  const aud = new URL(endpoint).origin;
  const head = b64u(enc.encode(JSON.stringify({typ:"JWT", alg:"ES256"})));
  const body = b64u(enc.encode(JSON.stringify({aud, exp: Math.floor(Date.now()/1000) + 12*3600, sub: CONTACT})));
  const key = await crypto.subtle.importKey("jwk", VAPID_PRIVATE_JWK, {name:"ECDSA", namedCurve:"P-256"}, false, ["sign"]);
  const sig = await crypto.subtle.sign({name:"ECDSA", hash:"SHA-256"}, key, enc.encode(head + "." + body));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${VAPID_PUBLIC}`;
}
async function encryptPayload(sub, text){
  const uaPub = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const eph = await crypto.subtle.generateKey({name:"ECDH", namedCurve:"P-256"}, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, {name:"ECDH", namedCurve:"P-256"}, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({name:"ECDH", public: uaKey}, eph.privateKey, 256));
  const prkKey = await hmac(auth, secret);
  const ikm = await hmac(prkKey, cat(enc.encode("WebPush: info\0"), uaPub, asPub, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, cat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek, {name:"AES-GCM"}, false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM", iv: nonce}, key, cat(enc.encode(text), new Uint8Array([2]))));
  return cat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([65]), asPub, ct);
}
async function sendPush(sub, msg){
  const res = await fetch(sub.endpoint, {method:"POST", headers:{
    "Authorization": await vapidHeader(sub.endpoint), "Content-Encoding":"aes128gcm", "Content-Type":"application/octet-stream", "TTL":"3600", "Urgency":"high"
  }, body: await encryptPayload(sub, JSON.stringify(msg))});
  return res.status;
}

const cors = origin => ({"Access-Control-Allow-Origin": APP, "Access-Control-Allow-Methods":"GET, POST, PUT, DELETE, OPTIONS", "Access-Control-Allow-Headers":"Content-Type, Authorization", "Access-Control-Max-Age":"86400", "Vary":"Origin"});
const json = (data, origin, status = 200) => new Response(JSON.stringify(data), {status, headers:{"Content-Type":"application/json", ...cors(origin)}});
async function subId(endpoint){ return b64u(await crypto.subtle.digest("SHA-256", enc.encode(endpoint))).slice(0, 22); }
async function loadAll(env){ return (await env.GB.get("subs", "json")) || {}; }

async function handleSubscribe(req, env, origin){
  const b = await req.json();
  if (!b.sub || !b.sub.endpoint || !b.sub.keys || !/^https:\/\//.test(b.sub.endpoint)) return json({error:"bad subscription"}, origin, 400);
  const items = (b.items || []).filter(x => /^\d{2}:\d{2}$/.test(x.t)).slice(0, 40).map(x => { const o = {t: x.t, title: String(x.title || "Time for your next task").slice(0, 120)}; if (x.body) o.body = String(x.body).slice(0, 160); if (Number.isInteger(x.dow) && x.dow >= 0 && x.dow <= 6) o.dow = x.dow; return o; });
  const all = await loadAll(env), id = await subId(b.sub.endpoint);
  all[id] = {sub: {endpoint: b.sub.endpoint, keys: {p256dh: b.sub.keys.p256dh, auth: b.sub.keys.auth}}, tz: String(b.tz || "Europe/London").slice(0, 60), items};
  await env.GB.put("subs", JSON.stringify(all));
  if (b.test) await sendPush(all[id].sub, {title:"Grindboard", body:"Notifications are on. You'll get a nudge at each task time."});
  return json({ok:true, id}, origin);
}
async function handleUnsubscribe(req, env, origin){
  const b = await req.json(); const all = await loadAll(env), id = await subId(b.endpoint || "");
  if (all[id]) { delete all[id]; await env.GB.put("subs", JSON.stringify(all)); }
  return json({ok:true}, origin);
}
const FREE_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";   // Cloudflare's built-in AI: free up to 10,000 "neurons" a day (~70 questions)
async function handleAI(req, env, origin){
  if (!env.AI && !env.ANTHROPIC_API_KEY) return json({error:"The AI isn't connected yet."}, origin, 500);
  const who = await authUser(req, env);
  if (!who) return json({error:"Sign in to chat with your coach.", needAuth: true}, origin, 401);
  const pday = new Date().toISOString().slice(0, 10), pkey = "aiu:" + pday + ":" + who.id, pused = Number(await env.GB.get(pkey) || 0), plimit = Number(env.AI_USER_LIMIT || 25);
  if (pused >= plimit) return json({error:"You've used all " + plimit + " coach messages for today. Back tomorrow 💪"}, origin, 429);
  await env.GB.put(pkey, String(pused + 1), {expirationTtl: 2 * 86400});
  const day = new Date().toISOString().slice(0, 10), limit = Number(env.AI_DAILY_LIMIT || (env.AI ? 60 : 200));
  const used = Number(await env.GB.get("ai:" + day) || 0);
  if (used >= limit) return json({error:"The coach has answered all its free questions for today. Try again tomorrow."}, origin, 429);
  const b = await req.json();
  const messages = (b.messages || []).slice(-8).map(m => ({role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "").slice(0, 2000)})).filter(m => m.content);
  while (messages.length && messages[0].role !== "user") messages.shift();
  if (!messages.length) return json({error:"Type a message first."}, origin, 400);
  const system = "You are the coach inside Grindboard, a daily routine and side-hustle app. You are the user's buddy and mentor: warm, real and direct, like a friend who wants them to win. Chat naturally. If they just say something casual like ok, thanks, lol or good morning, reply briefly and warmly like a friend would (one or two short sentences), with no lecture and no repeated advice. If they share news or feelings, react like a friend first, then help if it fits. Use plain, simple English (the user may not be very technical). Keep answers short: a few sentences or up to 5 bullet points, never long essays. Base what you say on the user's data below, quote their real numbers, and give concrete next steps. Never give personalised financial or investment advice, never tell them to take a specific trade, and don't make medical claims. If the data is too thin to judge, say so and tell them what to log. \n\nYOU CAN CHANGE THE APP FOR THEM. When the user asks you to add, schedule, tick off or remove something, do it by writing one action line per item, exactly in this format, each on its own line:\n[[ADD_TASK: task text | due: today]]   (due can be today, tomorrow, week, a date like 2026-11-20, or none; add | high for urgent items)\n[[ADD_ROUTINE: 07:30 | task title]]   (for something they want to do every day at a set time)\n[[DONE_TASK: exact text of an open to-do]]\n[[REMOVE_TASK: exact text of an open to-do]]\nChecklist, to-do list and task list all mean ADD_TASK. Use ADD_ROUTINE only when they say every day, daily or routine. After the action lines, confirm in one short friendly sentence what you did. Only use actions when they ask you to change something, never on your own. You cannot change anything else in the app, so if they ask for something else, tell them how to do it themselves.\n\nTHE USER'S DATA:\n" + String(b.context || "").slice(0, 12000);
  await env.GB.put("ai:" + day, String(used + 1), {expirationTtl: 3 * 86400});
  if (env.AI) {
    try {
      const out = await env.AI.run(env.AI_MODEL || FREE_MODEL, {messages: [{role:"system", content: system}, ...messages], max_tokens: 600, temperature: 0.6});
      const text = typeof out.response === "string" ? out.response : (out.response && out.response.text) || (out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content) || "";
      if (!text) return json({error:"The coach couldn't answer right now. Try again."}, origin, 502);
      return json({text: String(text).trim()}, origin);
    } catch (e) {
      return json({error: /neuron|limit|quota|429/i.test(String(e)) ? "The coach has used up today's free AI. Try again tomorrow." : "The coach couldn't answer right now. Try again."}, origin, 502);
    }
  }
  const r = await fetch("https://api.anthropic.com/v1/messages", {method:"POST", headers:{"x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version":"2023-06-01", "content-type":"application/json"},
    body: JSON.stringify({model: env.AI_MODEL || MODEL, max_tokens: 700, system, messages})});
  const data = await r.json();
  if (!r.ok) return json({error: (data.error && data.error.message) || "The coach couldn't answer right now."}, origin, 502);
  return json({text: (data.content || []).filter(c => c.type === "text").map(c => c.text).join("\n").trim()}, origin);
}

/* ---------- accounts + sync (Cloudflare D1) ---------- */
const sha = async t => b64u(await crypto.subtle.digest("SHA-256", enc.encode(t)));
const rid = n => b64u(crypto.getRandomValues(new Uint8Array(n)));
const cleanEmail = e => String(e || "").trim().toLowerCase().slice(0, 200);
async function authUser(req, env){
  if (!env.DB) return null;
  const h = req.headers.get("Authorization") || "", tok = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!tok || tok.length < 20) return null;
  return await env.DB.prepare("SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.uid WHERE s.token = ?").bind(await sha(tok)).first();
}
async function newSession(env, uid){ const tok = rid(32); await env.DB.prepare("INSERT INTO sessions (token, uid, created) VALUES (?, ?, ?)").bind(await sha(tok), uid, Date.now()).run(); return tok; }
async function handleSignup(req, env, origin){
  const b = await req.json(), email = cleanEmail(b.email), hash = String(b.hash || ""), name = String(b.name || "").trim().slice(0, 60);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({error:"That email doesn't look right."}, origin, 400);
  if (hash.length < 20) return json({error:"Password problem, try again."}, origin, 400);
  if (await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first()) return json({error:"There's already an account with that email. Tap Sign in instead."}, origin, 409);
  const id = rid(12), salt = rid(16);
  await env.DB.prepare("INSERT INTO users (id, email, pw, salt, name, created) VALUES (?, ?, ?, ?, ?, ?)").bind(id, email, await sha(salt + hash), salt, name, Date.now()).run();
  return json({token: await newSession(env, id), user: {email, name}}, origin);
}
async function handleLogin(req, env, origin){
  const b = await req.json(), email = cleanEmail(b.email), hash = String(b.hash || "");
  const fk = "fail:" + email, fails = Number(await env.GB.get(fk) || 0);
  if (fails >= 10) return json({error:"Too many wrong tries. Wait 15 minutes and try again."}, origin, 429);
  const u = await env.DB.prepare("SELECT id, email, name, pw, salt FROM users WHERE email = ?").bind(email).first();
  if (!u || u.pw !== await sha(u.salt + hash)) { await env.GB.put(fk, String(fails + 1), {expirationTtl: 900}); return json({error:"Wrong email or password."}, origin, 401); }
  return json({token: await newSession(env, u.id), user: {email: u.email, name: u.name}}, origin);
}
async function handleLogout(req, env, origin){
  const h = req.headers.get("Authorization") || ""; if (h.startsWith("Bearer ")) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(await sha(h.slice(7).trim())).run();
  return json({ok:true}, origin);
}
async function handleSync(req, env, origin, who){
  if (req.method === "GET") { const r = await env.DB.prepare("SELECT data, updated FROM states WHERE uid = ?").bind(who.id).first();
    return json(r ? {data: r.data, updated: r.updated, user: {email: who.email, name: who.name}} : {data: null, updated: 0, user: {email: who.email, name: who.name}}, origin); }
  const b = await req.json(), data = String(b.data || "");
  if (!data || data.length > 3000000) return json({error:"Your data is too big to sync."}, origin, 413);
  const cur = await env.DB.prepare("SELECT updated FROM states WHERE uid = ?").bind(who.id).first();
  if (cur && !b.force && Number(b.base || 0) < cur.updated) { const r = await env.DB.prepare("SELECT data, updated FROM states WHERE uid = ?").bind(who.id).first(); return json({conflict: true, data: r.data, updated: r.updated}, origin, 409); }
  const now = Math.max(Date.now(), cur ? cur.updated + 1 : 0);
  await env.DB.prepare("INSERT INTO states (uid, data, updated) VALUES (?, ?, ?) ON CONFLICT(uid) DO UPDATE SET data = excluded.data, updated = excluded.updated").bind(who.id, data, now).run();
  return json({ok:true, updated: now}, origin);
}
async function handlePhoto(req, env, origin, who, key){
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(key)) return json({error:"bad key"}, origin, 400);
  if (req.method === "PUT") { const buf = await req.arrayBuffer(); if (!buf.byteLength || buf.byteLength > 1500000) return json({error:"Photo too big"}, origin, 413);
    await env.DB.prepare("INSERT INTO photos (uid, k, mime, data) VALUES (?, ?, ?, ?) ON CONFLICT(uid, k) DO UPDATE SET mime = excluded.mime, data = excluded.data").bind(who.id, key, (req.headers.get("Content-Type") || "image/jpeg").slice(0, 40), buf).run();
    return json({ok:true}, origin); }
  const r = await env.DB.prepare("SELECT mime, data FROM photos WHERE uid = ? AND k = ?").bind(who.id, key).first();
  if (!r) return json({error:"not found"}, origin, 404);
  return new Response(new Uint8Array(r.data), {headers: {"Content-Type": r.mime || "image/jpeg", "Cache-Control":"private, max-age=31536000", ...cors(origin)}});
}
async function handlePhotoList(env, origin, who){ const r = await env.DB.prepare("SELECT k FROM photos WHERE uid = ?").bind(who.id).all(); return json({keys: (r.results || []).map(x => x.k)}, origin); }

function localDow(tz){ try { return ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(new Intl.DateTimeFormat("en-GB", {timeZone: tz, weekday:"short"}).format(new Date())); } catch (e) { return new Date().getUTCDay(); } }
function localHM(tz){
  try { return new Intl.DateTimeFormat("en-GB", {timeZone: tz, hour:"2-digit", minute:"2-digit", hour12:false}).format(new Date()).replace(/^24/, "00"); }
  catch (e) { return new Date().toISOString().slice(11, 16); }
}

export default {
  async fetch(req, env){
    if (!VAPID_PRIVATE_JWK && env.VAPID_JWK) VAPID_PRIVATE_JWK = JSON.parse(env.VAPID_JWK);
    const origin = req.headers.get("Origin") || "", url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, {headers: cors(origin)});
    if (req.method === "GET" && url.pathname === "/") return json({ok:true, app:"grindboard", push: !!env.GB, ai: !!(env.AI || env.ANTHROPIC_API_KEY), accounts: !!env.DB}, origin);
    if (origin !== APP) return json({error:"forbidden"}, origin, 403);
    if (!env.GB) return json({error:"Storage isn't connected yet."}, origin, 500);
    try {
      if (url.pathname.startsWith("/auth/") || url.pathname === "/sync" || url.pathname.startsWith("/photo")) {
        if (!env.DB) return json({error:"Accounts aren't switched on yet."}, origin, 500);
        if (url.pathname === "/auth/signup" && req.method === "POST") return await handleSignup(req, env, origin);
        if (url.pathname === "/auth/login" && req.method === "POST") return await handleLogin(req, env, origin);
        if (url.pathname === "/auth/logout" && req.method === "POST") return await handleLogout(req, env, origin);
        const who = await authUser(req, env); if (!who) return json({error:"Please sign in again.", needAuth: true}, origin, 401);
        if (url.pathname === "/sync") return await handleSync(req, env, origin, who);
        if (url.pathname === "/photos" && req.method === "GET") return await handlePhotoList(env, origin, who);
        if (url.pathname.startsWith("/photo/")) return await handlePhoto(req, env, origin, who, url.pathname.slice(7));
      }
      if (req.method !== "POST") return json({error:"not found"}, origin, 404);
      if (url.pathname === "/subscribe") return await handleSubscribe(req, env, origin);
      if (url.pathname === "/unsubscribe") return await handleUnsubscribe(req, env, origin);
      if (url.pathname === "/ai") return await handleAI(req, env, origin);
    } catch (e) { return json({error: String(e && e.message || e)}, origin, 500); }
    return json({error:"not found"}, origin, 404);
  },
  async scheduled(event, env, ctx){
    if (!VAPID_PRIVATE_JWK && env.VAPID_JWK) VAPID_PRIVATE_JWK = JSON.parse(env.VAPID_JWK);
    if (!env.GB) return;
    const all = await loadAll(env); let changed = false; const jobs = [];
    for (const [id, s] of Object.entries(all)) {
      const now = localHM(s.tz), dow = localDow(s.tz);
      for (const it of s.items || []) if (it.t === now && (it.dow === undefined || it.dow === dow)) jobs.push(sendPush(s.sub, {title: it.title, body: it.body || "Tap to open Grindboard and tick it off."}).then(st => { if (st === 404 || st === 410) { delete all[id]; changed = true; } }).catch(() => {}));
    }
    await Promise.all(jobs);
    if (changed) await env.GB.put("subs", JSON.stringify(all));
  }
};

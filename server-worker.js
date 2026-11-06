// Grindboard server: phone notifications + AI coach. Paste this whole file into Cloudflare.
const VAPID_PUBLIC = "BCigKAuZ3c-BUvEXwdqnHlSGxtc8yQIpOOytY9qqG7V1Aph_phyNJl4u2PhnjxFIbI4hu98y4gB7xELm_00rbyM";
const VAPID_PRIVATE_JWK = {"key_ops": ["sign"], "ext": true, "kty": "EC", "x": "KKAoC5ndz4FS8RfB2qceVIbG1zzJAik47K1j2qobtXU", "y": "Aph_phyNJl4u2PhnjxFIbI4hu98y4gB7xELm_00rbyM", "crv": "P-256", "d": "4gB9paBbuhFjWtoTwyiN_1vQk1umk0kYP0lhdrGU_IE"};
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

const cors = origin => ({"Access-Control-Allow-Origin": origin === APP ? APP : APP, "Access-Control-Allow-Methods":"POST, OPTIONS", "Access-Control-Allow-Headers":"Content-Type", "Vary":"Origin"});
const json = (data, origin, status = 200) => new Response(JSON.stringify(data), {status, headers:{"Content-Type":"application/json", ...cors(origin)}});
async function subId(endpoint){ return b64u(await crypto.subtle.digest("SHA-256", enc.encode(endpoint))).slice(0, 22); }
async function loadAll(env){ return (await env.GB.get("subs", "json")) || {}; }

async function handleSubscribe(req, env, origin){
  const b = await req.json();
  if (!b.sub || !b.sub.endpoint || !b.sub.keys || !/^https:\/\//.test(b.sub.endpoint)) return json({error:"bad subscription"}, origin, 400);
  const items = (b.items || []).filter(x => /^\d{2}:\d{2}$/.test(x.t)).slice(0, 40).map(x => ({t: x.t, title: String(x.title || "Time for your next task").slice(0, 120)}));
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
  const day = new Date().toISOString().slice(0, 10), limit = Number(env.AI_DAILY_LIMIT || (env.AI ? 60 : 200));
  const used = Number(await env.GB.get("ai:" + day) || 0);
  if (used >= limit) return json({error:"The coach has answered all its free questions for today. Try again tomorrow."}, origin, 429);
  const b = await req.json();
  const messages = (b.messages || []).slice(-8).map(m => ({role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "").slice(0, 2000)})).filter(m => m.content);
  if (!messages.length || messages[0].role !== "user") return json({error:"Ask a question first."}, origin, 400);
  const system = "You are the coach inside Grindboard, a daily routine and side-hustle app. Be warm but direct, like a good mentor. Use plain, simple English (the user may not be very technical). Keep answers short: a few sentences or up to 5 bullet points. Base what you say on the user's data below, quote their real numbers, and give concrete next steps. Never give personalised financial or investment advice, never tell them to take a specific trade, and don't make medical claims. If the data is too thin to judge, say so and tell them what to log.\n\nTHE USER'S DATA:\n" + String(b.context || "").slice(0, 12000);
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
function localHM(tz){
  try { return new Intl.DateTimeFormat("en-GB", {timeZone: tz, hour:"2-digit", minute:"2-digit", hour12:false}).format(new Date()).replace(/^24/, "00"); }
  catch (e) { return new Date().toISOString().slice(11, 16); }
}

export default {
  async fetch(req, env){
    const origin = req.headers.get("Origin") || "", url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, {headers: cors(origin)});
    if (req.method === "GET" && url.pathname === "/") return json({ok:true, app:"grindboard", push: !!env.GB, ai: !!(env.AI || env.ANTHROPIC_API_KEY)}, origin);
    if (req.method !== "POST") return json({error:"not found"}, origin, 404);
    if (origin !== APP) return json({error:"forbidden"}, origin, 403);
    if (!env.GB) return json({error:"Storage isn't connected yet."}, origin, 500);
    try {
      if (url.pathname === "/subscribe") return await handleSubscribe(req, env, origin);
      if (url.pathname === "/unsubscribe") return await handleUnsubscribe(req, env, origin);
      if (url.pathname === "/ai") return await handleAI(req, env, origin);
    } catch (e) { return json({error: String(e && e.message || e)}, origin, 500); }
    return json({error:"not found"}, origin, 404);
  },
  async scheduled(event, env, ctx){
    if (!env.GB) return;
    const all = await loadAll(env); let changed = false; const jobs = [];
    for (const [id, s] of Object.entries(all)) {
      const now = localHM(s.tz);
      for (const it of s.items || []) if (it.t === now) jobs.push(sendPush(s.sub, {title: it.title, body: it.body || "Tap to open Grindboard and tick it off."}).then(st => { if (st === 404 || st === 410) { delete all[id]; changed = true; } }).catch(() => {}));
    }
    await Promise.all(jobs);
    if (changed) await env.GB.put("subs", JSON.stringify(all));
  }
};

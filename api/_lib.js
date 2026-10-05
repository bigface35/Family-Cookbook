/* Shared helpers for Mise serverless functions (Vercel, Node 18+, CommonJS). */
const dns = require('dns').promises;
const net = require('net');

// The Firebase *web* API key is public by design (it's also in index.html).
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyAWRgBF83SoyExPfOu0XEKT8oECsPbOHx4';

const MODELS = {
  fast: process.env.MODEL_FAST || 'claude-haiku-4-5-20251001',
  smart: process.env.MODEL_SMART || 'claude-sonnet-5-5'
};

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

function bodyOf(req) {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  return b && typeof b === 'object' ? b : {};
}

/* ---- Auth: verify the caller's Firebase ID token (no SDK needed) ---- */
const tokenCache = new Map(); // token -> {uid, exp}
async function verifyUser(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) throw httpError(401, 'Please sign in again.');
  const token = m[1];
  const hit = tokenCache.get(token);
  if (hit && hit.exp > Date.now()) return hit.uid;
  const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + FIREBASE_API_KEY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: token })
  });
  if (!r.ok) throw httpError(401, 'Please sign in again.');
  const data = await r.json().catch(() => ({}));
  const uid = data.users && data.users[0] && data.users[0].localId;
  if (!uid) throw httpError(401, 'Please sign in again.');
  if (tokenCache.size > 500) tokenCache.clear();
  tokenCache.set(token, { uid, exp: Date.now() + 5 * 60 * 1000 });
  return uid;
}

/* ---- Best-effort per-user rate limit (resets when the function instance recycles) ---- */
const buckets = new Map();
function rateLimit(uid, name, max, windowMs) {
  const key = name + ':' + uid;
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.n++;
  if (buckets.size > 5000) buckets.clear();
  if (b.n > max) throw httpError(429, "You've hit the hourly limit for this feature. Please try again a bit later.");
}

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

function handle(fn) {
  return async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method', message: 'POST only' });
    try { await fn(req, res); }
    catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error('API error:', e);
      send(res, status, { ok: false, error: 'error', message: status >= 500 && !e.status ? 'Something went wrong on our side. Please try again.' : e.message });
    }
  };
}

/* ---- Claude ---- */
async function claude({ tier, system, content, maxTokens }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw httpError(503, 'AI features are not configured yet.');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODELS[tier] || MODELS.fast,
      max_tokens: Math.min(maxTokens || 1500, 4000),
      system,
      messages: [{ role: 'user', content }]
    })
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    console.error('Anthropic error', r.status, e && e.error && e.error.message);
    if (r.status === 429 || r.status === 529) throw httpError(503, 'The AI service is busy right now. Please try again in a moment.');
    throw httpError(502, 'The AI service had a problem. Please try again.');
  }
  const data = await r.json();
  return (data.content || []).map(b => b.type === 'text' ? b.text : '').join('');
}

function extractJson(text, open, close) {
  const i = text.indexOf(open), j = text.lastIndexOf(close);
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(text.slice(i, j + 1)); } catch (e) { return null; }
}

/* ---- SSRF-safe fetching of arbitrary user-supplied URLs ---- */
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
           (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    if (l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe8') || l.startsWith('fe9') || l.startsWith('fea') || l.startsWith('feb')) return true;
    const m = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateIp(m[1]);
    return false;
  }
  return true;
}
async function assertPublicUrl(u) {
  if (!/^https?:$/.test(u.protocol)) throw httpError(400, 'That doesn\'t look like a web link.');
  if (u.port && u.port !== '80' && u.port !== '443') throw httpError(400, 'That link can\'t be fetched.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) { if (isPrivateIp(host)) throw httpError(400, 'That link can\'t be fetched.'); return; }
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw httpError(400, 'That link can\'t be fetched.');
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); } catch (e) { throw httpError(400, 'Couldn\'t find that website.'); }
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw httpError(400, 'That link can\'t be fetched.');
}

async function safeFetch(urlStr, { ua, maxBytes = 2500000, timeoutMs = 12000, accept } = {}) {
  let url;
  try { url = new URL(urlStr); } catch (e) { throw httpError(400, 'That doesn\'t look like a valid link.'); }
  for (let hop = 0; hop < 5; hop++) {
    await assertPublicUrl(url);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    let r;
    try {
      r = await fetch(url.toString(), {
        redirect: 'manual', signal: ctl.signal,
        headers: { 'User-Agent': ua || BROWSER_UA, 'Accept': accept || 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' }
      });
    } catch (e) { clearTimeout(t); throw httpError(502, 'Couldn\'t reach that page.'); }
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      clearTimeout(t);
      try { url = new URL(r.headers.get('location'), url); } catch (e) { throw httpError(502, 'Couldn\'t reach that page.'); }
      continue;
    }
    try {
      const reader = r.body.getReader();
      const chunks = []; let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) { chunks.push(value.slice(0, value.length - (total - maxBytes))); try { await reader.cancel(); } catch (e) {} break; }
        chunks.push(value);
      }
      clearTimeout(t);
      const buf = Buffer.concat(chunks);
      return { status: r.status, ok: r.ok, url: url.toString(), type: r.headers.get('content-type') || '', buf, text: buf.toString('utf8') };
    } catch (e) { clearTimeout(t); throw httpError(502, 'Couldn\'t read that page.'); }
  }
  throw httpError(502, 'That link redirected too many times.');
}

module.exports = { send, bodyOf, verifyUser, rateLimit, httpError, handle, claude, extractJson, safeFetch, BROWSER_UA, MODELS };

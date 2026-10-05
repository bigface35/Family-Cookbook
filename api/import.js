/* POST /api/import  {url} | {text}  -> a recipe draft, fetched and parsed server-side.
   Cascade: structured data (JSON-LD) -> page/caption text read by Claude. */
const { send, bodyOf, verifyUser, rateLimit, httpError, handle, claude, extractJson, safeFetch } = require('./_lib');

const FB_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uiextra.php)';
const CATS = 'Produce, Meat & Seafood, Dairy & Eggs, Bakery & Grains, Pantry & Dry Goods, Condiments & Sauces, Spices & Seasonings, Spirits & Mixers, Frozen, Other';

/* ---------- HTML helpers ---------- */
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp|rsquo|lsquo|ldquo|rdquo|ndash|mdash|frac12|frac14|frac34|deg|hellip);/gi, (m, e) => {
    const l = e.toLowerCase();
    const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', frac12: '½', frac14: '¼', frac34: '¾', deg: '°', hellip: '…' };
    if (map[l]) return map[l];
    try {
      if (l[0] === '#') return String.fromCodePoint(l[1] === 'x' ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10));
    } catch (er) {}
    return m;
  });
}
function meta(html, names) {
  for (const n of names) {
    const re1 = new RegExp('<meta[^>]+(?:property|name)=["\']' + n + '["\'][^>]*content=["\']([^"\']*)["\']', 'i');
    const re2 = new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']' + n + '["\']', 'i');
    const m = html.match(re1) || html.match(re2);
    if (m && m[1]) return decodeEntities(m[1]).trim();
  }
  return '';
}
function htmlToText(html) {
  let s = html
    .replace(/<(script|style|noscript|svg|iframe|form|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|ul|ol|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s).replace(/[ \t ]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  return s;
}
function focusText(text, max = 12000) {
  if (text.length <= max) return text;
  const idx = text.search(/\bingredients\b/i);
  if (idx > 400) { const start = Math.max(0, idx - 1500); return text.slice(start, start + max); }
  return text.slice(0, max);
}
function titleOf(html) { const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i); return m ? decodeEntities(m[1]).trim() : ''; }
function absUrl(u, base) { try { return u ? new URL(u, base).toString() : ''; } catch (e) { return ''; } }

/* ---------- JSON-LD ---------- */
function findRecipeNode(n) {
  if (!n) return null;
  if (Array.isArray(n)) { for (const x of n) { const f = findRecipeNode(x); if (f) return f; } return null; }
  if (typeof n !== 'object') return null;
  const t = n['@type'];
  if (t === 'Recipe' || (Array.isArray(t) && t.includes('Recipe'))) return n;
  if (n['@graph']) return findRecipeNode(n['@graph']);
  return null;
}
function jsonLdRecipe(html) {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const node = findRecipeNode(JSON.parse(m[1].trim()));
      if (node) return node;
    } catch (e) { /* skip malformed block */ }
  }
  return null;
}
function nodeImage(node, base) {
  const i = node && node.image;
  let u = '';
  if (typeof i === 'string') u = i;
  else if (Array.isArray(i)) u = typeof i[0] === 'string' ? i[0] : (i[0] && i[0].url) || '';
  else if (i && i.url) u = i.url;
  return absUrl(u, base);
}
function slimNode(node) {
  const keep = ['name', 'recipeIngredient', 'ingredients', 'recipeInstructions', 'recipeYield', 'totalTime', 'cookTime', 'prepTime', 'recipeCuisine', 'description'];
  const o = {};
  keep.forEach(k => { if (node[k] !== undefined) o[k] = node[k]; });
  return o;
}

/* ---------- Social sources ---------- */
function host(u) { try { return new URL(u).hostname.replace(/^www\./, '').replace(/^m\./, ''); } catch (e) { return ''; } }

async function igSource(url) {
  const m = url.match(/instagram\.com\/(?:[^/]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
  let text = '', image = '', title = '';
  if (m) {
    const kind = m[1] === 'reels' ? 'reel' : m[1];
    try {
      const r = await safeFetch('https://www.instagram.com/' + kind + '/' + m[2] + '/embed/captioned/', { timeoutMs: 9000 });
      if (r.ok) {
        const cap = r.text.match(/<div class="Caption"[\s\S]*?<\/div>\s*<\/div>/i);
        text = htmlToText(cap ? cap[0] : r.text);
        const im = r.text.match(/class="EmbeddedMediaImage"[^>]*src="([^"]+)"/i);
        if (im) image = decodeEntities(im[1]);
      }
    } catch (e) { /* fall through to og tags */ }
  }
  if (text.length < 80 || !image) {
    try {
      const r = await safeFetch(url, { ua: FB_UA, timeoutMs: 9000 });
      if (r.ok) {
        const d = meta(r.text, ['og:description', 'description']);
        if (d && d.length > text.length) text = d;
        image = image || meta(r.text, ['og:image']);
        title = meta(r.text, ['og:title']);
      }
    } catch (e) {}
  }
  return { text, image, title };
}

async function tiktokSource(url) {
  let text = '', image = '', title = '';
  try {
    const r = await safeFetch('https://www.tiktok.com/oembed?url=' + encodeURIComponent(url), { timeoutMs: 9000, accept: 'application/json' });
    if (r.ok) { const d = JSON.parse(r.text); text = d.title || ''; image = d.thumbnail_url || ''; title = d.title || ''; }
  } catch (e) {}
  if (!text) {
    try {
      const r = await safeFetch(url, { timeoutMs: 9000 });
      text = meta(r.text, ['og:description', 'description']) || '';
      image = meta(r.text, ['og:image']);
    } catch (e) {}
  }
  return { text, image, title };
}

async function youtubeSource(url) {
  let text = '', image = '', title = '';
  try {
    const r = await safeFetch(url, { timeoutMs: 10000 });
    const html = r.text;
    title = meta(html, ['og:title']);
    image = meta(html, ['og:image']);
    const sd = html.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/);
    let desc = '';
    if (sd) { try { desc = JSON.parse('"' + sd[1] + '"'); } catch (e) {} }
    text = (title ? title + '\n' : '') + (desc || meta(html, ['og:description']));
    // Captions (best effort): spoken ingredients/steps often live here when the description is thin
    if (text.length < 1500) {
      const ct = html.match(/"captionTracks":(\[[\s\S]*?\])/);
      if (ct) {
        try {
          const tracks = JSON.parse(ct[1]);
          const en = tracks.find(t => /^en/.test(t.languageCode)) || tracks[0];
          if (en && en.baseUrl) {
            const cr = await safeFetch(en.baseUrl.replace(/\\u0026/g, '&') + '&fmt=json3', { timeoutMs: 8000, accept: 'application/json' });
            const cj = JSON.parse(cr.text);
            const words = (cj.events || []).map(e => (e.segs || []).map(s => s.utf8).join('')).join(' ').replace(/\s+/g, ' ');
            if (words.length > 100) text += '\n\nVideo transcript:\n' + words.slice(0, 9000);
          }
        } catch (e) {}
      }
    }
  } catch (e) {}
  return { text, image, title };
}

/* ---------- AI extraction ---------- */
function normalizeDraft(d) {
  if (!d || typeof d !== 'object') return null;
  const ings = (Array.isArray(d.ingredients) ? d.ingredients : []).map(i => {
    if (!i || !i.name) return null;
    const amt = typeof i.amount === 'number' ? i.amount : (parseFloat(i.amount) || null);
    return { amount: amt, unit: i.unit ? String(i.unit) : '', name: String(i.name), category: i.category ? String(i.category) : 'Other' };
  }).filter(Boolean);
  const steps = (Array.isArray(d.steps) ? d.steps : []).map(s => String(s).trim()).filter(Boolean);
  if (!d.name || (!ings.length && !steps.length)) return null;
  return {
    name: String(d.name).slice(0, 120), time: d.time ? String(d.time) : '', servings: parseInt(d.servings, 10) || 4,
    tags: Array.isArray(d.tags) ? d.tags.map(String).slice(0, 5) : [], kidFriendly: !!d.kidFriendly, kidNote: d.kidNote ? String(d.kidNote) : '',
    ingredients: ings, steps
  };
}
async function aiExtract(text, hint) {
  const raw = await claude({
    tier: 'fast', maxTokens: 2500,
    system: 'You extract recipes from messy text (blog pages, social captions, video descriptions/transcripts). Respond ONLY with valid JSON, no markdown. Never invent quantities or steps that the text does not support; if the text only names a dish without a method, return null.',
    content: (hint ? 'Source: ' + hint + '\n\n' : '') + 'Extract the recipe from the text below.\n\n---\n' + text + '\n---\n\n' +
      'Return ONLY this JSON, or the word null if there is no real recipe:\n' +
      '{"name":"Recipe Name","time":"30 min","servings":4,"tags":["Quick"],"kidFriendly":false,"kidNote":"",' +
      '"ingredients":[{"amount":2,"unit":"cups","name":"flour","category":"Pantry & Dry Goods"}],"steps":["Step 1.","Step 2."]}\n' +
      'Use amount:null for "to taste". Split combined steps into clear single actions. Valid categories: ' + CATS + '.'
  });
  if (/^\s*null\s*$/i.test(raw)) return null;
  return normalizeDraft(extractJson(raw, '{', '}'));
}

/* ---------- Handler ---------- */
module.exports = handle(async (req, res) => {
  const uid = await verifyUser(req);
  rateLimit(uid, 'import', 40, 60 * 60 * 1000);
  const b = bodyOf(req);

  // Pasted text path (caption copied from Instagram, etc.)
  if (b.text && !b.url) {
    const draft = await aiExtract(focusText(String(b.text).slice(0, 30000)), 'pasted text');
    if (!draft) throw httpError(422, "I couldn't find a complete recipe in that text.");
    return send(res, 200, { ok: true, source: 'ai', draft, image: '' });
  }

  let url = String(b.url || '').trim();
  if (!url) throw httpError(400, 'Paste a link first.');
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const h = host(url);

  // 1) Social platforms: caption/description -> AI
  if (/(^|\.)instagram\.com$|^instagr\.am$/.test(h) || /tiktok\.com$/.test(h) || /youtube\.com$|^youtu\.be$/.test(h)) {
    const src = /instagram|instagr/.test(h) ? await igSource(url) : /tiktok/.test(h) ? await tiktokSource(url) : await youtubeSource(url);
    const text = (src.text || '').trim();
    if (text.length < 40) {
      throw httpError(422, "That post didn't share its caption with us (private, or the app hides it). Copy the caption text and paste it in the box below, and I'll take it from there.");
    }
    const draft = await aiExtract(focusText(text), h);
    if (!draft) throw httpError(422, "I read the post but it doesn't include a full recipe (often it's only in the video). If the full recipe is in the comments or on their website, paste that instead.");
    return send(res, 200, { ok: true, source: 'ai-social', draft, image: src.image || '' });
  }

  // 2) Any web page
  const page = await safeFetch(url);
  if (!page.ok && page.text.length < 500) throw httpError(422, "That site wouldn't let us open the page. Copy the recipe text and paste it instead.");
  const html = page.text;
  const image = meta(html, ['og:image', 'twitter:image']);
  const node = jsonLdRecipe(html);
  const nodeOk = node && (node.recipeIngredient || node.ingredients || []).length && node.recipeInstructions;
  if (nodeOk) {
    return send(res, 200, { ok: true, source: 'jsonld', node: slimNode(node), image: nodeImage(node, page.url) || absUrl(image, page.url) });
  }
  // No structured data: let Claude read the page text
  const text = focusText(htmlToText(html));
  if (text.length < 200) throw httpError(422, "Couldn't read a recipe on that page. Try pasting the text instead.");
  const draft = await aiExtract(text, titleOf(html) + ' (' + h + ')');
  if (!draft) throw httpError(422, "Couldn't find a recipe on that page. Try pasting the ingredients and steps instead.");
  send(res, 200, { ok: true, source: 'ai', draft, image: absUrl(image, page.url) });
});

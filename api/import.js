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
  const keep = ['name', 'recipeIngredient', 'ingredients', 'recipeInstructions', 'recipeYield', 'totalTime', 'cookTime', 'prepTime', 'recipeCuisine', 'recipeCategory', 'keywords', 'description'];
  const o = {};
  keep.forEach(k => { if (node[k] !== undefined) o[k] = node[k]; });
  return o;
}

/* ---------- Social sources ---------- */
function host(u) { try { return new URL(u).hostname.replace(/^www\./, '').replace(/^m\./, ''); } catch (e) { return ''; } }

/* Instagram/TikTok block datacenter IPs unpredictably, so try every public door in parallel and keep the longest caption. */
function jsonStr(html, keyRe) {
  // first JSON string value following keyRe in plain JSON (shortcut: doesn't read JSON nested inside another string)
  const m = html.match(new RegExp(keyRe.source + '\\s*:\\s*"((?:[^"\\\\]|\\\\.)*?)"', keyRe.flags));
  if (!m) return '';
  try { return JSON.parse('"' + m[1] + '"'); } catch (e) { return ''; }
}
function cleanIgDesc(s) {
  // og:description looks like: 12K likes, 340 comments - user on March 3, 2024: "caption".
  return decodeEntities(s || '').replace(/^[\d.,KkMm]+\s+likes?,\s*[\d.,KkMm]+\s+comments?\s*-\s*[^:]{0,80}?\s+on\s+[^:]{0,40}:\s*["“]?/i, '')
    .replace(/^[^:]{0,60}\son Instagram:\s*["“]?/i, '').replace(/["”]\.?\s*$/, '').trim();
}
async function tryFetch(label, diag, url, opts) {
  try {
    const r = await safeFetch(url, Object.assign({ timeoutMs: 6000 }, opts));
    diag.push(label + ':' + r.status + '/' + r.text.length);
    return r;
  } catch (e) { diag.push(label + ':err'); return null; }
}

async function igSource(url, diag) {
  const m = url.match(/instagram\.com\/(?:[^/]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
  const cands = []; let image = '';
  const jobs = [];
  let early; const earlyP = new Promise(r => { early = r; });   // full caption from the embed route: don't wait for the slower fallbacks
  if (m) {
    const kind = m[1] === 'reels' ? 'reel' : m[1];
    jobs.push(tryFetch('embed', diag, 'https://www.instagram.com/' + kind + '/' + m[2] + '/embed/captioned/').then(r => {
      if (!r || !r.ok) return;
      const cap = r.text.match(/<div class="Caption"[\s\S]*?<\/div>\s*<\/div>/i);
      if (cap) cands.push(htmlToText(cap[0]).replace(/^\S+\s*\n?/, ''));
      const j = jsonStr(r.text, /"caption"/) || jsonStr(r.text, /"text"/);
      if (j) cands.push(j);
      const im = r.text.match(/class="EmbeddedMediaImage"[^>]*src="([^"]+)"/i);
      if (im) image = image || decodeEntities(im[1]);
      if (cands.some(c => c && c.length >= 120)) early();
    }));
  }
  ['facebookexternalhit/1.1', 'Twitterbot/1.0', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'].forEach((ua, i) => {
    jobs.push(tryFetch('og' + i, diag, url, { ua }).then(r => {
      if (!r || !r.ok) return;
      cands.push(cleanIgDesc(meta(r.text, ['og:description', 'description'])));
      cands.push(cleanIgDesc(meta(r.text, ['og:title'])));
      const j = jsonStr(r.text, /"caption"/);
      if (j) cands.push(j);
      image = image || meta(r.text, ['og:image']);
    }));
  });
  await Promise.race([Promise.all(jobs), earlyP]);
  const text = cands.filter(Boolean).sort((a, b) => b.length - a.length)[0] || '';
  return { text, image, title: '' };
}

async function tiktokSource(url, diag) {
  const cands = []; let image = '';
  await Promise.all([
    tryFetch('oembed', diag, 'https://www.tiktok.com/oembed?url=' + encodeURIComponent(url), { accept: 'application/json' }).then(r => {
      if (!r || !r.ok) return;
      try { const d = JSON.parse(r.text); cands.push(d.title || ''); image = image || d.thumbnail_url || ''; } catch (e) {}
    }),
    tryFetch('page', diag, url).then(r => {
      if (!r || !r.ok) return;
      cands.push(jsonStr(r.text, /"desc"/));
      cands.push(meta(r.text, ['og:description', 'description']));
      image = image || meta(r.text, ['og:image']);
    })
  ]);
  const text = cands.filter(Boolean).sort((a, b) => b.length - a.length)[0] || '';
  return { text, image, title: '' };
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
function normalizeDraft(d, forceDrink) {
  if (!d || typeof d !== 'object') return null;
  const drink = !!forceDrink || d.drink === true;
  const ings = (Array.isArray(d.ingredients) ? d.ingredients : []).map(i => {
    if (!i || !i.name) return null;
    const amt = typeof i.amount === 'number' ? i.amount : (parseFloat(i.amount) || null);
    return { amount: amt, unit: i.unit ? String(i.unit) : '', name: String(i.name), category: i.category ? String(i.category) : 'Other' };
  }).filter(Boolean);
  const steps = (Array.isArray(d.steps) ? d.steps : []).map(s => String(s).trim()).filter(Boolean);
  if (!d.name || (!ings.length && !steps.length)) return null;
  return {
    name: String(d.name).slice(0, 120), time: d.time ? String(d.time) : '', servings: parseInt(d.servings, 10) || 4,
    tags: (Array.isArray(d.tags) ? d.tags.map(String).slice(0, 5) : []).filter(t => !(drink && /^cocktail$/i.test(t))).concat(drink ? ['Cocktail'] : []),
    kidFriendly: drink ? false : !!d.kidFriendly, kidNote: drink ? '' : (d.kidNote ? String(d.kidNote) : ''),
    ingredients: ings, steps
  };
}
// Fetch the post photo while the AI reads the caption, so the app doesn't need a second round trip.
// Never throws; '' means "let the app try /api/img itself". shortcut: 1.5MB cap keeps the JSON under Vercel's 4.5MB response limit.
async function inlineImage(url) {
  if (!/^https?:\/\//i.test(url || '')) return '';
  try {
    const r = await safeFetch(url, { maxBytes: 1500000, timeoutMs: 6000, accept: 'image/avif,image/webp,image/png,image/jpeg,*/*;q=0.8' });
    const type = (r.type || '').split(';')[0].trim().toLowerCase();
    if (!r.ok || !/^image\/(jpeg|png|webp|gif)$/.test(type) || r.buf.length >= 1500000) return '';
    return 'data:' + type + ';base64,' + r.buf.toString('base64');
  } catch (e) { return ''; }
}
async function aiExtract(text, hint, cocktail) {
  const raw = await claude({
    tier: 'fast', maxTokens: 2500,
    system: 'You extract recipes from messy text (blog pages, social captions, video descriptions/transcripts). Respond ONLY with valid JSON, no markdown. Never invent quantities or steps that the text does not support; if the text only names a dish without a method, return null.',
    content: (hint ? 'Source: ' + hint + '\n\n' : '') + 'Extract the recipe from the text below.\n\n---\n' + text + '\n---\n\n' +
      'Return ONLY this JSON, or the word null if there is no real recipe:\n' +
      '{"name":"Recipe Name","time":"30 min","servings":4,"drink":false,"tags":["Quick"],"kidFriendly":false,"kidNote":"",' +
      '"ingredients":[{"amount":2,"unit":"cups","name":"flour","category":"Pantry & Dry Goods"}],"steps":["Step 1.","Step 2."]}\n' +
      'Use amount:null for "to taste". Split combined steps into clear single actions. Valid categories: ' + CATS + '.\n' +
      'Set "drink" to true if this is a cocktail or other alcoholic/mixed drink' + (cocktail ? ' (the user is importing a cocktail, so it should be true)' : '') + ', else false. ' +
      'For a drink: servings is the number of drinks, put spirits, liqueurs, bitters and mixers in the "Spirits & Mixers" category, and use short style tags such as Tiki, Classic or Quick.'
  });
  if (/^\s*null\s*$/i.test(raw)) return null;
  return normalizeDraft(extractJson(raw, '{', '}'), cocktail);
}

/* ---------- Handler ---------- */
module.exports = handle(async (req, res) => {
  const uid = await verifyUser(req);
  rateLimit(uid, 'import', 40, 60 * 60 * 1000);
  const b = bodyOf(req);

  // Pasted text path (caption copied from Instagram, etc.)
  if (b.text && !b.url) {
    const draft = await aiExtract(focusText(String(b.text).slice(0, 30000)), 'pasted text', !!b.cocktail);
    if (!draft) throw httpError(422, "I couldn't find a complete recipe in that text.");
    return send(res, 200, { ok: true, source: 'ai', draft, image: '' });
  }

  let url = String(b.url || '').trim();
  if (!url) throw httpError(400, 'Paste a link first.');
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const h = host(url);

  // 1) Social platforms: caption/description -> AI
  if (/(^|\.)instagram\.com$|^instagr\.am$/.test(h) || /tiktok\.com$/.test(h) || /youtube\.com$|^youtu\.be$/.test(h)) {
    const diag = [];
    const src = /instagram|instagr/.test(h) ? await igSource(url, diag) : /tiktok/.test(h) ? await tiktokSource(url, diag) : await youtubeSource(url);
    const text = (src.text || '').trim();
    console.log('social import', h, diag.join(' '), 'chars=' + text.length);
    if (text.length < 40) {
      throw httpError(422, "We couldn't read that post's caption (" + h + " often blocks servers, even for public posts). Long-press the caption, tap Copy, and paste it in the box below.");
    }
    const imgP = inlineImage(src.image);
    const draft = await aiExtract(focusText(text), h, !!b.cocktail);
    if (!draft) {
      const seen = text.replace(/\s+/g, ' ').slice(0, 90);
      throw httpError(422, "We only got " + text.length + " characters of that post: \"" + seen + (text.length > 90 ? '…' : '') + "\". If the full recipe is longer than that, copy the caption (or the comments) and paste it in the box below.");
    }
    return send(res, 200, { ok: true, source: 'ai-social', draft, image: src.image || '', imageData: await imgP });
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
  const draft = await aiExtract(text, titleOf(html) + ' (' + h + ')', !!b.cocktail);
  if (!draft) throw httpError(422, "Couldn't find a recipe on that page. Try pasting the ingredients and steps instead.");
  send(res, 200, { ok: true, source: 'ai', draft, image: absUrl(image, page.url) });
});

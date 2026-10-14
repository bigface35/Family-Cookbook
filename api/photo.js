/* POST /api/photo {query, n?} -> {photo:{url,credit,link,n}|null}. n picks the Nth match (wraps), so the app can offer "try another photo". Finds a stock photo on Unsplash (if UNSPLASH_ACCESS_KEY is set) or Pexels (PEXELS_API_KEY). */
const { send, bodyOf, verifyUser, rateLimit, httpError, handle } = require('./_lib');

// shortcut: per-instance cache of each query's 10 matches; move to shared Redis if photo limits start to bite.
const cache = new Map();

module.exports = handle(async (req, res) => {
  const uid = await verifyUser(req);
  rateLimit(uid, 'photo', 100, 60 * 60 * 1000);
  const uKey = process.env.UNSPLASH_ACCESS_KEY, pKey = process.env.PEXELS_API_KEY;
  if (!uKey && !pKey) throw httpError(503, 'Photos are not configured yet.');
  const q = String(bodyOf(req).query || '').replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim().slice(0, 80).toLowerCase();
  if (!q) throw httpError(400, 'Missing query.');
  const n = Math.max(0, parseInt(bodyOf(req).n, 10) || 0);
  let list = cache.get(q);
  if (!list) {
    list = [];
    if (uKey) {
      const r = await fetch('https://api.unsplash.com/search/photos?per_page=10&orientation=landscape&query=' + encodeURIComponent(q), { headers: { Authorization: 'Client-ID ' + uKey } });
      if (r.status === 403 || r.status === 429) throw httpError(503, 'Photo service is busy. Try again later.');
      if (!r.ok) throw httpError(502, 'Photo service had a problem.');
      list = ((await r.json()).results || []).map(p => ({ url: p.urls.regular, credit: p.user.name, link: p.links.html + '?utm_source=mise&utm_medium=referral', source: 'Unsplash', sourceUrl: 'https://unsplash.com/?utm_source=mise&utm_medium=referral', dl: p.links.download_location }));
    } else {
      const r = await fetch('https://api.pexels.com/v1/search?per_page=10&orientation=landscape&query=' + encodeURIComponent(q), { headers: { Authorization: pKey } });
      if (r.status === 429) throw httpError(503, 'Photo service is busy. Try again later.');
      if (!r.ok) throw httpError(502, 'Photo service had a problem.');
      list = ((await r.json()).photos || []).map(p => ({ url: p.src.large, credit: p.photographer, link: p.url, source: 'Pexels', sourceUrl: 'https://www.pexels.com' }));
    }
    if (cache.size > 2000) cache.clear();
    cache.set(q, list);
  }
  const i = list.length ? n % list.length : 0;
  const { dl, ...photo } = list[i] || {};
  if (dl) fetch(dl, { headers: { Authorization: 'Client-ID ' + uKey } }).catch(() => {});   // required by Unsplash API terms
  send(res, 200, { ok: true, photo: list.length ? { ...photo, n: i } : null });
});

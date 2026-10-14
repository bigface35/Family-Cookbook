/* POST /api/photo {query} -> {photo:{url,credit,link}|null}. Finds a stock photo on Unsplash (if UNSPLASH_ACCESS_KEY is set) or Pexels (PEXELS_API_KEY). */
const { send, bodyOf, verifyUser, rateLimit, httpError, handle } = require('./_lib');

// ponytail: per-instance cache; move to shared Redis if Pexels' free limits (200/hr, 20k/mo) start to bite.
const cache = new Map();

module.exports = handle(async (req, res) => {
  const uid = await verifyUser(req);
  rateLimit(uid, 'photo', 100, 60 * 60 * 1000);
  const uKey = process.env.UNSPLASH_ACCESS_KEY, pKey = process.env.PEXELS_API_KEY;
  if (!uKey && !pKey) throw httpError(503, 'Photos are not configured yet.');
  const q = String(bodyOf(req).query || '').replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim().slice(0, 80).toLowerCase();
  if (!q) throw httpError(400, 'Missing query.');
  if (cache.has(q)) return send(res, 200, { ok: true, photo: cache.get(q) });
  let photo = null;
  if (uKey) {
    const r = await fetch('https://api.unsplash.com/search/photos?per_page=1&orientation=landscape&query=' + encodeURIComponent(q), { headers: { Authorization: 'Client-ID ' + uKey } });
    if (r.status === 403 || r.status === 429) throw httpError(503, 'Photo service is busy. Try again later.');
    if (!r.ok) throw httpError(502, 'Photo service had a problem.');
    const p = ((await r.json()).results || [])[0];
    if (p) {
      photo = { url: p.urls.regular, credit: p.user.name, link: p.links.html + '?utm_source=mise&utm_medium=referral', source: 'Unsplash', sourceUrl: 'https://unsplash.com/?utm_source=mise&utm_medium=referral' };
      fetch(p.links.download_location, { headers: { Authorization: 'Client-ID ' + uKey } }).catch(() => {});   // required by Unsplash API terms
    }
  } else {
    const r = await fetch('https://api.pexels.com/v1/search?per_page=1&orientation=landscape&query=' + encodeURIComponent(q), { headers: { Authorization: pKey } });
    if (r.status === 429) throw httpError(503, 'Photo service is busy. Try again later.');
    if (!r.ok) throw httpError(502, 'Photo service had a problem.');
    const p = ((await r.json()).photos || [])[0];
    if (p) photo = { url: p.src.large, credit: p.photographer, link: p.url, source: 'Pexels', sourceUrl: 'https://www.pexels.com' };
  }
  if (cache.size > 2000) cache.clear();
  cache.set(q, photo);
  send(res, 200, { ok: true, photo });
});

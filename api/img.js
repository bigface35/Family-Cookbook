/* POST /api/img {url} -> {dataUrl}. Fetches a remote image server-side so the app can store its own
   copy (Instagram/TikTok thumbnail links expire; some sites block hot-linking). */
const { send, bodyOf, verifyUser, rateLimit, httpError, handle, safeFetch } = require('./_lib');

module.exports = handle(async (req, res) => {
  const uid = await verifyUser(req);
  rateLimit(uid, 'img', 60, 60 * 60 * 1000);
  const url = String(bodyOf(req).url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw httpError(400, 'Bad image link.');
  const r = await safeFetch(url, { maxBytes: 3000000, timeoutMs: 10000, accept: 'image/avif,image/webp,image/png,image/jpeg,*/*;q=0.8' });
  const type = (r.type || '').split(';')[0].trim().toLowerCase();
  if (!r.ok || !/^image\/(jpeg|png|webp|gif)$/.test(type)) throw httpError(422, "Couldn't use that image.");
  if (r.buf.length >= 3000000) throw httpError(413, 'Image too large.');
  send(res, 200, { ok: true, dataUrl: 'data:' + type + ';base64,' + r.buf.toString('base64') });
});

/* Share-target landing: the Android app POSTs a shared link here; bounce it into the app as a normal GET. */
module.exports = (req, res) => {
  const src = Object.assign({}, req.query || {}, req.body && typeof req.body === 'object' ? req.body : {});
  const q = new URLSearchParams();
  ['title', 'text', 'url'].forEach(k => { const v = src['shared_' + k] || src[k]; if (v) q.set('shared_' + k, String(v).slice(0, 4000)); });
  res.statusCode = 303;
  res.setHeader('Location', '/' + (q.toString() ? '?' + q.toString() : ''));
  res.end();
};

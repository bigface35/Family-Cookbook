/* POST /api/ai — authenticated Claude proxy for text features (meal plans, nutrition). */
const { send, bodyOf, verifyUser, rateLimit, httpError, handle, claude } = require('./_lib');

module.exports = handle(async (req, res) => {
  const uid = await verifyUser(req);
  rateLimit(uid, 'ai', 60, 60 * 60 * 1000);
  const b = bodyOf(req);
  const system = String(b.system || '').slice(0, 4000);
  const user = String(b.user || '').slice(0, 20000);
  if (!user) throw httpError(400, 'Missing request.');
  const text = await claude({
    tier: b.tier === 'smart' ? 'smart' : 'fast',
    system, content: user,
    maxTokens: Math.min(parseInt(b.maxTokens, 10) || 1000, 2500)
  });
  send(res, 200, { ok: true, text });
});

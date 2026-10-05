/* POST /api/receipt {image: "data:image/jpeg;base64,..."} -> grocery items found on the receipt. */
const { send, bodyOf, verifyUser, rateLimit, httpError, handle, claude, extractJson } = require('./_lib');

const CATS = ['Produce', 'Meat & Seafood', 'Dairy & Eggs', 'Bakery & Grains', 'Pantry & Dry Goods', 'Condiments & Sauces', 'Spices & Seasonings', 'Spirits & Mixers', 'Frozen', 'Other'];

module.exports = handle(async (req, res) => {
  const uid = await verifyUser(req);
  rateLimit(uid, 'receipt', 15, 60 * 60 * 1000);
  const b = bodyOf(req);
  const m = String(b.image || '').match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw httpError(400, 'Please attach a photo of the receipt.');
  if (m[2].length > 4200000) throw httpError(413, 'That photo is too large. Try again with a smaller one.');
  const raw = await claude({
    tier: 'smart', maxTokens: 2500,
    system: 'You read grocery store receipts. Respond ONLY with valid JSON, no markdown.',
    content: [
      { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
      { type: 'text', text:
        'List the FOOD and DRINK ingredients purchased on this receipt. Expand store abbreviations into plain ingredient names ("ORG BNLS CHKN BRST" -> "chicken breast"). ' +
        'Skip non-food items (bags, cleaning, paper goods, pet, health), taxes, totals, discounts and coupons. Merge duplicates. ' +
        'Return ONLY: {"store":"Store name or empty","items":[{"name":"chicken breast","category":"Meat & Seafood"}]}\n' +
        'Categories must be one of: ' + CATS.join(', ') + '. If this is not a grocery receipt, return {"store":"","items":[]}.' }
    ]
  });
  const j = extractJson(raw, '{', '}');
  if (!j || !Array.isArray(j.items)) throw httpError(422, "I couldn't read that receipt. Try a flatter, brighter photo.");
  const seen = {};
  const items = j.items.map(i => ({
    name: String((i && i.name) || '').trim().slice(0, 80).toLowerCase(),
    category: CATS.includes(i && i.category) ? i.category : 'Other'
  })).filter(i => i.name && !seen[i.name] && (seen[i.name] = true)).slice(0, 80);
  send(res, 200, { ok: true, store: String(j.store || '').slice(0, 60), items });
});

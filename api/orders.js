// /api/orders  (admin only: send the header  Authorization: Bearer <ADMIN_TOKEN>)
//
// GET  /api/orders?limit=25
//   Newest cards from Redis joined with their Stripe sessions, plus "unfulfilled":
//   paid Stripe sessions that have NO card yet (means the webhook missed something).
//
// POST /api/orders   { "code": "0831", "recipient_name": "...", "tier": "hello", ... }
//   Create a card by hand (comp cards, test cards, moving old Sheet rows over).
//   "code" is optional; leave it out to auto-generate one.
const Stripe = require('stripe');
const { timingSafeEqual } = require('crypto');
const { redis, keys, asCode } = require('./_lib/redis');
const { TIERS, toKeypad, normalizeCode, reserveNewCode, priceIdForTier, METADATA_FIELDS, clean } = require('./_lib/cards');

function authorized(req) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false;
  const header = req.headers.authorization || '';
  const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  try {
    if (req.method === 'GET') return await listOrders(req, res);
    if (req.method === 'POST') return await createManualCard(req, res);
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[orders] error:', err);
    return res.status(500).json({ error: err.message });
  }
};

async function listOrders(req, res) {
  const kv = redis();
  const limit = Math.min(Math.max(parseInt(req.query && req.query.limit, 10) || 25, 1), 100);

  const codes = (await kv.zrange(keys.orders, 0, limit - 1, { rev: true })).map(asCode);
  const cards = codes.length ? (await kv.mget(...codes.map((c) => keys.card(c)))).filter(Boolean) : [];

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
  const sessions = await stripe.checkout.sessions.list({ limit, status: 'complete' });
  const bySession = new Map(sessions.data.map((s) => [s.id, s]));

  const orders = cards.map((card) => {
    const s = card.stripe_session_id ? bySession.get(card.stripe_session_id) : null;
    return {
      ...card,
      code: asCode(card.code),
      twilio_code: asCode(card.twilio_code),
      stripe: s
        ? {
            payment_status: s.payment_status,
            amount_total: s.amount_total,
            customer_email: (s.customer_details && s.customer_details.email) || null,
            dashboard_url: `https://dashboard.stripe.com/${s.livemode ? '' : 'test/'}checkout/sessions/${s.id}`,
          }
        : null,
    };
  });

  const unfulfilled = [];
  for (const s of sessions.data) {
    if (s.payment_status !== 'paid') continue;
    const code = asCode(await kv.get(keys.session(s.id)));
    if (!code || code === '__pending__') {
      unfulfilled.push({
        stripe_session_id: s.id,
        created_at: new Date(s.created * 1000).toISOString(),
        customer_email: (s.customer_details && s.customer_details.email) || null,
        amount_total: s.amount_total,
        metadata: s.metadata,
      });
    }
  }

  return res.status(200).json({ count: orders.length, orders, unfulfilled });
}

async function createManualCard(req, res) {
  const kv = redis();
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};
  const tier = TIERS[body.tier] || null;

  let code;
  let twilioCode;
  if (body.code) {
    code = normalizeCode(body.code);
    twilioCode = toKeypad(code);
    const ok = await kv.set(keys.card(code), { code, status: 'reserving' }, { nx: true });
    if (!ok) return res.status(409).json({ error: `Card ${code} already exists` });
    const keypadOk = await kv.set(keys.keypad(twilioCode), code, { nx: true });
    if (!keypadOk) {
      await kv.del(keys.card(code));
      return res.status(409).json({ error: `Keypad code ${twilioCode} is already used by another card` });
    }
  } else {
    ({ code, twilioCode } = await reserveNewCode(kv, keys));
  }

  const now = new Date();
  const record = {
    code,
    twilio_code: twilioCode,
    status: body.status || 'collecting',
    source: 'manual',
    created_at: now.toISOString(),
    fulfilled_at: now.toISOString(),
    notes: clean(body.notes),
    card_id: clean(body.card_id),
    stripe_session_id: '',
    customer_email: clean(body.customer_email),
    purchaser_name: clean(body.purchaser_name),
    tier: tier ? tier.key : 'unknown',
    tier_name: tier ? tier.name : 'Unknown tier',
    max_minutes: tier ? tier.minutes : null,
  };
  for (const f of METADATA_FIELDS) record[f] = clean(body[f]);
  if (!record.price_id) record.price_id = priceIdForTier(tier);

  await kv.set(keys.card(code), record);
  await kv.zadd(keys.orders, { score: Math.floor(now.getTime() / 1000), member: code });
  return res.status(201).json(record);
}

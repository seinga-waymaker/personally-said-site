// GET /api/lookup?code=XXXX
// Called by the Twilio Function (lookup-code). Accepts the letter code (e.g. "K7QM",
// from a text) or its keypad digits (e.g. "5776", from a phone call).
//
// Always answers 200 with { found: true|false } so the Twilio logic stays simple.
// Only non-sensitive fields are returned (no emails, no payment info).
const { redis, keys, asCode } = require('./_lib/redis');
const { normalizeCode } = require('./_lib/cards');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Cache-Control', 'no-store');

  // Optional shared secret so nobody can scan through codes.
  // If LOOKUP_TOKEN is set in Vercel, Twilio must send it as x-ps-token (or ?token=).
  const required = process.env.LOOKUP_TOKEN;
  if (required) {
    const given = req.headers['x-ps-token'] || (req.query && req.query.token);
    if (given !== required) return res.status(401).json({ error: 'Unauthorized' });
  }

  const input = normalizeCode(req.query && req.query.code);
  if (!input || input.length > 12) {
    return res.status(200).json({ found: false, reason: 'missing_or_invalid_code' });
  }

  try {
    const kv = redis();

    // Digits only -> keypad entry -> resolve to the real card code.
    let code = input;
    if (/^[0-9]+$/.test(input)) {
      const mapped = asCode(await kv.get(keys.keypad(input)));
      if (mapped) code = mapped;
    }

    const card = await kv.get(keys.card(code));
    if (!card || card.status === 'reserving') {
      return res.status(200).json({ found: false, code: input, reason: 'not_found' });
    }

    return res.status(200).json({
      found: true,
      active: card.status === 'active',
      code: asCode(card.code),
      twilio_code: asCode(card.twilio_code),
      status: card.status,
      recipient_name: card.recipient_name || '',
      from_name: card.from_name || card.purchaser_name || '',
      tier: card.tier,
      tier_name: card.tier_name,
      max_minutes: card.max_minutes,
      reveal_date: card.reveal_date || '',
      card_design: card.card_design || '',
      custom_track: card.custom_track || '',
    });
  } catch (err) {
    console.error('[lookup] error:', err);
    return res.status(500).json({ found: false, reason: 'server_error' });
  }
};

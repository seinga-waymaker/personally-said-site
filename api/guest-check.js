// GET /api/guest-check?code=XXXX&phone=+1...
// Called by Studio before asking "who's this from?" so a returning guest on
// the same card is never asked twice. Same shared-secret auth as lookup.
const { redis, keys, asCode } = require('./_lib/redis.js');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const required = process.env.LOOKUP_TOKEN;
  if (required) {
    const given = req.query.token || req.headers['x-ps-token'];
    if (given !== required) return res.status(401).json({ error: 'Unauthorized' });
  }

  const code = asCode(req.query.code);
  const phone = req.query.phone;
  if (!code || !phone) return res.status(200).json({ has_name: false });

  try {
    const kv = redis();
    const guest = await kv.get(keys.guest(code, phone));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ has_name: !!(guest && guest.name), name: guest?.name || '' });
  } catch (err) {
    console.error('[guest-check] error:', err.message);
    return res.status(200).json({ has_name: false });
  }
};

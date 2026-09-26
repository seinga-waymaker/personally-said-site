// POST /api/save-name-text
// Plain metadata write for a texted-in guest name (no audio clip involved --
// spoken names go through /api/blob-upload-token instead since they upload
// a file). Same shared-secret auth as lookup/blob-upload-token.
const { redis, keys, asCode } = require('./_lib/redis.js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const required = process.env.LOOKUP_TOKEN;
  if (required) {
    const given = req.headers['x-ps-token'];
    if (given !== required) return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const code = asCode(body.code);
  const guestPhone = body.guest_phone || '';
  const nameText = (body.name_text || '').trim();

  if (!code || !guestPhone) {
    return res.status(400).json({ ok: false, error: 'Missing code or guest_phone' });
  }

  try {
    const kv = redis();
    const guestKey = keys.guest(code, guestPhone);
    const existing = (await kv.get(guestKey)) || {};
    const now = new Date().toISOString();
    await kv.set(guestKey, {
      ...existing,
      phone: guestPhone,
      name: nameText || existing.name || '',
      channel: body.channel || 'text',
      updated_at: now,
    });
    await kv.rpush(keys.events(code), JSON.stringify({
      type: 'name_saved', phone: guestPhone, name: nameText, at: now,
    }));
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[save-name-text] error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};

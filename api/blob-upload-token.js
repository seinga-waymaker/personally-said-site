undefined// POST /api/blob-upload-token
//
// Issues a short-lived, scoped Vercel Blob client-upload token. Called by the
// Twilio Functions (save-recording, save-name) instead of handing Twilio a
// static Blob secret: Twilio asks this route for a token, then uploads the
// audio bytes directly to Vercel Blob with it. Once the upload finishes,
// Vercel Blob calls this same route back (onUploadCompleted) and that's
// where we write the clip/guest record to Redis.
//
// Auth: same shared secret already used for /api/lookup (LOOKUP_TOKEN), sent
// as x-ps-token. Keeps this to zero new secrets in Twilio or Vercel.
const { handleUpload } = require('@vercel/blob/client');
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

  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const payload = clientPayload ? JSON.parse(clientPayload) : {};
        const code = asCode(payload.code);
        if (!code) throw new Error('Missing card code');

        const kv = redis();
        const card = await kv.get(keys.card(code));
        if (!card) throw new Error(`Unknown card ${code}`);
        if (card.status && card.status !== 'active' && card.status !== 'collecting') {
          throw new Error(`Card ${code} is not accepting new clips (status: ${card.status})`);
        }

        return {
          allowedContentTypes: [
            'audio/mpeg', 'audio/mp3', 'audio/x-wav', 'audio/wav', 'audio/amr',
            'audio/x-mulaw', 'audio/ogg', 'audio/webm', 'application/octet-stream',
          ],
          addRandomSuffix: true,
          // NOTE: @vercel/blob client uploads (as of v2.8) don't take a per-call
          // access level — access is set on the store itself, and today that
          // means "public by URL". Raw guest clips still aren't discoverable:
          // paths live under ps-raw/ with a random suffix, are never linked from
          // any page, and nothing lists the store's contents. Flagged for Seinga
          // in case she wants tighter access once Vercel Blob supports it per-call.
          tokenPayload: JSON.stringify(payload),
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        const payload = tokenPayload ? JSON.parse(tokenPayload) : {};
        await recordClip(blob, payload).catch((err) => {
          console.error('[blob-upload-token] onUploadCompleted failed:', err);
          throw err;
        });
      },
    });
    return res.status(200).json(jsonResponse);
  } catch (err) {
    console.error('[blob-upload-token] error:', err.message);
    return res.status(400).json({ error: err.message });
  }
};

async function recordClip(blob, payload) {
  const kv = redis();
  const code = asCode(payload.code);
  if (!code) return;
  const now = new Date().toISOString();

  if (payload.kind === 'name') {
    const guestKey = keys.guest(code, payload.guest_phone || 'unknown');
    const existing = (await kv.get(guestKey)) || {};
    await kv.set(guestKey, {
      ...existing,
      phone: payload.guest_phone || '',
      name: payload.name_text || existing.name || '',
      name_clip_url: blob.url,
      channel: payload.channel || '',
      updated_at: now,
    });
    await kv.rpush(keys.events(code), JSON.stringify({
      type: 'name_saved', phone: payload.guest_phone, name: payload.name_text || '', at: now,
    }));
    return;
  }

  // kind === 'clip' (default)
  const record = {
    id: blob.pathname.split('/').pop(),
    url: blob.url,
    guest_phone: payload.guest_phone || '',
    channel: payload.channel || '', // 'call' | 'text'
    twilio_sid: payload.twilio_sid || '',
    duration_seconds: payload.duration_seconds ?? null,
    content_type: blob.contentType || '',
    removed: false,
    flags: [],
    created_at: now,
  };
  if (record.duration_seconds != null) {
    if (record.duration_seconds < 3) record.flags.push('too_short');
    if (record.duration_seconds > 300) record.flags.push('too_long');
  } else {
    record.flags.push('duration_unknown');
  }

  await kv.rpush(keys.clips(code), JSON.stringify(record));
  await kv.rpush(keys.events(code), JSON.stringify({
    type: 'clip_saved', phone: payload.guest_phone, channel: payload.channel, at: now,
  }));

  // Keep a running total on the card record so progress emails/admin can read it directly.
  const card = await kv.get(keys.card(code));
  if (card) {
    const priorSeconds = card.total_seconds || 0;
    const addSeconds = record.duration_seconds || 0;
    await kv.set(keys.card(code), {
      ...card,
      total_seconds: priorSeconds + addSeconds,
      clip_count: (card.clip_count || 0) + 1,
      last_clip_at: now,
    });
  }
}

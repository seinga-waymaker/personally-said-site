// GET /api/order-status?session_id=cs_...
//
// Called by the browser on the success page (Phase 1 build spec, section 4:
// "Success page after checkout shows the card code + guest instructions
// right away, not just in email"). The Stripe webhook that actually creates
// the card runs asynchronously, so the success page polls this endpoint for
// a few seconds until the card is ready.
//
// No shared secret here (unlike /api/lookup, which is server-to-server) --
// this is called straight from the customer's browser. Safe because a
// Checkout Session id is a long random token only the person who just paid
// has (Stripe puts it in the success_url query string), same trust model as
// Stripe's own hosted success pages. Only non-sensitive fields go back: no
// email, no payment details.
const { redis, keys, asCode } = require('./_lib/redis');

module.exports = async (req, res) => {
    if (req.method !== 'GET') {
          res.setHeader('Allow', 'GET');
          return res.status(405).json({ error: 'Method not allowed' });
    }
    res.setHeader('Cache-Control', 'no-store');

    const sessionId = (req.query && req.query.session_id || '').trim();
    if (!sessionId || !sessionId.startsWith('cs_')) {
          return res.status(200).json({ ready: false, reason: 'missing_or_invalid_session_id' });
    }

    try {
          const kv = redis();
          const code = asCode(await kv.get(keys.session(sessionId)));
          if (!code || code === '__pending__') {
                  // Webhook hasn't landed yet -- normal right after redirect. Client should retry.
            return res.status(200).json({ ready: false });
          }

      const card = await kv.get(keys.card(code));
          if (!card) return res.status(200).json({ ready: false });

      return res.status(200).json({
              ready: true,
              code: asCode(card.code),
              twilio_code: asCode(card.twilio_code),
              tier_name: card.tier_name || '',
              max_minutes: card.max_minutes,
              recipient_name: card.recipient_name || '',
              reveal_date: card.reveal_date || '',
              message_deadline: card.message_deadline || '',
      });
    } catch (err) {
          console.error('[order-status] error:', err);
          // Fail soft -- the client just keeps polling / falls back to "check your email".
      return res.status(200).json({ ready: false, reason: 'server_error' });
    }
};

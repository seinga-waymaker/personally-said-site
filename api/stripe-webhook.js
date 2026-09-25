// POST /api/stripe-webhook
// Stripe checkout.session.completed -> generate card code -> store order in Redis
// -> write the code back onto the Stripe session + payment.
const Stripe = require('stripe');
const { redis, keys, asCode } = require('./_lib/redis');
const { resolveTier, reserveNewCode, METADATA_FIELDS, clean } = require('./_lib/cards');

const PENDING = '__pending__';

// Stripe signs the exact raw bytes, so we read the raw stream ourselves
// and never touch req.body.
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

function stripeClient() {
  return Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const stripe = stripeClient();
  let event;
  try {
    const raw = await readRawBody(req);
    event = stripe.webhooks.constructEvent(raw, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[stripe-webhook] signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook signature error: ${err.message}` });
  }

  // Card payments arrive as checkout.session.completed with payment_status "paid".
  // Delayed methods complete "unpaid" and settle later via async_payment_succeeded.
  const handled = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];
  if (!handled.includes(event.type)) return res.status(200).json({ received: true, ignored: event.type });

  const session = event.data.object;
  if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
    return res.status(200).json({ received: true, waiting_for_payment: session.id });
  }

  try {
    const result = await fulfill(stripe, session);
    return res.status(200).json({ received: true, ...result });
  } catch (err) {
    // Non-2xx makes Stripe retry with backoff for up to 3 days.
    console.error('[stripe-webhook] fulfillment failed:', session.id, err);
    return res.status(500).json({ error: 'Fulfillment failed; Stripe will retry' });
  }
}

async function fulfill(stripe, session) {
  const kv = redis();
  const sessionKey = keys.session(session.id);

  // ---- Idempotency: Stripe can deliver the same event more than once ----
  const locked = await kv.set(sessionKey, PENDING, { nx: true, ex: 120 });
  if (!locked) {
    const existing = asCode(await kv.get(sessionKey));
    if (existing && existing !== PENDING) {
      // Already fulfilled. Make sure the code made it back onto the Stripe session.
      if (!session.metadata || !session.metadata.card_code) {
        const record = await kv.get(keys.card(existing));
        if (record) {
          await syncCodeToStripe(stripe, session, record).catch((err) =>
            console.error('[stripe-webhook] re-sync to Stripe failed:', err.message),
          );
        }
      }
      return { duplicate: true, code: existing };
    }
    // Another invocation is mid-flight; make Stripe retry later.
    throw new Error('Session is currently being processed by another invocation');
  }

  try {
    const order = await buildOrder(stripe, session);
    const { code, twilioCode } = await reserveNewCode(kv, keys);
    const createdUnix = session.created || Math.floor(Date.now() / 1000);

    const record = {
      code,
      twilio_code: twilioCode,
      status: 'active',
      source: 'stripe',
      created_at: new Date(createdUnix * 1000).toISOString(),
      fulfilled_at: new Date().toISOString(),
      ...order,
    };

    await kv.set(keys.card(code), record);
    await kv.zadd(keys.orders, { score: createdUnix, member: code });
    await kv.set(sessionKey, code); // replaces the pending lock, no expiry

    try {
      await syncCodeToStripe(stripe, session, record);
    } catch (err) {
      // The card already exists + works for lookup; a retry/duplicate will re-sync.
      console.error('[stripe-webhook] could not write code back to Stripe:', err.message);
    }

    console.log(`[stripe-webhook] card ${code} (${twilioCode}) created for ${session.id}`);
    return { code, twilio_code: twilioCode };
  } catch (err) {
    await kv.del(sessionKey); // release the lock so a retry can run
    throw err;
  }
}

// Collect everything we need from the session. Metadata is the main source.
// Older checkout sessions used "design" + "custom_track_detail", so those are fallbacks.
async function buildOrder(stripe, session) {
  const md = session.metadata || {};
  const custom = {};
  for (const f of session.custom_fields || []) {
    custom[f.key] = (f.text && f.text.value) || (f.dropdown && f.dropdown.value) || (f.numeric && f.numeric.value) || '';
  }
  const pick = (...names) => {
    for (const n of names) {
      if (md[n]) return clean(md[n]);
      if (custom[n]) return clean(custom[n]);
    }
    return '';
  };

  // Line items tell us which saved Price was bought, if any.
  let linePriceId = '';
  try {
    const items = await stripe.checkout.sessions.listLineItems(session.id, { limit: 5 });
    const price = items.data[0] && items.data[0].price;
    linePriceId = (price && price.id) || '';
  } catch (err) {
    console.warn('[stripe-webhook] could not list line items:', err.message);
  }

  const priceId = pick('price_id') || linePriceId;
  const tier = resolveTier({ key: md.tier, priceId, amount: session.amount_total });

  const order = {
    stripe_session_id: session.id,
    payment_intent:
      typeof session.payment_intent === 'string' ? session.payment_intent : (session.payment_intent && session.payment_intent.id) || '',
    livemode: !!session.livemode,
    amount_total: session.amount_total,
    currency: session.currency,
    customer_email: (session.customer_details && session.customer_details.email) || session.customer_email || '',
    purchaser_name: (session.customer_details && session.customer_details.name) || '',
    tier: tier ? tier.key : 'unknown',
    tier_name: tier ? tier.name : 'Unknown tier',
    max_minutes: tier ? tier.minutes : null,
  };
  order.from_name = pick('from_name');
  order.recipient_name = pick('recipient_name');
  order.recipient_email = pick('recipient_email');
  order.reveal_date = pick('reveal_date');
  order.card_design = pick('card_design', 'design');
  order.custom_track = pick('custom_track', 'custom_track_detail');
  order.price_id = priceId;
  // Keep the list in sync with METADATA_FIELDS.
  for (const f of METADATA_FIELDS) if (order[f] == null) order[f] = '';
  return order;
}

async function syncCodeToStripe(stripe, session, record) {
  const extra = { card_code: record.code, twilio_code: record.twilio_code };
  // Metadata updates merge, so existing keys are kept.
  await stripe.checkout.sessions.update(session.id, { metadata: extra });
  if (record.payment_intent) {
    // Also on the PaymentIntent so the code shows on the Payments page in the dashboard.
    await stripe.paymentIntents.update(record.payment_intent, { metadata: extra }).catch((err) => {
      console.warn('[stripe-webhook] PaymentIntent metadata update skipped:', err.message);
    });
  }
}

module.exports = handler;
// Tells Vercel not to pre-parse the body (Stripe needs the raw bytes).
module.exports.config = { api: { bodyParser: false } };

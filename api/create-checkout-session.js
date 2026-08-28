// Vercel serverless function: creates a Stripe Checkout Session for a Personally Said card order.
// The browser never sees a Stripe secret key or handles raw card data — Stripe's own
// hosted Checkout page collects payment details directly.

const Stripe = require('stripe');

// Prices are authoritative here, on the server — never trust an amount sent from the browser.
const TIERS = {
  hello: { name: 'A Quick Hello', price: 1000, turnaround: 'Up to ~5 min · ready in 1–3 business days' },
  catchup: { name: "Let's Catch Up", price: 2500, turnaround: 'Up to ~15 min · ready in 5–7 business days' },
  stories: { name: "We've Got Stories", price: 5000, turnaround: 'Up to ~30 min · ready in 7–10 business days' }
};

function clean(value, maxLen) {
  return typeof value === 'string' ? value.slice(0, maxLen) : '';
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    console.error('STRIPE_SECRET_KEY is not set in the environment');
    res.status(500).json({ error: 'Payment processing is not configured yet. Please try again later.' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (err) {
      body = {};
    }
  }
  body = body || {};

  const tierKey = body.tier;
  const tier = TIERS[tierKey];
  if (!tier) {
    res.status(400).json({ error: 'Please choose a card length before checking out.' });
    return;
  }

  const stripe = Stripe(secretKey, { apiVersion: '2024-06-20' });
  const origin = req.headers.origin || `https://${req.headers.host}`;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      managed_payments: { enabled: false },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: tier.price,
            product_data: {
              name: `Personally Said — ${tier.name}`,
              description: tier.turnaround
            }
          }
        }
      ],
      metadata: {
        tier: tierKey,
        tier_name: tier.name,
        from_name: clean(body.fromName, 200),
        recipient_name: clean(body.recipientName, 200),
        recipient_email: clean(body.recipientEmail, 200),
        design: clean(body.design, 100),
        reveal_date: clean(body.revealDate, 40),
        custom_track_detail: clean(body.customTrackDetail, 500)
      },
      success_url: `${origin}/?order=success&tier=${encodeURIComponent(tierKey)}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?order=cancelled&tier=${encodeURIComponent(tierKey)}`
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout session creation failed:', err);
    res.status(500).json({ error: 'Something went wrong starting checkout. Please try again.' });
  }
};

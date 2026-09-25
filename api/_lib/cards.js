const { randomInt } = require('crypto');

// ---------- Tiers ----------
// Keys match what the site already sends to /api/create-checkout-session.
// priceEnv is optional: set STRIPE_PRICE_* in Vercel to use saved Stripe Prices,
// otherwise checkout keeps using inline price_data with these amounts.
const TIERS = {
  hello:   { key: 'hello',   name: 'A Quick Hello',     minutes: 5,  amount: 1000, priceEnv: 'STRIPE_PRICE_QUICK_HELLO', turnaround: 'Up to ~5 min · ready in 1–3 business days' },
  catchup: { key: 'catchup', name: "Let's Catch Up",    minutes: 15, amount: 2500, priceEnv: 'STRIPE_PRICE_CATCH_UP',   turnaround: 'Up to ~15 min · ready in 5–7 business days' },
  stories: { key: 'stories', name: "We've Got Stories", minutes: 30, amount: 5000, priceEnv: 'STRIPE_PRICE_STORIES',    turnaround: 'Up to ~30 min · ready in 7–10 business days' },
};

function priceIdForTier(tier) {
  return (tier && process.env[tier.priceEnv]) || '';
}

// Work out the tier from whatever we have: tier key, Stripe price id, or amount paid.
function resolveTier({ key, priceId, amount } = {}) {
  if (key && TIERS[key]) return TIERS[key];
  const all = Object.values(TIERS);
  if (priceId) {
    const byPrice = all.find((t) => process.env[t.priceEnv] && process.env[t.priceEnv] === priceId);
    if (byPrice) return byPrice;
  }
  if (amount != null) {
    const byAmount = all.find((t) => t.amount === amount);
    if (byAmount) return byAmount;
  }
  return null;
}

// ---------- Card codes ----------
// 4 characters, no I / 1 / O / 0.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;

function generateCode() {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

// Callers type the code on a phone keypad, so every code also has a digits-only
// "Twilio Code" (same idea as the Twilio Code column in the old Sheet).
// ABC all become 2, DEF become 3, etc., so the webhook reserves the keypad form
// too and no two cards ever share the same digits.
const KEYPAD = {
  A: 2, B: 2, C: 2, D: 3, E: 3, F: 3, G: 4, H: 4, I: 4, J: 5, K: 5, L: 5, M: 6,
  N: 6, O: 6, P: 7, Q: 7, R: 7, S: 7, T: 8, U: 8, V: 8, W: 9, X: 9, Y: 9, Z: 9,
};

function toKeypad(code) {
  return String(code)
    .toUpperCase()
    .split('')
    .map((ch) => (/[0-9]/.test(ch) ? ch : KEYPAD[ch] != null ? String(KEYPAD[ch]) : ''))
    .join('');
}

// Trim, uppercase, strip spaces/dashes/#/*. No character remapping:
// legacy codes like 0831 legitimately contain 0 and 1.
function normalizeCode(raw) {
  return String(raw || '').toUpperCase().replace(/[\s\-_.#*]/g, '');
}

// Reserve a brand new code whose letters AND keypad digits are both unused.
async function reserveNewCode(kv, keys, attempts = 25) {
  for (let i = 0; i < attempts; i++) {
    const code = generateCode();
    const twilioCode = toKeypad(code);
    const keypadOk = await kv.set(keys.keypad(twilioCode), code, { nx: true });
    if (!keypadOk) continue;
    const cardOk = await kv.set(keys.card(code), { code, status: 'reserving' }, { nx: true });
    if (cardOk) return { code, twilioCode };
    await kv.del(keys.keypad(twilioCode));
  }
  throw new Error(`Could not find a free card code after ${attempts} attempts`);
}

// ---------- Metadata ----------
const METADATA_FIELDS = [
  'from_name',
  'recipient_name',
  'recipient_email',
  'reveal_date',
  'card_design',
  'custom_track',
  'price_id',
];

// Stripe metadata values are strings, max 500 chars.
function clean(value, maxLen = 500) {
  if (value == null) return '';
  return String(value).trim().slice(0, maxLen);
}

module.exports = {
  TIERS,
  priceIdForTier,
  resolveTier,
  CODE_ALPHABET,
  CODE_LENGTH,
  generateCode,
  toKeypad,
  normalizeCode,
  reserveNewCode,
  METADATA_FIELDS,
  clean,
};


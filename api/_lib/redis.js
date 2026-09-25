// Shared Redis client for the /api functions.
// Files in folders starting with "_" inside /api are not deployed as routes on Vercel.
//
// Vercel KV was retired in favor of "Upstash for Redis" (Vercel Marketplace).
// Linking an Upstash store to the project injects KV_REST_API_URL + KV_REST_API_TOKEN
// (and/or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN). Either pair works.
const { Redis } = require('@upstash/redis');

let client = null;

function redis() {
  if (client) return client;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error('Redis env vars missing: link an Upstash for Redis store to this Vercel project');
  }
  client = new Redis({ url, token });
  return client;
}

// One place for key names so every route agrees.
const keys = {
  card: (code) => `card:${code}`,         // full order record (JSON)
  keypad: (digits) => `keypad:${digits}`, // phone keypad digits -> card code
  session: (id) => `session:${id}`,       // Stripe checkout session id -> card code (idempotency)
  orders: 'orders',                       // sorted set: score = created (unix s), member = card code
};

// Upstash auto-parses values that look like JSON, so an all-digit code such as
// "2345" comes back as the number 2345. Always coerce codes back to strings.
function asCode(value) {
  return value == null ? null : String(value);
}

module.exports = { redis, keys, asCode };

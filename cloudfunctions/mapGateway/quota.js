'use strict';
const crypto = require('node:crypto');
const COLLECTION = 'request_limits';
function positiveLimit(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 && value <= 1000000 ? value : fallback;
}
// Read all counters before writing any. Use inside the business transaction when
// a successful mutation must consume exactly one token (including retries).
async function consume(transaction, rules, now = Date.now()) {
  const records = [];
  for (const rule of rules) {
    const id = crypto.createHash('sha256').update(rule.key).digest('hex');
    const ref = transaction.collection(COLLECTION).doc(id);
    const result = await ref.get();
    if (result && result.code) throw new Error('Quota storage unavailable');
    const old = result && (Array.isArray(result.data) ? result.data[0] : result.data);
    const window = Math.floor(now / rule.windowMs);
    const count = old && old.window === window ? Number(old.count || 0) : 0;
    if (count >= rule.limit) return false;
    records.push({ ref, value: { window, count: count + 1, updatedAt: new Date(now), expiresAt: new Date(now + rule.windowMs * 2) } });
  }
  for (const row of records) {
    const result = await row.ref.set(row.value);
    if (result && result.code) throw new Error('Quota storage unavailable');
  }
  return true;
}
module.exports = { consume, positiveLimit };

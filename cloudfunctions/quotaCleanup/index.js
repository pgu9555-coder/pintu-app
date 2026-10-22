'use strict';
const cloudbase = require('@cloudbase/node-sdk');
const db = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV }).database();

// Client invocation is denied by the default function rule. Only the timer or
// an administrator can run this bounded cleanup of expired rate counters.
exports.main = async () => {
  const cutoff = new Date();
  let deleted = 0;
  for (let batch = 0; batch < 20; batch++) {
    const result = await db.collection('request_limits')
      .where({ expiresAt: db.command.lt(cutoff) }).limit(100).get();
    if (result.code) throw new Error('Quota cleanup read failed');
    const rows = result.data || [];
    if (!rows.length) return { deleted, complete: true };
    // Check expiry again in the delete query: a concurrent request may have
    // renewed a counter after the preceding read.
    const removed = await db.collection('request_limits').where({
      _id: db.command.in(rows.map(row => row._id)),
      expiresAt: db.command.lt(cutoff)
    }).remove();
    if (removed.code) throw new Error('Quota cleanup delete failed');
    deleted += Number(removed.deleted || 0);
  }
  return { deleted, complete: false };
};

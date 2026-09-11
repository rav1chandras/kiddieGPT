const active = new Set();

// The dedicated connection owns the advisory lock until the response is persisted.
async function acquireBillingLock(pool, key) {
  if (active.has(key)) return null;
  active.add(key);
  let client;
  try {
    if (pool) {
      client = await pool.connect();
      const result = await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", ["billing:" + key]);
      if (!result.rows[0].locked) { client.release(); active.delete(key); return null; }
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try { if (client) await client.query("SELECT pg_advisory_unlock(hashtext($1))", ["billing:" + key]); }
      finally { if (client) client.release(); active.delete(key); }
    };
  } catch (error) {
    if (client) client.release();
    active.delete(key);
    throw error;
  }
}

module.exports = { acquireBillingLock };

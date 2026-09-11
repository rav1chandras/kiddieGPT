function enqueueEmail(db, item, now = Date.now()) {
  db.emailOutbox ||= [];
  if (db.emailOutbox.some(e => e.id === item.id)) return false;
  db.emailOutbox.push({ ...item, state: "pending", attempts: 0, createdAt: new Date(now).toISOString(), nextAttemptAt: now });
  return true;
}

function retryDelay(attempts) {
  return Math.min(24 * 3600000, 60000 * 2 ** Math.min(attempts, 10));
}

// Postgres claims are atomic across serverless instances. Successful delivery
// retains only the deduplication ID, not the recipient or message body.
async function drainPostgres(pool, send, limit = 5) {
  let delivered = 0;
  const deadline = Date.now() + 20000;
  for (let i = 0; i < limit && Date.now() < deadline; i++) {
    const { rows } = await pool.query(`UPDATE email_deliveries SET state='sending', lease_until=now()+interval '2 minutes'
      WHERE id=(SELECT id FROM email_deliveries WHERE (state='pending' AND next_attempt<=now())
      OR (state='sending' AND lease_until<now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id,payload,attempts`);
    const item = rows[0];
    if (!item) break;
    try {
      await send(item.payload);
      await pool.query("UPDATE email_deliveries SET state='sent',payload='{}'::jsonb,lease_until=NULL WHERE id=$1", [item.id]);
      delivered++;
    } catch (error) {
      await pool.query("UPDATE email_deliveries SET state='pending',attempts=attempts+1,next_attempt=now()+($2 * interval '1 millisecond'),lease_until=NULL WHERE id=$1", [item.id, retryDelay(item.attempts + 1)]);
    }
  }
  return delivered;
}

module.exports = { enqueueEmail, retryDelay, drainPostgres };

const cron = require('node-cron');
const { pool } = require('./db');
const ghl = require('./ghl');

// Don't check a contact within the first couple hours of being blasted — there's
// been no realistic time for a reply yet, and it just burns API calls.
const MIN_AGE_MINUTES = 120;

async function checkOne(row) {
  const client = await pool.connect();
  try {
    let conversationId = row.conversation_id;

    if (!conversationId) {
      conversationId = await ghl.findConversationId(row.contact_id, row.location_id);
      if (conversationId) {
        await client.query(`UPDATE blast_tracking SET conversation_id = $1 WHERE id = $2`, [
          conversationId,
          row.id,
        ]);
      }
    }

    // No conversation thread at all yet = definitionally no reply.
    const replied = conversationId
      ? await ghl.hasRepliedSince(conversationId, row.blasted_at)
      : false;

    if (replied) {
      // Terminal: stop rechecking, and remove the no-response tag since it's no
      // longer accurate.
      if (row.current_tag) {
        await ghl.removeTag(row.contact_id, row.current_tag);
      }
      await client.query(
        `UPDATE blast_tracking
         SET status = 'responded', responded_at = now(), last_checked_at = now(), updated_at = now(), error = NULL, current_tag = NULL
         WHERE id = $1`,
        [row.id]
      );
      console.log(`[responded] contact=${row.contact_id} campaign=${row.campaign_tag} (tag removed)`);
    } else {
      // Still no reply: tag reflects the date of THIS check, e.g.
      // "no-response-since-2026-08-31". Runs on the same calendar day reuse the
      // same tag (no churn); once the date rolls over, swap the old dated tag for
      // the new one so the contact only ever carries one no-response tag at a time.
      const todayTag = `no-response-since-${new Date().toISOString().slice(0, 10)}`;

      if (row.current_tag && row.current_tag !== todayTag) {
        await ghl.removeTag(row.contact_id, row.current_tag);
      }
      if (row.current_tag !== todayTag) {
        await ghl.addTag(row.contact_id, todayTag);
      }

      await client.query(
        `UPDATE blast_tracking SET last_checked_at = now(), updated_at = now(), error = NULL, current_tag = $2 WHERE id = $1`,
        [row.id, todayTag]
      );
      console.log(`[still no response] contact=${row.contact_id} campaign=${row.campaign_tag} tag=${todayTag}`);
    }
  } catch (err) {
    console.error(`check failed for tracking row ${row.id} (contact ${row.contact_id}):`, err.message);
    await client.query(
      `UPDATE blast_tracking SET last_checked_at = now(), updated_at = now(), error = $2 WHERE id = $1`,
      [row.id, String(err.message).slice(0, 500)]
    );
  } finally {
    client.release();
  }
}

// Runs checks with a small concurrency cap so we don't blow through GHL's rate limit.
async function runBatch(rows, concurrency = 5) {
  const queue = [...rows];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const row = queue.shift();
      if (row) await checkOne(row);
    }
  });
  await Promise.all(workers);
}

async function runCheckCycle() {
  const cutoff = new Date(Date.now() - MIN_AGE_MINUTES * 60 * 1000);
  const { rows } = await pool.query(
    `SELECT * FROM blast_tracking WHERE status = 'pending' AND blasted_at <= $1 ORDER BY blasted_at ASC LIMIT 500`,
    [cutoff]
  );

  if (!rows.length) {
    console.log('cron: nothing pending to check');
    return;
  }

  console.log(`cron: checking ${rows.length} pending contact(s)`);
  await runBatch(rows);
}

function start() {
  const schedule = process.env.CHECK_CRON || '0 */6 * * *';
  console.log(`cron: scheduled with "${schedule}"`);
  cron.schedule(schedule, () => {
    runCheckCycle().catch((err) => console.error('cron cycle failed:', err));
  });
}

module.exports = { start, runCheckCycle };

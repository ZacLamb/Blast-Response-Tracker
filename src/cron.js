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

    const now = new Date();
    const pastWindow = now >= new Date(row.final_check_at);

    if (replied) {
      await client.query(
        `UPDATE blast_tracking
         SET status = 'responded', responded_at = now(), last_checked_at = now(), updated_at = now(), error = NULL
         WHERE id = $1`,
        [row.id]
      );
      await ghl.addTag(row.contact_id, `responded-${row.campaign_tag}`);
      console.log(`[responded] contact=${row.contact_id} campaign=${row.campaign_tag}`);
    } else if (pastWindow) {
      await client.query(
        `UPDATE blast_tracking
         SET status = 'no_response', last_checked_at = now(), updated_at = now(), error = NULL
         WHERE id = $1`,
        [row.id]
      );
      await ghl.addTag(row.contact_id, `no-response-${row.campaign_tag}`);
      console.log(`[no_response] contact=${row.contact_id} campaign=${row.campaign_tag}`);
    } else {
      await client.query(
        `UPDATE blast_tracking SET last_checked_at = now(), updated_at = now(), error = NULL WHERE id = $1`,
        [row.id]
      );
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

const cron = require('node-cron');
const { pool } = require('./db');
const ghl = require('./ghl');

// Single signal: has this contact EVER sent a single inbound message, in the
// whole conversation history? That's it. No per-blast scoping, no dated tags,
// no "most recent" anything — those all introduced edge cases that made this
// wrong. This is the simple, correct version.
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

    // No conversation thread at all = definitionally never responded.
    const everReplied = conversationId ? await ghl.hasEverReplied(conversationId) : false;

    if (everReplied) {
      // Terminal: they've responded at some point, so stop rechecking and
      // remove the tag if it was applied.
      if (row.never_responded_tag_applied) {
        await ghl.removeTag(row.contact_id, 'never-responded');
      }
      await client.query(
        `UPDATE blast_tracking
         SET status = 'responded', responded_at = now(), last_checked_at = now(), updated_at = now(),
             error = NULL, never_responded_tag_applied = false
         WHERE id = $1`,
        [row.id]
      );
      console.log(`[has responded] contact=${row.contact_id} campaign=${row.campaign_tag}`);
    } else {
      if (!row.never_responded_tag_applied) {
        await ghl.addTag(row.contact_id, 'never-responded');
      }
      await client.query(
        `UPDATE blast_tracking
         SET last_checked_at = now(), updated_at = now(), error = NULL, never_responded_tag_applied = true
         WHERE id = $1`,
        [row.id]
      );
      console.log(`[never responded] contact=${row.contact_id} campaign=${row.campaign_tag}`);
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
  const { rows } = await pool.query(
    `SELECT * FROM blast_tracking WHERE status = 'pending' ORDER BY blasted_at ASC LIMIT 500`
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

module.exports = { start, runCheckCycle, checkOne };

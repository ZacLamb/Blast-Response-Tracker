const cron = require('node-cron');
const { pool } = require('./db');
const ghl = require('./ghl');

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

    // Use the actual last-outbound-message timestamp as the real "blast sent"
    // moment — not the stored blasted_at (webhook receive time), which can lag
    // the real send by days or weeks since these blasts go out manually. Fall
    // back to the stored blasted_at only if no outbound message is found at all.
    let effectiveBlastedAt = row.blasted_at;
    if (conversationId) {
      const lastOutboundAt = await ghl.findLastOutboundTime(conversationId);
      if (lastOutboundAt) effectiveBlastedAt = lastOutboundAt;
    }

    // No conversation thread at all yet = definitionally no reply, on both signals.
    const everReplied = conversationId ? await ghl.hasEverReplied(conversationId) : false;
    const repliedToLatest = conversationId
      ? await ghl.hasRepliedSince(conversationId, effectiveBlastedAt)
      : false;

    // Signal 1: "never responded, ever" — independent of any specific blast.
    if (everReplied && row.never_responded_tag_applied) {
      await ghl.removeTag(row.contact_id, 'never-responded');
    } else if (!everReplied && !row.never_responded_tag_applied) {
      await ghl.addTag(row.contact_id, 'never-responded');
    }

    // Signal 2: "responded to the most recent blast" — dated, resets each new blast.
    if (repliedToLatest) {
      // Terminal: stop rechecking, and remove the no-response tag since it's no
      // longer accurate.
      if (row.current_tag) {
        await ghl.removeTag(row.contact_id, row.current_tag);
      }
      await client.query(
        `UPDATE blast_tracking
         SET status = 'responded', responded_at = now(), last_checked_at = now(), updated_at = now(),
             error = NULL, current_tag = NULL, never_responded_tag_applied = $2
         WHERE id = $1`,
        [row.id, !everReplied]
      );
      console.log(`[responded] contact=${row.contact_id} campaign=${row.campaign_tag} (tag removed)`);
    } else {
      // Still no reply to the latest blast: tag reflects the date of THIS check,
      // e.g. "NR 8-31-26". Runs on the same calendar day reuse the same tag (no
      // churn); once the date rolls over, swap the old dated tag for the new one
      // so the contact only ever carries one no-response tag at a time. Uses UTC
      // so the date doesn't depend on server timezone.
      const now = new Date();
      const todayTag = `NR ${now.getUTCMonth() + 1}-${now.getUTCDate()}-${String(now.getUTCFullYear()).slice(-2)}`;

      if (row.current_tag && row.current_tag !== todayTag) {
        await ghl.removeTag(row.contact_id, row.current_tag);
      }
      if (row.current_tag !== todayTag) {
        await ghl.addTag(row.contact_id, todayTag);
      }

      await client.query(
        `UPDATE blast_tracking
         SET last_checked_at = now(), updated_at = now(), error = NULL, current_tag = $2, never_responded_tag_applied = $3
         WHERE id = $1`,
        [row.id, todayTag, !everReplied]
      );
      console.log(
        `[still no response to latest] contact=${row.contact_id} campaign=${row.campaign_tag} tag=${todayTag} everReplied=${everReplied}`
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

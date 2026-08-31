const BASE = 'https://services.leadconnectorhq.com';

function headers() {
  return {
    Authorization: `Bearer ${process.env.GHL_API_TOKEN}`,
    Version: process.env.GHL_API_VERSION || '2021-04-15',
    'Content-Type': 'application/json',
  };
}

async function ghlFetch(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { ...headers(), ...(opts.headers || {}) } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GHL API ${res.status} on ${url}: ${body}`);
  }
  return res.json();
}

// Finds the conversation thread for a contact. Returns null if no thread exists yet
// (which itself means: no messages of any direction — treat as never responded).
async function findConversationId(contactId, locationId) {
  const url = `${BASE}/conversations/search?locationId=${encodeURIComponent(
    locationId
  )}&contactId=${encodeURIComponent(contactId)}`;
  const data = await ghlFetch(url);
  const convo = data.conversations?.[0];
  return convo?.id ?? null;
}

// Finds the timestamp of the most recent OUTBOUND message in the conversation —
// this is the real "blast was sent" moment, which can differ from when our
// webhook happened to fire (blasts are manual and the trigger can lag by weeks).
// Messages come back newest-first, so the first outbound message encountered
// while scanning from the top is the most recent one. Returns null if there's
// no outbound message at all (shouldn't normally happen for a blasted contact).
async function findLastOutboundTime(conversationId) {
  let cursor = null;
  let pages = 0;

  do {
    const url = new URL(`${BASE}/conversations/${conversationId}/messages`);
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('lastMessageId', cursor);

    const data = await ghlFetch(url.toString());
    const msgs = data.messages?.messages || data.messages || [];

    const lastOutbound = msgs.find((m) => m.direction === 'outbound');
    if (lastOutbound) return lastOutbound.dateAdded;

    cursor = msgs.length === 100 ? msgs[msgs.length - 1].id : null;
    pages += 1;
    // Safety cap: don't page through an entire huge history just to find one
    // outbound message — 5 pages (500 messages) is far more than any normal
    // conversation needs for this.
  } while (cursor && pages < 5);

  return null;
}

// Walks the full message history of a conversation and returns true if ANY
// inbound message exists, ever. This is a separate signal from hasRepliedSince:
// "has this contact ever engaged at all" vs "did they respond to the most
// recent blast specifically."
async function hasEverReplied(conversationId) {
  let cursor = null;

  do {
    const url = new URL(`${BASE}/conversations/${conversationId}/messages`);
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('lastMessageId', cursor);

    const data = await ghlFetch(url.toString());
    const msgs = data.messages?.messages || data.messages || [];

    if (msgs.some((m) => m.direction === 'inbound')) {
      return true;
    }

    cursor = msgs.length === 100 ? msgs[msgs.length - 1].id : null;
  } while (cursor);

  return false;
}

// Walks the full message history of a conversation and returns true if any inbound
// message exists after `sinceIso` — i.e. the contact replied after this specific
// blast went out. A reply that predates the blast (an older, unrelated
// conversation) doesn't count as a response to THIS blast.
async function hasRepliedSince(conversationId, sinceIso) {
  const sinceMs = new Date(sinceIso).getTime();
  let cursor = null;

  do {
    const url = new URL(`${BASE}/conversations/${conversationId}/messages`);
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('lastMessageId', cursor);

    const data = await ghlFetch(url.toString());
    const msgs = data.messages?.messages || data.messages || [];

    for (const m of msgs) {
      if (m.direction === 'inbound' && new Date(m.dateAdded).getTime() >= sinceMs) {
        return true;
      }
    }

    // Stop paging once we're back before the blast date — messages are returned
    // newest-first, so once we're past sinceMs there's nothing more relevant.
    const oldestInPage = msgs[msgs.length - 1];
    const pageWentPastWindow = oldestInPage && new Date(oldestInPage.dateAdded).getTime() < sinceMs;

    cursor = msgs.length === 100 && !pageWentPastWindow ? oldestInPage.id : null;
  } while (cursor);

  return false;
}

// Adds a tag to a contact. GHL's add-tags endpoint merges rather than overwrites,
// so this is safe to call without fetching existing tags first.
async function addTag(contactId, tag) {
  const url = `${BASE}/contacts/${contactId}/tags`;
  return ghlFetch(url, {
    method: 'POST',
    body: JSON.stringify({ tags: [tag] }),
  });
}

// Removes a tag from a contact.
async function removeTag(contactId, tag) {
  const url = `${BASE}/contacts/${contactId}/tags`;
  return ghlFetch(url, {
    method: 'DELETE',
    body: JSON.stringify({ tags: [tag] }),
  });
}

module.exports = {
  findConversationId,
  findLastOutboundTime,
  hasEverReplied,
  hasRepliedSince,
  addTag,
  removeTag,
};

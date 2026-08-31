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

// Walks the full message history of a conversation and returns true if ANY
// inbound message exists, ever — the contact has responded at least once, at
// some point, regardless of when or in reply to what.
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

module.exports = { findConversationId, hasEverReplied, addTag, removeTag };

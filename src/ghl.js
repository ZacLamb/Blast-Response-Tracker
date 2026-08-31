const BASE = 'https://services.leadconnectorhq.com';

function headers() {
  return {
    Authorization: `Bearer ${process.env.GHL_API_TOKEN}`,
    Version: process.env.GHL_API_VERSION || '2021-04-15',
    'Content-Type': 'application/json',
  };
}

// GHL's documented limit is 100 requests / 10 seconds per location. Stay under
// that with a safety margin (80/10s) so normal traffic (webhooks, manual GHL
// use) isn't crowded out while a big backlog is draining. This is a simple
// sliding-window limiter: every ghlFetch call queues here first.
const RATE_LIMIT_MAX = 80;
const RATE_LIMIT_WINDOW_MS = 10_000;
const rateLimiter = {
  timestamps: [],
  queue: [],
  acquire() {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this._tick();
    });
  },
  _tick() {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    while (this.queue.length && this.timestamps.length < RATE_LIMIT_MAX) {
      this.timestamps.push(now);
      this.queue.shift()();
    }
    if (this.queue.length) setTimeout(() => this._tick(), 50);
  },
};

async function ghlFetch(url, opts = {}, retriesLeft = 3) {
  await rateLimiter.acquire();
  const res = await fetch(url, { ...opts, headers: { ...headers(), ...(opts.headers || {}) } });

  if (res.status === 429 && retriesLeft > 0) {
    const retryAfterMs = Number(res.headers.get('retry-after')) * 1000 || 2000;
    await new Promise((r) => setTimeout(r, retryAfterMs));
    return ghlFetch(url, opts, retriesLeft - 1);
  }

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

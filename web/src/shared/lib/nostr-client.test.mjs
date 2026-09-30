import assert from "node:assert/strict";
import test from "node:test";

/**
 * The query seam, exercised through a fake socket: what `queryEvents` sends,
 * what it waits for, and which of the four outcomes each relay answer becomes.
 *
 * These bind production code (`shared/lib/nostr-client.ts`), not a test
 * helper — remove the auth-refusal branch, the bounded timeout, or the
 * notice bookkeeping and a case below fails.
 */

const RELAY = "ws://relay.test:3000";
const NSEC = "22".repeat(32);

/** Minimal DOM storage so `identity`/`relay-auth` behave like in a browser. */
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.sent = [];
    this.closed = false;
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  send(raw) {
    this.sent.push(JSON.parse(raw));
  }
  close() {
    this.closed = true;
    queueMicrotask(() => this.emit("close", {}));
  }
  emit(type, event) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  message(payload) {
    this.emit("message", { data: JSON.stringify(payload) });
  }
  sentOfType(type) {
    return this.sent.filter((m) => m[0] === type);
  }
}

async function until(predicate, what, ms = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > ms) {
      throw new Error(`timed out waiting for: ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function setup({ lockedPasskey = false, withNsec = true } = {}) {
  const storage = fakeStorage();
  if (withNsec) storage.setItem("buzz.identity.nsec", NSEC);
  globalThis.window = { localStorage: storage };
  globalThis.WebSocket = FakeWebSocket;
  FakeWebSocket.instances = [];

  const signer = await import("./nostr-signer.ts");
  signer.setUserSigningBlockedReason(
    lockedPasskey ? () => signer.SIGNING_BLOCKED_MESSAGE : null,
  );
  const { queryEvents } = await import("./nostr-client.ts");
  const { relayFailureOutcome } = await import("./relay-failure.ts");
  return { queryEvents, relayFailureOutcome, signer, storage };
}

/** Drive open -> AUTH challenge -> AUTH accepted -> REQ sent. */
async function authenticate(ws) {
  ws.emit("open", {});
  ws.message(["AUTH", "challenge-1"]);
  await until(
    () => ws.sentOfType("AUTH").length > 0,
    "the client to answer the AUTH challenge",
  );
  const authEvent = ws.sentOfType("AUTH")[0][1];
  ws.message(["OK", authEvent.id, true]);
  await until(() => ws.sentOfType("REQ").length > 0, "the client to send REQ");
  return ws.sentOfType("REQ")[0];
}

test("a signed-in query completes: AUTH, REQ, events, EOSE", async () => {
  const { queryEvents } = await setup();
  const promise = queryEvents(RELAY, { kinds: [37001], limit: 500 });
  const ws = FakeWebSocket.instances[0];

  const req = await authenticate(ws);
  // Shape: explicit kinds (the relay's p-gate) and a bounded limit.
  assert.deepEqual(req[2].kinds, [37001]);
  assert.equal(req[2].limit, 500);

  const event = {
    id: "a".repeat(64),
    pubkey: "b".repeat(64),
    kind: 37001,
    created_at: 1,
    tags: [],
    content: "{}",
    sig: "c".repeat(128),
  };
  ws.message(["EVENT", req[1], event]);
  ws.message(["EOSE", req[1]]);

  const events = await promise;
  assert.equal(events.length, 1);
  assert.equal(events[0].id, event.id);
});

test("eose with zero events resolves as an empty success", async () => {
  const { queryEvents } = await setup();
  const promise = queryEvents(RELAY, { kinds: [37001], limit: 500 });
  const ws = FakeWebSocket.instances[0];
  const req = await authenticate(ws);
  ws.message(["EOSE", req[1]]);
  assert.deepEqual(await promise, []);
});

test("the wait is bounded: a silent relay times out as unanswered", async () => {
  const { queryEvents, relayFailureOutcome } = await setup();
  const started = Date.now();
  await assert.rejects(
    queryEvents(RELAY, { kinds: [37001] }, { timeoutMs: 40 }),
    /timed out after 40ms/,
  );
  assert.ok(Date.now() - started < 2000, "the wait must be bounded");
  assert.equal(
    relayFailureOutcome(new Error("Relay query timed out after 40ms")),
    "unanswered",
  );
});

test("an error NOTICE survives a dead socket as a verbatim answered refusal", async () => {
  const { queryEvents, relayFailureOutcome, signer } = await setup();
  const promise = queryEvents(RELAY, { kinds: [37015] }, { timeoutMs: 40 });
  const ws = FakeWebSocket.instances[0];
  ws.emit("open", {});
  ws.message(["NOTICE", "restricted: unknown event kind"]);

  await assert.rejects(promise, (error) => {
    assert.equal(
      signer.isSigningBlockedError(error),
      false,
      "a relay refusal must not be mistaken for a local block",
    );
    assert.match(error.message, /restricted: unknown event kind/);
    assert.equal(relayFailureOutcome(error), "answered");
    return true;
  });
});

test("an auth-required CLOSED classifies as auth-required, verbatim", async () => {
  const { queryEvents, relayFailureOutcome } = await setup();
  const promise = queryEvents(RELAY, { kinds: [37001] });
  const ws = FakeWebSocket.instances[0];
  const req = await authenticate(ws);

  // The private relay's answer, twice: the first refusal is the pre-auth race
  // (the client retries once), the second is final.
  ws.message(["CLOSED", req[1], "auth-required: not authenticated"]);
  ws.message(["CLOSED", req[1], "auth-required: not authenticated"]);

  await assert.rejects(promise, (error) => {
    assert.equal(relayFailureOutcome(error), "auth-required");
    assert.match(error.message, /auth-required: not authenticated/);
    return true;
  });
});

test("a locked passkey fails the query as auth-required, not 'did not answer'", async () => {
  // The user's actual chain: passkey registered but locked this session ->
  // `signAsUser` refuses -> the NIP-42 challenge goes unanswered -> the relay
  // (private or not) never serves the query. The page must be able to tell
  // "sign in" from "check your network".
  const { queryEvents, relayFailureOutcome, signer } = await setup({
    lockedPasskey: true,
  });
  const promise = queryEvents(RELAY, { kinds: [37001] });
  const ws = FakeWebSocket.instances[0];
  ws.emit("open", {});
  // Buzz relays always challenge; signing that challenge is where the locked
  // passkey refuses.
  ws.message(["AUTH", "challenge-1"]);

  await assert.rejects(promise, (error) => {
    assert.equal(signer.isSigningBlockedError(error), true);
    assert.equal(relayFailureOutcome(error), "auth-required");
    assert.equal(error.message, signer.SIGNING_BLOCKED_MESSAGE);
    return true;
  });
  assert.equal(
    ws.sentOfType("REQ").length,
    0,
    "the query must not be sent as a second, stray identity",
  );

  signer.setUserSigningBlockedReason(null);
});

test("a challenge the relay never accepts before closing is auth-required", async () => {
  const { queryEvents, relayFailureOutcome } = await setup();
  const promise = queryEvents(RELAY, { kinds: [37001] });
  const ws = FakeWebSocket.instances[0];
  ws.emit("open", {});
  ws.message(["AUTH", "challenge-1"]);
  await until(
    () => ws.sentOfType("AUTH").length > 0,
    "the client to answer the AUTH challenge",
  );
  // Relay drops the socket instead of answering `OK`.
  ws.close();

  await assert.rejects(promise, (error) => {
    assert.equal(relayFailureOutcome(error), "auth-required");
    return true;
  });
});

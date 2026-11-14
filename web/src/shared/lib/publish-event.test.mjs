import assert from "node:assert/strict";
import test from "node:test";

/**
 * The login race on the write seam (`shared/lib/publish-event.ts`). A record sent ahead of the login is refused with
 * `auth-required: not authenticated`, and the app used to send one 400 ms after connecting whether or not the login
 * had gone through: on a slow signer or network, the first of two quick follows was lost. These drive the real
 * `publishEvent` and `openPublishSession` through a stand-in server that refuses records sent before the login.
 */

const RELAY = "ws://relay.test:3000";

class FakeServerSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.sent = [];
    this.loggedIn = false;
    // A real server sends its challenge on connect, so the client always sees it before any answer to a record: a
    // "late" challenge is one that takes over 400 ms to arrive. While `challengePending`, answers to records wait for it.
    this.challengePending = false;
    this.held = [];
    FakeServerSocket.instances.push(this);
  }
  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  emit(type, event) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  message(payload) {
    this.emit("message", { data: JSON.stringify(payload) });
  }
  /** Deliver the challenge, then anything held behind it, in the order a real connection would. */
  challenge(text) {
    this.challengePending = false;
    this.message(["AUTH", text]);
    for (const payload of this.held.splice(0)) this.message(payload);
  }
  /** The server's side: answer a login, and refuse any record that arrives before one went through. */
  send(raw) {
    const frame = JSON.parse(raw);
    this.sent.push(frame);
    const [type, body] = frame;
    queueMicrotask(() => {
      if (type === "AUTH") {
        this.loggedIn = true;
        this.message(["OK", body.id, true, ""]);
      } else if (type === "EVENT") {
        const answer = this.loggedIn
          ? ["OK", body.id, true, ""]
          : ["OK", body.id, false, "auth-required: not authenticated"];
        if (this.challengePending) this.held.push(answer);
        else this.message(answer);
      }
    });
  }
  close() {
    queueMicrotask(() => this.emit("close", {}));
  }
}

const record = {
  id: "e".repeat(64),
  pubkey: "p".repeat(64),
  kind: 3,
  created_at: 1,
  tags: [],
  content: "",
  sig: "s",
};
const slowSigner = (ms) => async (template) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return {
    ...template,
    id: "a".repeat(64),
    pubkey: "p".repeat(64),
    sig: "s",
    created_at: 1,
  };
};

async function load() {
  globalThis.window = {
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };
  globalThis.WebSocket = FakeServerSocket;
  FakeServerSocket.instances = [];
  return import("./publish-event.ts");
}

test("a record waits for a slow login instead of going out ahead of it", async () => {
  const { publishEvent } = await load();
  const result = publishEvent(RELAY, record, { signAuth: slowSigner(700) });
  const ws = FakeServerSocket.instances[0];
  ws.emit("open", {});
  ws.message(["AUTH", "challenge-1"]);
  assert.deepEqual(await result, { accepted: true, message: "" });
  // Sent once, after the login: never ahead of it.
  assert.equal(ws.sent.filter((f) => f[0] === "EVENT").length, 1);
  assert.deepEqual(
    ws.sent.map((f) => f[0]),
    ["AUTH", "EVENT"],
  );
});

test("a record sent before a late challenge is sent once more after the login", async () => {
  const { publishEvent } = await load();
  const result = publishEvent(RELAY, record, { signAuth: slowSigner(10) });
  const ws = FakeServerSocket.instances[0];
  ws.challengePending = true;
  ws.emit("open", {});
  // The challenge takes over 400 ms to arrive, so the record goes out alone; its refusal arrives after the challenge.
  await new Promise((resolve) => setTimeout(resolve, 450));
  ws.challenge("challenge-late");
  assert.deepEqual(await result, { accepted: true, message: "" });
  assert.deepEqual(
    ws.sent.map((f) => f[0]),
    ["EVENT", "AUTH", "EVENT"],
  );
});

test("a refusal that is not about the login is the answer, and nothing is sent again", async () => {
  const { publishEvent } = await load();
  const result = publishEvent(RELAY, record, { signAuth: slowSigner(10) });
  const ws = FakeServerSocket.instances[0];
  ws.send = function (raw) {
    const frame = JSON.parse(raw);
    this.sent.push(frame);
    queueMicrotask(() =>
      this.message(
        frame[0] === "AUTH"
          ? ["OK", frame[1].id, true, ""]
          : [
              "OK",
              frame[1].id,
              false,
              "blocked: you are banned from this community",
            ],
      ),
    );
  };
  ws.emit("open", {});
  ws.message(["AUTH", "challenge-1"]);
  assert.deepEqual(await result, {
    accepted: false,
    message: "blocked: you are banned from this community",
  });
  assert.equal(ws.sent.filter((f) => f[0] === "EVENT").length, 1);
});

test("a session sends a record refused ahead of a late login again once the login is in", async () => {
  const { openPublishSession } = await load();
  const session = openPublishSession(RELAY, { signAuth: slowSigner(10) });
  const ws = FakeServerSocket.instances[0];
  ws.challengePending = true;
  ws.emit("open", {});
  // The session gives up waiting for a challenge after 400 ms and starts sending; the challenge then comes late.
  await new Promise((resolve) => setTimeout(resolve, 450));
  const result = session.publish(record);
  await new Promise((resolve) => setTimeout(resolve, 5));
  ws.challenge("challenge-late");
  assert.deepEqual(await result, { accepted: true, message: "" });
  assert.deepEqual(
    ws.sent.map((f) => f[0]),
    ["EVENT", "AUTH", "EVENT"],
  );
  session.close();
});

test("nothing is sent while changed terms are not agreed to, and sending works again once they are", async () => {
  const { publishEvent, openPublishSession } = await load();
  const { setActionsBlocked, TermsNotAgreedError } = await import(
    "./action-guard.ts"
  );
  setActionsBlocked(true);
  try {
    // One record: refused before any connection is made.
    await assert.rejects(
      publishEvent(RELAY, record, { signAuth: slowSigner(1) }),
      TermsNotAgreedError,
    );
    assert.equal(FakeServerSocket.instances.length, 0);

    // A run of records: the session opens, but its records are refused and none reaches the server.
    const session = openPublishSession(RELAY, { signAuth: slowSigner(1) });
    const ws = FakeServerSocket.instances[0];
    ws.emit("open", {});
    ws.message(["AUTH", "challenge-1"]);
    await assert.rejects(session.publish(record), TermsNotAgreedError);
    assert.equal(ws.sent.filter((f) => f[0] === "EVENT").length, 0);
    session.close();
  } finally {
    setActionsBlocked(false);
  }

  const result = publishEvent(RELAY, record, { signAuth: slowSigner(1) });
  const ws = FakeServerSocket.instances.at(-1);
  ws.emit("open", {});
  ws.message(["AUTH", "challenge-2"]);
  assert.deepEqual(await result, { accepted: true, message: "" });
});

import assert from "node:assert/strict";
import test from "node:test";

import { serverMediaUrl } from "./mediaUrl.ts";
import {
  createMediaTokenSource,
  createServerMediaCache,
  MediaUnavailableError,
} from "./server-media.ts";

/**
 * The signed picture reads, through the production code (`server-media.ts`,
 * `mediaUrl.ts`) with only the browser edges faked: the signer, `fetch` and
 * object URLs. Remove the token reuse, the expiry renewal, the eviction's
 * revoke, the in-flight dedupe or the stopped-watch fence and a case fails.
 */

const ORIGIN = "https://creaton.test";
const SHA = "ab".repeat(32);
const pic = (n) =>
  `${ORIGIN}/media/${String(n).padStart(2, "0").repeat(32)}.png`;

/** A signer that records what it was asked to sign and can be held open. */
function fakeSigner() {
  const calls = [];
  let hold = null;
  return {
    calls,
    holdNext() {
      let release;
      hold = new Promise((resolve) => {
        release = resolve;
      });
      return () => release();
    },
    async sign(template) {
      calls.push(template);
      if (hold) {
        const waiting = hold;
        hold = null;
        await waiting;
      }
      return { ...template, id: `id${calls.length}`, pubkey: "pk", sig: "sig" };
    },
  };
}

function decode(header) {
  assert.match(header, /^Nostr /);
  return JSON.parse(atob(header.slice("Nostr ".length)));
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("serverMediaUrl picks out this server's media path only", () => {
  assert.equal(
    serverMediaUrl(`${ORIGIN}/media/${SHA}.jpg?x=1#y`, ORIGIN),
    `${ORIGIN}/media/${SHA}.jpg`,
  );
  assert.equal(
    serverMediaUrl(`${ORIGIN}/media/${SHA}.thumb.jpg`, `${ORIGIN}/`),
    `${ORIGIN}/media/${SHA}.thumb.jpg`,
  );
  assert.equal(
    serverMediaUrl(`${ORIGIN}/media/${SHA}`, ORIGIN),
    `${ORIGIN}/media/${SHA}`,
  );
  // Another host never gets the token, even with the same path.
  assert.equal(
    serverMediaUrl(`https://elsewhere.test/media/${SHA}.png`, ORIGIN),
    null,
  );
  assert.equal(
    serverMediaUrl(`http://creaton.test/media/${SHA}`, ORIGIN),
    null,
  );
  assert.equal(serverMediaUrl(`${ORIGIN}/media/${SHA}/../x`, ORIGIN), null);
  assert.equal(serverMediaUrl(`${ORIGIN}/media/notahash.png`, ORIGIN), null);
  assert.equal(serverMediaUrl(`${ORIGIN}/upload`, ORIGIN), null);
  assert.equal(serverMediaUrl("not a url", ORIGIN), null);
  assert.equal(serverMediaUrl(null, ORIGIN), null);
});

test("one server-scoped get token is reused until shortly before it expires", async () => {
  let now = 1_000_000_000_000;
  const signer = fakeSigner();
  const tokens = createMediaTokenSource({
    sign: signer.sign,
    signerState: () => ({ key: "alice" }),
    nowMs: () => now,
  });

  const first = await tokens.header("creaton.test");
  const event = decode(first);
  assert.equal(event.kind, 24242);
  const created = Math.floor(now / 1000) - 5;
  assert.equal(event.created_at, created);
  assert.deepEqual(event.tags, [
    ["t", "get"],
    ["expiration", String(created + 60)],
    ["server", "creaton.test"],
  ]);
  assert.ok(!event.tags.some(([name]) => name === "x"), "server-scoped, no x");
  assert.ok(event.content.length > 0);

  now += 30_000; // 35 s into a 60 s token: still handed out again.
  assert.equal(await tokens.header("creaton.test"), first);
  assert.equal(signer.calls.length, 1);

  now += 11_000; // 14 s left, inside the renewal margin: a fresh one.
  const second = await tokens.header("creaton.test");
  assert.notEqual(second, first);
  assert.equal(signer.calls.length, 2);

  // Another host, or a refused token, is never reused.
  await tokens.header("other.test");
  assert.equal(signer.calls.length, 3);
  tokens.drop(await tokens.header("other.test"));
  await tokens.header("other.test");
  assert.equal(signer.calls.length, 4);
});

test("concurrent reads share one signing, and an identity change is fenced", async () => {
  const signer = fakeSigner();
  let who = "alice";
  const tokens = createMediaTokenSource({
    sign: signer.sign,
    signerState: () => ({ key: who }),
  });
  const release = signer.holdNext();
  const a = tokens.header("creaton.test");
  const b = tokens.header("creaton.test");
  assert.equal(signer.calls.length, 1, "one signing in flight at a time");

  // The reader changes while Alice's signing is still open.
  who = "bob";
  const c = tokens.header("creaton.test");
  assert.equal(signer.calls.length, 2);
  const bobs = await c;
  release();
  const [first, second] = await Promise.all([a, b]);
  assert.equal(first, second);
  // Alice's late token did not replace Bob's as the current one.
  assert.equal(await tokens.header("creaton.test"), bobs);
  assert.equal(signer.calls.length, 2);
});

test("signed out or locked: nothing is signed; a refusal is not asked again at once", async () => {
  let state = { blocked: "signed-out" };
  let refuse = true;
  let calls = 0;
  let now = 0;
  const tokens = createMediaTokenSource({
    sign: async (template) => {
      calls += 1;
      if (refuse) throw new Error("user said no");
      return { ...template, id: "i", pubkey: "p", sig: "s" };
    },
    signerState: () => state,
    nowMs: () => now,
    refusalCooldownMs: 30_000,
  });
  await assert.rejects(tokens.header("h"), { reason: "signed-out" });
  state = { blocked: "locked" };
  await assert.rejects(tokens.header("h"), { reason: "locked" });
  assert.equal(calls, 0);

  state = { key: "alice" };
  await assert.rejects(tokens.header("h"), { reason: "refused" });
  await assert.rejects(tokens.header("h"), { reason: "refused" });
  assert.equal(calls, 1, "a refusal is remembered, not re-asked per picture");
  refuse = false;
  now += 30_001;
  await tokens.header("h");
  assert.equal(calls, 2);
});

/** A cache over a fake server: each picture is 10 bytes, and fetches can be held open. */
function fakeServer({ status = 200, type = "image/png" } = {}) {
  const fetches = [];
  const created = [];
  const revoked = [];
  const holds = new Map();
  let signs = 0;
  const tokens = createMediaTokenSource({
    sign: async (template) => {
      signs += 1;
      return { ...template, id: `i${signs}`, pubkey: "p", sig: "s" };
    },
    signerState: () => ({ key: "alice" }),
  });
  const respond = (url) =>
    new Response(new Uint8Array(10), {
      status: typeof status === "function" ? status(url) : status,
      headers: { "content-type": type, "content-length": "10" },
    });
  return {
    fetches,
    created,
    revoked,
    get signs() {
      return signs;
    },
    hold(url) {
      let release;
      holds.set(
        url,
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      return () => release();
    },
    cache(options = {}) {
      return createServerMediaCache({
        tokens,
        fetch: async (url, init) => {
          fetches.push({ url, authorization: init.headers.Authorization });
          const held = holds.get(url);
          if (held) {
            holds.delete(url);
            await held;
          }
          return respond(url);
        },
        createObjectURL: () => {
          const objectUrl = `blob:${created.length}`;
          created.push(objectUrl);
          return objectUrl;
        },
        revokeObjectURL: (objectUrl) => revoked.push(objectUrl),
        ...options,
      });
    },
  };
}

function watchResult(cache, url) {
  const seen = [];
  const stop = cache.watch(url, (result) => seen.push(result));
  return { seen, stop };
}

test("the read carries the token exactly as the server expects", async () => {
  const server = fakeServer();
  const cache = server.cache();
  const { seen } = watchResult(cache, pic(1));
  await flush();
  assert.deepEqual(seen, [{ status: "ready", src: "blob:0" }]);
  const event = decode(server.fetches[0].authorization);
  assert.deepEqual(event.tags.at(-1), ["server", "creaton.test"]);
});

test("concurrent watchers of one picture share one fetch; pictures share one token", async () => {
  const server = fakeServer();
  const cache = server.cache();
  const release = server.hold(pic(1));
  const one = watchResult(cache, pic(1));
  const two = watchResult(cache, pic(1));
  await flush();
  release();
  await flush();
  assert.equal(server.fetches.length, 1);
  assert.deepEqual(one.seen, two.seen);
  assert.deepEqual(one.seen, [{ status: "ready", src: "blob:0" }]);
  // Already loaded: handed over at once, no new fetch.
  const three = watchResult(cache, pic(1));
  assert.deepEqual(three.seen, [{ status: "ready", src: "blob:0" }]);
  watchResult(cache, pic(2));
  await flush();
  assert.equal(server.fetches.length, 2);
  assert.equal(server.signs, 1, "one token for both pictures");
});

test("a stopped watch is never told a late result (stale fetch fence)", async () => {
  const server = fakeServer();
  const cache = server.cache();
  const release = server.hold(pic(1));
  const seen = [];
  // The component showed picture 1, then its address changed to picture 2.
  const stopOld = cache.watch(pic(1), (result) =>
    seen.push(["old", result.src]),
  );
  stopOld();
  cache.watch(pic(2), (result) => seen.push(["new", result.src]));
  await flush();
  release(); // picture 1's slow fetch lands last
  await flush();
  assert.deepEqual(seen, [["new", "blob:0"]]);
});

test("the LRU revokes object URLs it evicts, and never one still shown", async () => {
  const server = fakeServer();
  const cache = server.cache({ maxEntries: 2 });
  const shown = watchResult(cache, pic(1)); // stays on screen
  const a = watchResult(cache, pic(2));
  const b = watchResult(cache, pic(3));
  await flush();
  assert.deepEqual(server.revoked, [], "all three are on screen");
  a.stop();
  assert.deepEqual(server.revoked, ["blob:1"], "the unwatched one goes");
  b.stop();
  assert.deepEqual(server.revoked, ["blob:1"], "two left, within the cap");
  watchResult(cache, pic(4)).stop();
  await flush();
  // Picture 1 is the oldest but still shown, so picture 3 is evicted instead.
  assert.deepEqual(server.revoked, ["blob:1", "blob:2"]);
  shown.stop();
  assert.deepEqual(server.revoked, ["blob:1", "blob:2"], "within the cap");
  // Off screen now, picture 1 is the least recently used and goes next.
  watchResult(cache, pic(5)).stop();
  await flush();
  assert.deepEqual(server.revoked, ["blob:1", "blob:2", "blob:0"]);
});

test("the byte cap evicts too", async () => {
  const server = fakeServer();
  const cache = server.cache({ maxBytes: 25 });
  for (const n of [1, 2, 3]) {
    const watch = watchResult(cache, pic(n));
    await flush();
    watch.stop();
  }
  assert.deepEqual(server.revoked, ["blob:0"]);
});

test("a refused picture fails once and is not fetched again right away", async () => {
  let now = 0;
  const server = fakeServer({ status: 403 });
  const cache = server.cache({ nowMs: () => now, failureMemoMs: 30_000 });
  const first = watchResult(cache, pic(1));
  await flush();
  assert.deepEqual(first.seen, [{ status: "failed", reason: "unavailable" }]);
  first.stop();
  const again = watchResult(cache, pic(1));
  await flush();
  assert.deepEqual(again.seen, [{ status: "failed", reason: "unavailable" }]);
  assert.equal(server.fetches.length, 1);
  now += 30_001;
  watchResult(cache, pic(1));
  await flush();
  assert.equal(server.fetches.length, 2);
});

test("a 401 signs one fresh token and retries once, never more", async () => {
  const server = fakeServer({ status: 401 });
  const cache = server.cache();
  const { seen } = watchResult(cache, pic(1));
  await flush();
  await flush();
  assert.equal(server.fetches.length, 2);
  assert.equal(server.signs, 2);
  assert.notEqual(
    server.fetches[0].authorization,
    server.fetches[1].authorization,
  );
  assert.deepEqual(seen, [{ status: "failed", reason: "unavailable" }]);
});

test("a response that is not a picture is not shown", async () => {
  const server = fakeServer({ type: "text/html" });
  const cache = server.cache();
  const { seen } = watchResult(cache, pic(1));
  await flush();
  assert.deepEqual(seen, [{ status: "failed", reason: "unavailable" }]);
  assert.deepEqual(server.created, []);
});

test("signed out: no fetch at all, and the reason reaches the watcher", async () => {
  const fetches = [];
  const cache = createServerMediaCache({
    tokens: createMediaTokenSource({
      sign: async () => assert.fail("must not sign"),
      signerState: () => ({ blocked: "signed-out" }),
    }),
    fetch: async (url) => {
      fetches.push(url);
      return new Response(null);
    },
    createObjectURL: () => "blob:x",
    revokeObjectURL: () => {},
  });
  const { seen } = watchResult(cache, pic(1));
  await flush();
  assert.deepEqual(seen, [{ status: "failed", reason: "signed-out" }]);
  assert.deepEqual(fetches, []);
  assert.ok(new MediaUnavailableError("locked") instanceof Error);
});

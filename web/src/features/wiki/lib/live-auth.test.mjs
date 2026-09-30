// Authenticated live co-editing: envelope signing, verification, the
// per-peer rate cap, and the receiver's accept path (production functions,
// real Schnorr signatures).
// Run with: node --experimental-strip-types --test src/features/wiki/lib/live-auth.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";

import {
  LIVE_SIGNED_KIND,
  LiveSignError,
  MAX_ENVELOPE_AGE_SECS,
  MAX_UPDATE_BYTES,
  PeerRateLimiter,
  RATE_LIMIT_MAX_MESSAGES,
  RATE_LIMIT_WINDOW_MS,
  bytesToBase64,
  canonicalContent,
  createLiveReceiver,
  liveRoomId,
  parseEnvelope,
  signEnvelope,
  verifyEnvelope,
} from "./live-auth.ts";

const ROOM = liveRoomId("standup");
const PEER = "peer-alice";
const NOW = 1_800_000_000;
const UPDATE = new Uint8Array([1, 2, 3, 4, 5]);

const aliceKey = generateSecretKey();
const alice = getPublicKey(aliceKey);
const signWith = (secret) => async (template) =>
  finalizeEvent(template, secret);

function envelope(overrides = {}) {
  return signEnvelope({
    room: ROOM,
    peer: PEER,
    update: UPDATE,
    sign: signWith(aliceKey),
    nowSecs: NOW,
    ...overrides,
  });
}

const context = (overrides = {}) => ({
  room: ROOM,
  peerId: PEER,
  nowSecs: NOW,
  ...overrides,
});

test("a signed envelope verifies and yields the exact update bytes", async () => {
  const env = await envelope();
  assert.equal(env.v, 1);
  assert.equal(env.pk, alice);
  assert.equal(env.peer, PEER);
  const result = verifyEnvelope(env, context());
  assert.equal(result.ok, true);
  assert.deepEqual([...result.update], [...UPDATE]);
});

test("the envelope is a plain JSON object with the documented fields", async () => {
  const env = await envelope();
  assert.deepEqual(Object.keys(env).sort(), [
    "peer",
    "pk",
    "room",
    "sig",
    "ts",
    "update",
    "v",
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(env)), env);
});

test("the signature covers room, ts, peer and the update bytes", async () => {
  const env = await envelope();
  const expected = canonicalContent({
    room: ROOM,
    ts: NOW,
    peer: PEER,
    update: UPDATE,
  });
  assert.match(
    expected,
    /^buzz-wiki-live\/1\nroom:wiki:standup\nts:\d+\npeer:/,
  );
  assert.match(expected, /\nsha256:[0-9a-f]{64}$/);
  // Each field, changed after signing (and kept self-consistent with the
  // receiver's expectations), invalidates the signature.
  const tampered = [
    ["update", { update: bytesToBase64(new Uint8Array([9, 9, 9])) }, context()],
    ["ts", { ts: NOW + 1 }, context()],
    ["pk", { pk: getPublicKey(generateSecretKey()) }, context()],
    ["room", { room: "wiki:other" }, context({ room: "wiki:other" })],
    ["peer", { peer: "peer-mallory" }, context({ peerId: "peer-mallory" })],
    [
      "sig",
      { sig: env.sig.replace(/^./, env.sig[0] === "a" ? "b" : "a") },
      context(),
    ],
  ];
  for (const [field, patch, ctx] of tampered) {
    const result = verifyEnvelope({ ...env, ...patch }, ctx);
    assert.deepEqual(result, { ok: false, reason: "bad-signature" }, field);
  }
});

test("unsigned payloads are rejected as unsigned (the pre-auth wire format)", () => {
  for (const data of [
    new Uint8Array([1, 2, 3]),
    new Uint8Array([1, 2, 3]).buffer,
    "plain string",
    null,
    undefined,
    [],
    { update: bytesToBase64(UPDATE) },
  ]) {
    assert.deepEqual(verifyEnvelope(data, context()), {
      ok: false,
      reason: "unsigned",
    });
  }
});

test("malformed envelopes are rejected before any crypto", async () => {
  const env = await envelope();
  for (const patch of [
    { v: 2 },
    { room: "" },
    { ts: 1.5 },
    { ts: "1" },
    { update: 5 },
    { peer: "" },
    { pk: "NOT-HEX" },
    { sig: "abcd" },
    { update: "%%%not-base64%%%" },
  ]) {
    const result = verifyEnvelope({ ...env, ...patch }, context());
    assert.equal(result.ok, false, JSON.stringify(patch));
    assert.match(result.reason, /malformed|oversized/, JSON.stringify(patch));
  }
});

test("wrong room and wrong sender are rejected", async () => {
  const env = await envelope();
  assert.deepEqual(verifyEnvelope(env, context({ room: "wiki:other" })), {
    ok: false,
    reason: "wrong-room",
  });
  // A stranger relaying alice's envelope has a different transport id.
  assert.deepEqual(verifyEnvelope(env, context({ peerId: "peer-mallory" })), {
    ok: false,
    reason: "wrong-peer",
  });
});

test("stale and future-dated envelopes are rejected at the 5 minute bound", async () => {
  const env = await envelope();
  const at = (delta) => context({ nowSecs: NOW + delta });
  assert.equal(verifyEnvelope(env, at(MAX_ENVELOPE_AGE_SECS)).ok, true);
  assert.equal(verifyEnvelope(env, at(-MAX_ENVELOPE_AGE_SECS)).ok, true);
  assert.deepEqual(verifyEnvelope(env, at(MAX_ENVELOPE_AGE_SECS + 1)), {
    ok: false,
    reason: "stale",
  });
  assert.deepEqual(verifyEnvelope(env, at(-MAX_ENVELOPE_AGE_SECS - 1)), {
    ok: false,
    reason: "stale",
  });
});

test("oversized updates are refused on both sides", async () => {
  await assert.rejects(
    envelope({ update: new Uint8Array(MAX_UPDATE_BYTES + 1) }),
    (error) => error instanceof LiveSignError && error.reason === "too-large",
  );
  // The largest permitted update round-trips.
  const big = await envelope({ update: new Uint8Array(MAX_UPDATE_BYTES) });
  assert.equal(verifyEnvelope(big, context()).ok, true);
  // A hostile sender skips our guard: the receiver still refuses.
  const hostile = {
    ...big,
    update: bytesToBase64(new Uint8Array(MAX_UPDATE_BYTES + 3)),
  };
  assert.deepEqual(verifyEnvelope(hostile, context()), {
    ok: false,
    reason: "oversized",
  });
});

test("a signer that rewrites the event is caught when signing", async () => {
  const meddling = async (template) =>
    finalizeEvent(
      { ...template, created_at: template.created_at + 60 },
      aliceKey,
    );
  await assert.rejects(
    envelope({ sign: meddling }),
    (error) =>
      error instanceof LiveSignError && error.reason === "signer-altered-event",
  );
  const wrongKind = async (template) =>
    finalizeEvent({ ...template, kind: 1 }, aliceKey);
  await assert.rejects(envelope({ sign: wrongKind }), LiveSignError);
});

test("the signed event uses the dedicated, never-published kind", async () => {
  let seen = null;
  await envelope({
    sign: async (template) => {
      seen = template;
      return finalizeEvent(template, aliceKey);
    },
  });
  assert.equal(seen.kind, LIVE_SIGNED_KIND);
  assert.deepEqual(seen.tags, []);
  assert.equal(seen.created_at, NOW);
});

test("parseEnvelope only structure-checks", async () => {
  const env = await envelope();
  const parsed = parseEnvelope(env);
  assert.ok("envelope" in parsed);
  assert.deepEqual(parsed.envelope, env);
});

test("the per-peer rate cap allows the cap, then refuses, then recovers", () => {
  const limiter = new PeerRateLimiter();
  for (let i = 0; i < RATE_LIMIT_MAX_MESSAGES; i += 1) {
    assert.equal(limiter.allow("p1", 1_000 + i), true, `message ${i}`);
  }
  assert.equal(limiter.allow("p1", 1_500), false);
  assert.equal(limiter.allow("p2", 1_500), true, "another peer is unaffected");
  assert.equal(
    limiter.allow("p1", 1_000 + RATE_LIMIT_WINDOW_MS + RATE_LIMIT_MAX_MESSAGES),
    true,
    "the window slides",
  );
});

test("the limiter tracks a bounded number of peers", () => {
  const limiter = new PeerRateLimiter(2, 60_000);
  for (let i = 0; i < 2_000; i += 1) limiter.allow(`peer-${i}`, 1_000);
  // Still functional after churn; the earliest peers were forgotten.
  assert.equal(limiter.allow("peer-0", 1_001), true);
});

// ── receiver: the production accept path ──────────────────────────────────

function directory(verdicts) {
  const calls = [];
  return {
    calls,
    check: async (pubkey) => {
      calls.push(pubkey);
      return verdicts[pubkey] ?? "not-member";
    },
    load: async () => "loaded",
  };
}

test("a member's update is accepted with its signer", async () => {
  const members = directory({ [alice]: "member" });
  const receiver = createLiveReceiver({
    room: ROOM,
    members,
    nowMs: () => NOW * 1000,
  });
  const result = await receiver.accept(await envelope(), PEER);
  assert.equal(result.ok, true);
  assert.equal(result.signer, alice);
  assert.deepEqual([...result.update], [...UPDATE]);
});

test("a validly signed update from a non-member is refused", async () => {
  const receiver = createLiveReceiver({
    room: ROOM,
    members: directory({}),
    nowMs: () => NOW * 1000,
  });
  assert.deepEqual(await receiver.accept(await envelope(), PEER), {
    ok: false,
    reason: "not-member",
  });
});

test("with no usable member list nothing is accepted (fail closed)", async () => {
  const receiver = createLiveReceiver({
    room: ROOM,
    members: directory({ [alice]: "unknown" }),
    nowMs: () => NOW * 1000,
  });
  assert.deepEqual(await receiver.accept(await envelope(), PEER), {
    ok: false,
    reason: "membership-unknown",
  });
});

test("membership is checked only after the signature holds", async () => {
  const members = directory({ [alice]: "member" });
  const receiver = createLiveReceiver({
    room: ROOM,
    members,
    nowMs: () => NOW * 1000,
  });
  const env = await envelope();
  const result = await receiver.accept({ ...env, ts: NOW + 1 }, PEER);
  assert.deepEqual(result, { ok: false, reason: "bad-signature" });
  assert.equal(members.calls.length, 0, "no relay lookup for a forged message");
});

test("a flood is cut off by the rate cap before any verification", async () => {
  const members = directory({ [alice]: "member" });
  let now = NOW * 1000;
  const receiver = createLiveReceiver({
    room: ROOM,
    members,
    nowMs: () => now,
  });
  const reasons = [];
  for (let i = 0; i < RATE_LIMIT_MAX_MESSAGES + 10; i += 1) {
    const result = await receiver.accept(
      new Uint8Array([i % 256]),
      "peer-flood",
    );
    reasons.push(result.reason);
  }
  assert.equal(
    reasons.filter((r) => r === "unsigned").length,
    RATE_LIMIT_MAX_MESSAGES,
  );
  assert.equal(reasons.filter((r) => r === "rate-limited").length, 10);
  // A different peer is not affected by someone else's flood.
  const ok = await receiver.accept(await envelope(), PEER);
  assert.equal(ok.ok, true);
  now += RATE_LIMIT_WINDOW_MS + 1;
});

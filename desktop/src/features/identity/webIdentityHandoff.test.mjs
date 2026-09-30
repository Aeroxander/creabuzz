/**
 * Browser → desktop account handoff state machine + copy + Rust↔TS wire
 * seam (`./webIdentityHandoff.ts`, `src-tauri/src/identity_link.rs`,
 * `shared/api/tauriIdentity.ts`).
 *
 * Falsifiability:
 * - The request-id fence: a result from a previous request — or a stray
 *   payload — must never apply to the flow on screen. Weaken the fence and
 *   these tests go red (Review-Proven Rule 2).
 * - The generation fence: a `start()` that resolves after `cancel()` must
 *   not resurrect the state.
 * - The wire seam parses the REAL Rust and TS sources, so renaming a
 *   command, dropping the nonce check, or forgetting to register the
 *   commands in `lib.rs` fails here, not at runtime.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createWebIdentityHandoff,
  rejectedCopy,
  WEB_IDENTITY_HANDOFF_COPY,
} from "./webIdentityHandoff.ts";

const REQUEST_ID = "11111111-1111-1111-1111-111111111111";
const STALE_ID = "99999999-9999-9999-9999-999999999999";
const LINK_URL = "https://app.example.com/link-device?pub=aa&nonce=bb&cb=x";
const NPUB = "npub1fu64hh9hes90w2808n8tjc2ajp5yhddjef0ctx4s7zmsgp6cwx4qgy4eg9";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness(overrides = {}) {
  const calls = { start: 0, cancel: 0, linked: [] };
  let listener = () => {};
  const deps = {
    start: async () => {
      calls.start += 1;
      return { id: REQUEST_ID, url: LINK_URL };
    },
    cancel: () => {
      calls.cancel += 1;
    },
    results: (fn) => {
      listener = fn;
      return () => {
        listener = () => {};
      };
    },
    onLinked: (npub) => {
      calls.linked.push(npub);
    },
    ...overrides,
  };
  const handoff = createWebIdentityHandoff(deps);
  return {
    calls,
    handoff,
    emit: (result) => listener(result),
  };
}

test("start opens the flow and waits for its request", async () => {
  const view = harness();
  await view.handoff.start();
  assert.equal(view.calls.start, 1);
  assert.deepEqual(view.handoff.getState(), {
    phase: "waiting",
    requestId: REQUEST_ID,
    linkUrl: LINK_URL,
  });
});

test("a second start is ignored while one is waiting", async () => {
  const view = harness();
  await view.handoff.start();
  await view.handoff.start();
  assert.equal(view.calls.start, 1);
});

test("the matching linked result links the account", async () => {
  const view = harness();
  await view.handoff.start();
  view.emit({ id: REQUEST_ID, status: "linked", npub: NPUB });
  assert.deepEqual(view.handoff.getState(), { phase: "linked", npub: NPUB });
  assert.deepEqual(view.calls.linked, [NPUB]);
});

test("a stale linked result is fenced away", async () => {
  const view = harness();
  await view.handoff.start();
  view.emit({ id: STALE_ID, status: "linked", npub: NPUB });
  assert.equal(view.handoff.getState().phase, "waiting");
  assert.deepEqual(view.calls.linked, []);
});

test("a stray result with no request id never applies", async () => {
  const view = harness();
  await view.handoff.start();
  view.emit({ id: null, status: "rejected", reason: "no-pending-request" });
  assert.equal(view.handoff.getState().phase, "waiting");
});

test("the matching rejection maps to plain-language copy", async () => {
  const view = harness();
  await view.handoff.start();
  view.emit({ id: REQUEST_ID, status: "rejected", reason: "expired" });
  const state = view.handoff.getState();
  assert.equal(state.phase, "error");
  assert.equal(state.message, rejectedCopy("expired"));
  assert.deepEqual(view.calls.linked, []);
});

test("an unknown reason falls back to the generic copy", () => {
  assert.equal(rejectedCopy("what"), WEB_IDENTITY_HANDOFF_COPY.fallbackError);
  assert.equal(rejectedCopy(null), WEB_IDENTITY_HANDOFF_COPY.fallbackError);
});

test("cancel abandons the flow and drops late results", async () => {
  const deferredStart = deferred();
  const view = harness({ start: () => deferredStart.promise });
  const started = view.handoff.start();
  view.handoff.cancel();
  assert.equal(view.calls.cancel, 1);
  deferredStart.resolve({ id: REQUEST_ID, url: LINK_URL });
  await started;
  // The generation fence: the cancelled start must not resurrect waiting.
  assert.equal(view.handoff.getState().phase, "idle");
  view.emit({ id: REQUEST_ID, status: "linked", npub: NPUB });
  assert.equal(view.handoff.getState().phase, "idle");
  assert.deepEqual(view.calls.linked, []);
});

test("a failed start reports what to do next", async () => {
  const view = harness({
    start: async () => {
      throw new Error("Could not open the browser: nope");
    },
  });
  await view.handoff.start();
  const state = view.handoff.getState();
  assert.equal(state.phase, "error");
  assert.match(state.message, /Couldn't start sign-in/);
  assert.match(state.message, /Could not open the browser/);
});

test("a result that races start() is buffered and applied", async () => {
  const deferredStart = deferred();
  const view = harness({ start: () => deferredStart.promise });
  const started = view.handoff.start();
  view.emit({ id: REQUEST_ID, status: "linked", npub: NPUB });
  deferredStart.resolve({ id: REQUEST_ID, url: LINK_URL });
  await started;
  assert.deepEqual(view.handoff.getState(), { phase: "linked", npub: NPUB });
});

// ── Wire seam: bind these tests to the production Rust/TS sources ─────────

const rust = (name) =>
  readFileSync(
    new URL(`../../../src-tauri/src/${name}`, import.meta.url),
    "utf8",
  );
const ts = (name) =>
  readFileSync(new URL(`../../shared/api/${name}`, import.meta.url), "utf8");

test("lib.rs registers the identity-link commands", () => {
  const lib = rust("lib.rs");
  for (const command of [
    "start_identity_link",
    "cancel_identity_link",
    "take_identity_link_result",
  ]) {
    assert.match(lib, new RegExp(command));
  }
  assert.match(lib, /mod identity_link;/);
});

test("the deep-link dispatcher routes creaton://identity without logging it", () => {
  const deepLink = rust("deep_link.rs");
  assert.match(deepLink, /Some\("identity"\)/);
  assert.match(deepLink, /identity_link::handle_identity_payload/);
  // The wire envelope: `p` (with a legacy `payload` alias) plus `from`.
  assert.match(deepLink, /parse_identity_deep_link_params/);
});

test("identity_link.rs enforces the frozen validation order", () => {
  const core = rust("identity_link.rs");
  // The nonce check is the confused-deputy guard — remove it and this fails.
  assert.match(core, /parsed\.nonce != pending\.nonce_hex/);
  // Expiry, version, and the sender binding (`from` must derive from `sk`).
  assert.match(core, /parsed\.exp < now_unix/);
  assert.match(core, /parsed\.v != HANDOFF_VERSION/);
  assert.match(core, /SenderMismatch/);
  // Single-use consumption and the never-logged contract.
  assert.match(core, /queue\s*\n?\s*\.remove\(index\)/);
  assert.match(core, /never logged/i);
});

test("tauriIdentity.ts exposes the same command names", () => {
  const api = ts("tauriIdentity.ts");
  for (const command of [
    "start_identity_link",
    "cancel_identity_link",
    "take_identity_link_result",
  ]) {
    assert.match(api, new RegExp(`"${command}"`));
  }
  assert.ok(
    !api.includes("web-identity-input"),
    "no paste affordance on the wire",
  );
});

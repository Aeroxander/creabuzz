/**
 * Replace-confirmation state machine + honesty copy + Rust↔TS wire seam for
 * the interim web → desktop identity handoff
 * (`./webIdentityHandoff.ts`, `commands/identity.rs`, `shared/api/tauriIdentity.ts`).
 *
 * Falsifiability:
 * - The cancel guard: a reviewed candidate that is cancelled must never
 *   reach `importNsec` — the mutating command is reachable only from the
 *   `ready` phase via `confirm()`. Weaken that wiring and these tests go red.
 * - The fence: `confirm()` must pass the previewed `currentNpub` so Rust's
 *   compare-and-swap can refuse a stale replacement.
 * - The generation fence: a preview that resolves after `cancel()` must not
 *   resurrect the state (stale async result, Review-Proven Rule 2).
 * - The wire seam parses the REAL Rust and TS sources, so renaming
 *   `preview_identity_import`, dropping `expected_current_npub`, or forgetting
 *   to register the command in `lib.rs` fails here, not at runtime.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createWebIdentityHandoff,
  WEB_IDENTITY_HANDOFF_COPY,
} from "./webIdentityHandoff.ts";

const NSEC = "nsec1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygs4rm7hz";
const CANDIDATE_NPUB =
  "npub1fu64hh9hes90w2808n8tjc2ajp5yhddjef0ctx4s7zmsgp6cwx4qgy4eg9";
const CURRENT_NPUB =
  "npub1currentcurrentcurrentcurrentcurrentcurrentcurrentcurrent2q";

const PREVIEW = {
  pubkey: "4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa",
  npub: CANDIDATE_NPUB,
  currentNpub: CURRENT_NPUB,
  matchesCurrentIdentity: false,
};

const IMPORTED_IDENTITY = {
  pubkey: PREVIEW.pubkey,
  displayName: "4f355b…71aa",
  storage: "system-keyring",
  lost: false,
  locked: false,
  resetFailed: false,
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function recordingDeps(overrides = {}) {
  const calls = { preview: [], importNsec: [], onImported: [] };
  const deps = {
    preview: async (nsec) => {
      calls.preview.push(nsec);
      return overrides.previewResult ?? PREVIEW;
    },
    importNsec: async (nsec, expectedCurrentNpub) => {
      calls.importNsec.push([nsec, expectedCurrentNpub]);
      if (overrides.importError) throw overrides.importError;
      return overrides.imported ?? IMPORTED_IDENTITY;
    },
    onImported: (identity) => {
      calls.onImported.push(identity);
    },
    ...overrides.extraDeps,
  };
  return { deps, calls };
}

test("a cancelled review never reaches the import command", async () => {
  const { deps, calls } = recordingDeps();
  const handoff = createWebIdentityHandoff(deps);

  await handoff.check(NSEC);
  assert.equal(handoff.getState().phase, "ready");

  handoff.cancel();
  assert.deepEqual(handoff.getState(), { phase: "idle" });

  // The falsifiable guard: nothing mutated the identity.
  assert.deepEqual(calls.importNsec, []);
  assert.deepEqual(calls.onImported, []);
});

test("confirm imports exactly once, fenced to the previewed current npub", async () => {
  const { deps, calls } = recordingDeps();
  const handoff = createWebIdentityHandoff(deps);

  await handoff.check(NSEC);
  await handoff.confirm();

  assert.deepEqual(calls.importNsec, [[NSEC, CURRENT_NPUB]]);
  assert.deepEqual(calls.onImported, [IMPORTED_IDENTITY]);
  assert.deepEqual(handoff.getState(), {
    phase: "replaced",
    identity: IMPORTED_IDENTITY,
    npub: CANDIDATE_NPUB,
  });
});

test("confirm without a reviewed preview is a no-op", async () => {
  const { deps, calls } = recordingDeps();
  const handoff = createWebIdentityHandoff(deps);

  // From idle…
  await handoff.confirm();
  // …and from a state the user already cancelled out of.
  await handoff.check(NSEC);
  handoff.cancel();
  await handoff.confirm();

  assert.deepEqual(calls.importNsec, []);
});

test("a preview that resolves after cancel cannot resurrect the state", async () => {
  const pending = deferred();
  const calls = { preview: [], importNsec: [], onImported: [] };
  const handoff = createWebIdentityHandoff({
    preview: (nsec) => {
      calls.preview.push(nsec);
      return pending.promise;
    },
    importNsec: async (nsec, expected) => {
      calls.importNsec.push([nsec, expected]);
      return IMPORTED_IDENTITY;
    },
    onImported: (identity) => calls.onImported.push(identity),
  });

  const inFlight = handoff.check(NSEC);
  assert.equal(handoff.getState().phase, "checking");
  handoff.cancel();
  pending.resolve(PREVIEW);
  await inFlight;

  assert.deepEqual(handoff.getState(), { phase: "idle" });
  assert.deepEqual(calls.importNsec, [], "stale preview must not become ready");
});

test("a stale confirm after a newer check never imports the old candidate", async () => {
  const first = deferred();
  const previews = [first.promise, Promise.resolve(PREVIEW)];
  const calls = { importNsec: [] };
  const handoff = createWebIdentityHandoff({
    preview: () => previews.shift(),
    importNsec: async (nsec, expected) => {
      calls.importNsec.push([nsec, expected]);
      return IMPORTED_IDENTITY;
    },
    onImported: () => {},
  });

  const firstCheck = handoff.check("nsec1firstcandidate");
  await handoff.check(NSEC); // supersedes the in-flight check
  first.resolve(PREVIEW); // stale result lands late
  await firstCheck;

  const state = handoff.getState();
  assert.equal(state.phase, "ready");
  assert.equal(state.nsec, NSEC, "the newest candidate is the reviewed one");
  assert.deepEqual(calls.importNsec, []);
});

test("check failures surface the parse error and never import", async () => {
  const { deps, calls } = recordingDeps({
    previewResult: undefined,
    extraDeps: {
      preview: async () => {
        throw new Error("Invalid private key: not a key");
      },
    },
  });
  const handoff = createWebIdentityHandoff(deps);

  await handoff.check("garbage");

  assert.deepEqual(handoff.getState(), {
    phase: "error",
    stage: "check",
    message: "Invalid private key: not a key",
  });
  assert.deepEqual(calls.importNsec, []);
});

test("import failures surface honestly and skip the post-import re-scope", async () => {
  const { deps, calls } = recordingDeps({
    importError: new Error(
      "The identity on this device changed since you reviewed this replacement.",
    ),
  });
  const handoff = createWebIdentityHandoff(deps);

  await handoff.check(NSEC);
  await handoff.confirm();

  const state = handoff.getState();
  assert.equal(state.phase, "error");
  assert.equal(state.stage, "replace");
  assert.match(state.message, /changed since you reviewed/);
  assert.deepEqual(calls.onImported, []);
});

test("the replace confirmation names the exact identity being replaced", async () => {
  const warning = WEB_IDENTITY_HANDOFF_COPY.replacesLabel(CURRENT_NPUB);
  assert.match(warning, /replaces the identity npub1current/i);
  assert.match(warning, /on this device/);
  assert.match(warning, /backed it up/);
  assert.match(warning, /web session is unaffected/);
});

test("the copy stays honest about the interim posture", () => {
  // Rule 3 of the handoff brief: frame this as interim, never as a passkey
  // export.
  assert.match(
    WEB_IDENTITY_HANDOFF_COPY.interimNote,
    /passkey-native identity/,
    "interim note names the passkey-native future",
  );
  assert.match(
    WEB_IDENTITY_HANDOFF_COPY.interimNote,
    /app signing activation/,
    "interim note says what unlocks it",
  );
  assert.match(
    WEB_IDENTITY_HANDOFF_COPY.notThePasskey,
    /keys never leave the authenticator/,
    "the passkey itself is never claimed to move",
  );
  assert.match(
    WEB_IDENTITY_HANDOFF_COPY.notThePasskey,
    /recovery key/,
    "the actual handoff mechanism is named",
  );
  for (const value of Object.values(WEB_IDENTITY_HANDOFF_COPY)) {
    assert.doesNotMatch(
      typeof value === "string" ? value : "",
      /passkey (was |is )?(copied|exported|moved)/i,
      "no copy may claim the passkey was exported",
    );
  }
});

test("the wire seam agrees across Rust command, TS wrapper, and registration", () => {
  // Falsifiable: rename the command, drop the fence parameter, or forget the
  // lib.rs registration and this goes red.
  const rust = readFileSync(
    new URL("../../../src-tauri/src/commands/identity.rs", import.meta.url),
    "utf8",
  );
  const lib = readFileSync(
    new URL("../../../src-tauri/src/lib.rs", import.meta.url),
    "utf8",
  );
  const api = readFileSync(
    new URL("../../shared/api/tauriIdentity.ts", import.meta.url),
    "utf8",
  );
  const card = readFileSync(
    new URL("./WebIdentityHandoffCard.tsx", import.meta.url),
    "utf8",
  );

  // Rust: read-only preview command with the same parse inputs as import.
  assert.match(rust, /pub async fn preview_identity_import\(/);
  assert.match(rust, /pub struct IdentityImportPreview \{/);
  assert.match(
    rust,
    /#\[serde\(rename_all = "camelCase"\)\]\s*\npub struct IdentityImportPreview/,
    "preview fields serialize camelCase — the TS type depends on it",
  );
  // Rust: the import fence the confirm click relies on.
  assert.match(
    rust,
    /pub async fn import_identity\(\s*nsec: String,\s*password: Option<String>,\s*expected_current_npub: Option<String>,/s,
    "import_identity must keep the expected_current_npub fence",
  );
  // Registration: an unregistered command is a runtime failure.
  assert.match(
    lib,
    /\bpreview_identity_import\b/,
    "lib.rs must register the command",
  );

  // TS wrapper: invoke names and argument keys.
  assert.match(
    api,
    /invokeTauri<IdentityImportPreview>\("preview_identity_import"/,
  );
  assert.match(api, /invokeTauri<RawIdentity>\("import_identity"/);
  assert.match(
    api,
    /expectedCurrentNpub/,
    "TS must send the camelCase fence arg",
  );

  // Card binds the production controller and copy — not a test-only helper.
  assert.match(card, /createWebIdentityHandoff\(/);
  assert.match(card, /WEB_IDENTITY_HANDOFF_COPY as COPY/);
  assert.match(card, /importIdentity\(nsec, undefined, expectedCurrentNpub\)/);
  assert.match(card, /handoff\.confirm\(\)/);
});

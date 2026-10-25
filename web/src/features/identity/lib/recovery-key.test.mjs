import assert from "node:assert/strict";
import test from "node:test";

import { nsecEncode } from "nostr-tools/nip19";
import { getPublicKey } from "nostr-tools/pure";

import {
  backedUpFor,
  parseRecoveryKey,
  recoveryExportFor,
} from "./recovery-key.ts";

const HEX = "3d".repeat(32);

test("the key this app shows, as copied or typed", () => {
  assert.equal(parseRecoveryKey(HEX), HEX);
  assert.equal(parseRecoveryKey(HEX.toUpperCase()), HEX);
  assert.equal(
    parseRecoveryKey(`  ${HEX.slice(0, 30)}\n${HEX.slice(30)} `),
    HEX,
  );
  assert.equal(parseRecoveryKey(`"${HEX}"`), HEX);
});

test("the nsec1 form other apps use", () => {
  const nsec = nsecEncode(Uint8Array.from(Buffer.from(HEX, "hex")));
  assert.equal(parseRecoveryKey(nsec), HEX);
  assert.equal(parseRecoveryKey(nsec.toUpperCase()), HEX);
});

test("anything else is not a key", () => {
  for (const input of [
    "",
    "hello",
    HEX.slice(1),
    `${HEX}00`,
    "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
    "nsec1notreally",
  ]) {
    assert.equal(parseRecoveryKey(input), null, input);
  }
});

const ACCOUNT_KEY = "4e".repeat(32);
const OTHER_KEY = "5f".repeat(32);
const account = getPublicKey(
  Uint8Array.from(ACCOUNT_KEY.match(/../g), (b) => Number.parseInt(b, 16)),
);

test("a PRF passkey account's backup is its derived key, never the browser key", () => {
  assert.deepEqual(
    recoveryExportFor(account, {
      passkey: "prf",
      passkeySecret: ACCOUNT_KEY,
      stored: OTHER_KEY,
    }),
    { kind: "ready", hex: ACCOUNT_KEY },
  );
  // Locked: nothing is offered, and the browser key (someone else's, or nobody's) is not offered instead.
  assert.deepEqual(
    recoveryExportFor(account, {
      passkey: "prf",
      passkeySecret: null,
      stored: OTHER_KEY,
    }),
    { kind: "locked" },
  );
  assert.deepEqual(
    recoveryExportFor(account, {
      passkey: "prf",
      passkeySecret: null,
      stored: null,
    }),
    { kind: "locked" },
  );
});

test("a browser-key account's backup is the stored key, only when it is this account's", () => {
  for (const passkey of [null, "unlock"]) {
    assert.deepEqual(
      recoveryExportFor(account, {
        passkey,
        passkeySecret: null,
        stored: ACCOUNT_KEY,
      }),
      { kind: "ready", hex: ACCOUNT_KEY },
    );
    assert.deepEqual(
      recoveryExportFor(account, {
        passkey,
        passkeySecret: null,
        stored: OTHER_KEY,
      }),
      { kind: "unavailable" },
    );
    assert.deepEqual(
      recoveryExportFor(account, { passkey, passkeySecret: null, stored: "" }),
      { kind: "unavailable" },
    );
  }
  assert.deepEqual(
    recoveryExportFor(null, {
      passkey: null,
      passkeySecret: null,
      stored: ACCOUNT_KEY,
    }),
    { kind: "unavailable" },
  );
});

test("backed up means this account's key was saved; the old flag counts only for a browser key", () => {
  assert.equal(backedUpFor(account, account, "prf"), true);
  assert.equal(backedUpFor(account, account, null), true);
  assert.equal(backedUpFor("ab".repeat(32), account, null), false);
  assert.equal(backedUpFor("1", account, null), true);
  assert.equal(backedUpFor("1", account, "unlock"), true);
  assert.equal(backedUpFor("1", account, "prf"), false);
  assert.equal(backedUpFor(null, account, null), false);
  assert.equal(backedUpFor(account, null, null), false);
});

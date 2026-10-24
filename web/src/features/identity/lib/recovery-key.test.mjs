import assert from "node:assert/strict";
import test from "node:test";

import { nsecEncode } from "nostr-tools/nip19";

import { parseRecoveryKey } from "./recovery-key.ts";

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

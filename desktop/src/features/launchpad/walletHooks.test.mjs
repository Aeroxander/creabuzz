/**
 * Pure-logic tests for the launchpad wallet surface: pasted private-key
 * normalization (import input) and wallet address display formatting.
 * Imports the production module so the seam under test is the shipped one.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { formatWalletAddress, parsePrivateKeyHexInput } from "./walletHooks.ts";

const KEY_64 =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const KEY_64_UPPER = KEY_64.toUpperCase();

test("private_key_input_normalizes_to_bare_lowercase_hex", () => {
  const cases = [
    [KEY_64, KEY_64],
    [KEY_64_UPPER, KEY_64],
    [`  ${KEY_64}\n`, KEY_64],
    [`0x${KEY_64}`, KEY_64],
    [`0X${KEY_64}`, KEY_64],
    [`0x${KEY_64_UPPER}`, KEY_64],
    [`  0X${KEY_64}  `, KEY_64],
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(
      parsePrivateKeyHexInput(input),
      { ok: true, privateKeyHex: expected },
      `input: ${JSON.stringify(input)}`,
    );
  }
});

test("private_key_input_rejects_with_stable_reasons", () => {
  const cases = [
    // Empty, including a bare 0x prefix and whitespace-only pastes.
    ["", "empty"],
    ["   ", "empty"],
    ["0x", "empty"],
    ["0X", "empty"],
    ["  0x  ", "empty"],
    // Wrong length (63 / 65 hex chars, with and without a prefix). Trailing
    // whitespace is trimmed first, so it cannot pad a short key to length.
    [KEY_64.slice(0, -1), "length"],
    [`${KEY_64}0`, "length"],
    [`0x${KEY_64.slice(0, -1)}`, "length"],
    [`${KEY_64.slice(0, -1)} `, "length"],
    ["0".repeat(63), "length"],
    // Right length, wrong charset: non-hex letters, inner whitespace, and a
    // doubled prefix must not slip through as 64 characters.
    [`${"0".repeat(63)}g`, "charset"],
    [`${"0".repeat(63)}i`, "charset"],
    [`${"0".repeat(63)}o`, "charset"],
    [`${"0".repeat(32)} ${"0".repeat(31)}`, "charset"],
    [`${KEY_64.slice(0, -1)}\n`, "length"],
    [`0x0x${KEY_64}`, "length"],
  ];
  for (const [input, reason] of cases) {
    assert.deepEqual(
      parsePrivateKeyHexInput(input),
      { ok: false, reason },
      `input: ${JSON.stringify(input)}`,
    );
  }
});

test("wallet_address_display_uses_canonical_truncation_or_placeholder", () => {
  // Absent address → em dash placeholder.
  assert.equal(formatWalletAddress(null), "—");
  assert.equal(formatWalletAddress(undefined), "—");
  assert.equal(formatWalletAddress(""), "—");
  assert.equal(formatWalletAddress("   "), "—");
  // Canonical truncatePubkey passthrough at the 12-char boundary.
  assert.equal(formatWalletAddress("0xabc"), "0xabc");
  assert.equal(formatWalletAddress("0x1234567890"), "0x1234567890");
  // Just past the boundary, the canonical 8-head … 4-tail form applies.
  assert.equal(formatWalletAddress("0x12345678901"), "0x123456…8901");
  // Full EVM address, whitespace trimmed before truncation.
  const ADDRESS = "0x1234567890123456789012345678901234567890";
  assert.equal(formatWalletAddress(ADDRESS), "0x123456…7890");
  assert.equal(formatWalletAddress(`  ${ADDRESS}\n`), "0x123456…7890");
  // EIP-55 checksum casing is preserved.
  const CHECKSUMMED = "0x52908400098527886E0F7030069857D2E4169EE7";
  assert.equal(formatWalletAddress(CHECKSUMMED), "0x529084…9EE7");
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildSiweLogin,
  buildSiweMessage,
  parseWalletBinding,
  revokeProofTemplate,
  siweDomain,
} from "./siwe-login.ts";

const STORED_IDENTITY_PUBKEY =
  "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
const PASSKEY_SIGNER_PUBKEY =
  "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222";

function deps(overrides = {}) {
  return {
    address: "0x1234567890abcdef1234567890abcdef12345678",
    origin: "http://localhost:5173",
    hostname: "localhost",
    signProof: async () => ({ pubkey: PASSKEY_SIGNER_PUBKEY }),
    personalSign: async () => `0x${"ab".repeat(65)}`,
    ...overrides,
  };
}

test("the message names the pubkey that signed the proof", async () => {
  const login = await buildSiweLogin({ nonce: "nonce-1" }, deps());

  // Regression: resolving the npub from storage instead of from the proof
  // produced `nostr:<stored>` while the proof carried the passkey pubkey, and
  // the relay rejected the login with "missing Resources: - nostr:<npub>".
  assert.match(
    login.message,
    new RegExp(`^- nostr:${PASSKEY_SIGNER_PUBKEY}$`, "m"),
  );
  assert.doesNotMatch(login.message, /nostr:aaaa/);
  assert.equal(login.pubkey, PASSKEY_SIGNER_PUBKEY);
  assert.equal(login.proof.pubkey, login.pubkey);
  assert.equal(login.address, deps().address);
  assert.ok(login.signature.startsWith("0x"));
  void STORED_IDENTITY_PUBKEY;
});

test("the wallet signs the exact message that is returned", async () => {
  let signed = null;
  const login = await buildSiweLogin(
    { nonce: "nonce-1" },
    deps({
      personalSign: async (message) => {
        signed = message;
        return `0x${"cd".repeat(65)}`;
      },
    }),
  );
  assert.equal(signed, login.message);
});

test("the relay's domain wins over the browser host", async () => {
  const login = await buildSiweLogin(
    { nonce: "nonce-1", domain: "myproject.com" },
    deps(),
  );
  assert.match(login.message, /^myproject\.com wants you to sign in/);
});

test("a dev host is sent without its port", async () => {
  // The relay strips the port before comparing (host_domain), so sending
  // window.location.host here failed with DomainMismatch.
  const login = await buildSiweLogin({ nonce: "nonce-1" }, deps());
  assert.match(login.message, /^localhost wants you to sign in/);
  assert.doesNotMatch(login.message, /localhost:5173 wants you/);
});

test("the chain id comes from the relay challenge", async () => {
  const login = await buildSiweLogin(
    { nonce: "nonce-1", chainId: 11155111 },
    deps(),
  );
  assert.match(login.message, /^Chain ID: 11155111$/m);
});

test("chain id falls back to mainnet when the relay omits it", async () => {
  const login = await buildSiweLogin({ nonce: "nonce-1" }, deps());
  assert.match(login.message, /^Chain ID: 1$/m);
});

test("siweDomain prefers the relay value and lowercases the fallback", () => {
  assert.equal(
    siweDomain({ nonce: "n", domain: " MyProject.com " }, "localhost"),
    "MyProject.com",
  );
  assert.equal(siweDomain({ nonce: "n" }, "LOCALHOST"), "localhost");
});

test("buildSiweMessage keeps the EIP-4361 layout", () => {
  const message = buildSiweMessage(
    {
      domain: "localhost",
      address: "0xabc",
      uri: "http://localhost:5173",
      chainId: 1,
      nonce: "nonce-1",
      npub: PASSKEY_SIGNER_PUBKEY,
    },
    new Date("2026-07-28T10:00:00Z"),
  );
  const lines = message.split("\n");
  assert.equal(
    lines[0],
    "localhost wants you to sign in with your Ethereum account:",
  );
  assert.equal(lines[1], "0xabc");
  // EIP-4361 ABNF: `address LF LF [statement LF] LF URI` — no statement means
  // two blank lines. One blank line is what the relay parser rejects.
  assert.equal(lines[2], "");
  assert.equal(lines[3], "");
  assert.equal(lines[4], "URI: http://localhost:5173");
  assert.equal(lines[5], "Version: 1");
  assert.equal(lines[6], "Chain ID: 1");
  assert.equal(lines[7], "Nonce: nonce-1");
  assert.equal(lines[8], "Issued At: 2026-07-28T10:00:00.000Z");
  assert.equal(lines[9], "Resources:");
  assert.equal(lines[10], `- nostr:${PASSKEY_SIGNER_PUBKEY}`);
  assert.equal(lines.length, 11);
});

// Cross-language golden: the relay's parser test
// (crates/buzz-evm-auth/src/siwe.rs `parses_the_web_client_golden_message`)
// reads this same file, so a change to either side that breaks the other
// fails a test on both. The fixture is the message plus one trailing newline
// (text-file convention); the message itself has none.
const GOLDEN_URL = new URL(
  "../../../../../test-fixtures/siwe/login-message.txt",
  import.meta.url,
);

function goldenMessage() {
  const raw = readFileSync(GOLDEN_URL, "utf8");
  return raw.endsWith("\n") ? raw.slice(0, -1) : raw;
}

test("the login message is byte-identical to the shared golden fixture", async () => {
  const login = await buildSiweLogin(
    { nonce: "abc123xyz789", domain: "login.example.com", chainId: 8453 },
    deps({
      address: "0x1234567890abcdef1234567890abcdef12345678",
      origin: "https://login.example.com",
      hostname: "ignored.example",
      signProof: async () => ({
        pubkey:
          "953d3363262e86b770419834c53d2446409db6d918a57f8f339d495d54ab001f",
      }),
      now: new Date("2026-07-28T10:00:00Z"),
    }),
  );
  assert.equal(login.message, goldenMessage());
});

test("the golden fixture has two blank lines and no statement", () => {
  const lines = goldenMessage().split("\n");
  assert.deepEqual(lines.slice(2, 5), [
    "",
    "",
    "URI: https://login.example.com",
  ]);
});

test("a stored wallet binding round-trips", () => {
  const binding = {
    address: `0x${"ab".repeat(20)}`,
    pubkey: "cd".repeat(32),
    boundAt: 1700000000000,
  };
  assert.deepEqual(parseWalletBinding(JSON.stringify(binding)), binding);
});

test("a malformed or hostile stored binding reads as none", () => {
  // Storage is user-writable; rendering must not throw on any of these.
  for (const raw of [
    null,
    "",
    "not json",
    "[]",
    JSON.stringify({ address: "0x123", pubkey: "cd".repeat(32) }),
    JSON.stringify({ address: `0x${"ab".repeat(20)}` }),
    JSON.stringify({ address: `0x${"ab".repeat(20)}`, pubkey: "nope" }),
    JSON.stringify({
      address: `0x${"AB".repeat(20)}`,
      pubkey: "cd".repeat(32),
    }),
  ]) {
    assert.equal(parseWalletBinding(raw), null, `expected null for ${raw}`);
  }
});

test("a binding missing its timestamp still parses", () => {
  const parsed = parseWalletBinding(
    JSON.stringify({
      address: `0x${"ab".repeat(20)}`,
      pubkey: "cd".repeat(32),
    }),
  );
  assert.equal(parsed?.boundAt, 0);
});

test("the revoke proof names the revoke endpoint and the bound address", () => {
  const address = `0x${"ab".repeat(20)}`;
  const template = revokeProofTemplate(address);
  assert.equal(template.kind, 27235);
  assert.deepEqual(template.tags[0], ["u", "/auth/siwe/revoke"]);
  assert.equal(template.content, address);
});

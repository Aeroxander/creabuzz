import assert from "node:assert/strict";
import test from "node:test";

import { buildSiweLogin, buildSiweMessage, siweDomain } from "./siwe-login.ts";

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
  const message = buildSiweMessage({
    domain: "localhost",
    address: "0xabc",
    uri: "http://localhost:5173",
    chainId: 1,
    nonce: "nonce-1",
    npub: PASSKEY_SIGNER_PUBKEY,
  });
  const lines = message.split("\n");
  assert.equal(
    lines[0],
    "localhost wants you to sign in with your Ethereum account:",
  );
  assert.equal(lines[1], "0xabc");
  assert.equal(lines[2], "");
  assert.equal(lines[3], "URI: http://localhost:5173");
  assert.equal(lines[4], "Version: 1");
  assert.equal(lines[5], "Chain ID: 1");
  assert.equal(lines[6], "Nonce: nonce-1");
  assert.ok(lines[7].startsWith("Issued At: "));
  assert.equal(lines[8], "Resources:");
  assert.equal(lines[9], `- nostr:${PASSKEY_SIGNER_PUBKEY}`);
});

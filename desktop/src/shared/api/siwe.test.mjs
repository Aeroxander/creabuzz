import assert from "node:assert/strict";
import test from "node:test";

import { buildSiweMessage } from "@/shared/api/siwe.ts";

test("buildSiweMessage produces a canonical EIP-4361 message", () => {
  const message = buildSiweMessage({
    domain: "relay.example",
    address: "0x1234abcd",
    chainId: 11155111,
    nonce: "deadbeefdeadbeef",
    npubHex: "aa11bb22",
    uri: "http://relay.example",
  });
  const lines = message.split("\n");
  assert.equal(
    lines[0],
    "relay.example wants you to sign in with your Ethereum account:",
  );
  assert.equal(lines[1], "0x1234abcd");
  assert.ok(lines.includes("URI: http://relay.example"));
  assert.ok(lines.includes("Version: 1"));
  assert.ok(lines.includes("Chain ID: 11155111"));
  assert.ok(lines.includes("Nonce: deadbeefdeadbeef"));
  assert.ok(lines.includes("Resources:"));
  assert.ok(lines.includes("- nostr:aa11bb22"));
});

test("buildSiweMessage includes the statement when provided", () => {
  const message = buildSiweMessage({
    domain: "relay.example",
    address: "0x1234abcd",
    chainId: 1,
    nonce: "nonce1234",
    npubHex: "aa11bb22",
    statement: "I accept the Terms of Service.",
    uri: "http://relay.example",
  });
  assert.ok(message.includes("I accept the Terms of Service."));
});

test("buildSiweMessage orders fields per EIP-4361", () => {
  const message = buildSiweMessage({
    domain: "relay.example",
    address: "0x1234abcd",
    chainId: 1,
    nonce: "nonce1234",
    npubHex: "aa11bb22",
    uri: "http://relay.example",
  });
  const uriIndex = message.indexOf("URI:");
  const versionIndex = message.indexOf("Version:");
  const chainIndex = message.indexOf("Chain ID:");
  const nonceIndex = message.indexOf("Nonce:");
  const issuedIndex = message.indexOf("Issued At:");
  const resourcesIndex = message.indexOf("Resources:");
  assert.ok(uriIndex < versionIndex, "URI before Version");
  assert.ok(versionIndex < chainIndex, "Version before Chain ID");
  assert.ok(chainIndex < nonceIndex, "Chain ID before Nonce");
  assert.ok(nonceIndex < issuedIndex, "Nonce before Issued At");
  assert.ok(issuedIndex < resourcesIndex, "Issued At before Resources");
  assert.ok(
    resourcesIndex < message.indexOf("- nostr:"),
    "Resources before binding",
  );
});

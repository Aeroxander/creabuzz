/**
 * Security tests for the browser→desktop account handoff (web side), bound
 * to the production `link-device-flow` + `@creaton/core/link-device` seam with
 * real NIP-44 in both directions. Each test is falsifiable: it asserts the
 * exact refusal or the exact payload shape the protocol promises.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { decrypt, getConversationKey } from "nostr-tools/nip44";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

import {
  checkLinkDevicePayload,
  decodeBase64Url,
  parseLinkDevicePayload,
  parseLinkDeviceRequest,
} from "@creaton/core/link-device.ts";

import { buildLinkDeviceRedirect } from "./link-device-flow.ts";

const NONCE = "handoff-nonce-42";
const ACCOUNT = "11".repeat(32);

function hexBytes(hex) {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** What the desktop does with the redirect: decrypt with its one-time key. */
function desktopSide(oneTime, url) {
  const params = new URL(url).searchParams;
  const p = params.get("p");
  const from = params.get("from");
  assert.ok(p, "redirect carries a p parameter");
  assert.ok(from, "redirect carries a from parameter");
  // Exactly what the Rust side does: the conversation key comes from the
  // desktop's one-time secret and the `from` sender pubkey.
  const key = getConversationKey(oneTime, from);
  return parseLinkDevicePayload(decrypt(decodeBase64Url(p), key));
}

function request(pub, cb = "creaton://identity") {
  return { pub, nonce: NONCE, cb };
}

test("a confirmed handoff decrypts for the desktop with the right nonce", () => {
  const oneTime = generateSecretKey();
  const now = Date.now();
  const { url, npub } = buildLinkDeviceRedirect({
    request: request(getPublicKey(oneTime)),
    secretKeyHex: ACCOUNT,
    nowMs: now,
  });
  assert.ok(url.startsWith("creaton://identity?p="));
  assert.ok(!url.includes(ACCOUNT), "the secret key never appears in the URL");
  assert.equal(
    new URL(url).searchParams.get("from"),
    getPublicKey(hexBytes(ACCOUNT)),
    "from is the account pubkey (the NIP-44 sender)",
  );

  const parsed = desktopSide(oneTime, url);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.sk, ACCOUNT);
  assert.equal(parsed.value.nonce, NONCE);
  const checked = checkLinkDevicePayload(parsed.value, {
    expectedNonce: NONCE,
    nowMs: now,
  });
  assert.equal(checked.ok, true);
  assert.ok(npub.startsWith("npub1"), "returns the linked npub");
});

test("a payload bound to a different nonce is detectable", () => {
  const oneTime = generateSecretKey();
  const { url } = buildLinkDeviceRedirect({
    request: request(getPublicKey(oneTime)),
    secretKeyHex: ACCOUNT,
    nowMs: Date.now(),
  });
  const parsed = desktopSide(oneTime, url);
  assert.equal(parsed.ok, true);
  const checked = checkLinkDevicePayload(parsed.value, {
    expectedNonce: "some-other-nonce",
    nowMs: Date.now(),
  });
  assert.equal(checked.ok, false);
  assert.equal(checked.error, "nonce-mismatch");
});

test("an expired payload is detectable", () => {
  const oneTime = generateSecretKey();
  const { url } = buildLinkDeviceRedirect({
    request: request(getPublicKey(oneTime)),
    secretKeyHex: ACCOUNT,
    nowMs: Date.now() - 10 * 60 * 1000,
  });
  const parsed = desktopSide(oneTime, url);
  assert.equal(parsed.ok, true);
  const checked = checkLinkDevicePayload(parsed.value, {
    expectedNonce: NONCE,
    nowMs: Date.now(),
  });
  assert.equal(checked.ok, false);
  assert.equal(checked.error, "expired");
});

test("a malformed or foreign callback is refused with no redirect", () => {
  for (const cb of [
    "https://evil.example/steal",
    "http://evil.example",
    "javascript:alert(1)",
    "data:text/plain,x",
  ]) {
    const search = `?pub=${"ab".repeat(32)}&nonce=${NONCE}&cb=${encodeURIComponent(cb)}`;
    const parsed = parseLinkDeviceRequest(search);
    assert.equal(parsed.ok, false, `refuses ${cb}`);
    assert.equal(parsed.error, "bad-callback");
    // Even a forged request object cannot produce a URL: the builder throws.
    assert.throws(
      () =>
        buildLinkDeviceRedirect({
          request: request("ab".repeat(32), cb),
          secretKeyHex: ACCOUNT,
        }),
      /creaton/,
    );
  }
});

test("the decrypted payload carries exactly the four documented fields", () => {
  const oneTime = generateSecretKey();
  const { url } = buildLinkDeviceRedirect({
    request: request(getPublicKey(oneTime)),
    secretKeyHex: ACCOUNT,
    nowMs: Date.now(),
  });
  const p = new URL(url).searchParams.get("p");
  const from = new URL(url).searchParams.get("from");
  const key = getConversationKey(
    oneTime,
    from ?? getPublicKey(hexBytes(ACCOUNT)),
  );
  const raw = JSON.parse(decrypt(decodeBase64Url(p ?? ""), key));
  assert.deepEqual(Object.keys(raw), ["v", "sk", "nonce", "exp"]);
  assert.equal(Object.keys(raw).length, 4);
});

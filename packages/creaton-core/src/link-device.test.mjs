// Security tests for the link-device handoff payload — bound to the
// production module, one test per refusal the protocol depends on.
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLinkDeviceCallback,
  buildLinkDevicePayload,
  checkLinkDevicePayload,
  decodeBase64Url,
  encodeBase64Url,
  parseLinkDeviceCallback,
  parseLinkDevicePayload,
  parseLinkDeviceRequest,
  serializeLinkDevicePayload,
} from "./link-device.ts";

const SK = "ab".repeat(32);
const OTHER_SK = "cd".repeat(32);
const NONCE = "nonce-12345678";

test("the payload contains exactly the four documented fields", () => {
  const payload = buildLinkDevicePayload({ secretKeyHex: SK, nonce: NONCE });
  const json = serializeLinkDevicePayload(payload);
  const parsed = JSON.parse(json);
  assert.deepEqual(Object.keys(parsed), ["v", "sk", "nonce", "exp"]);
  assert.equal(Object.keys(parsed).length, 4);
  assert.equal(parsed.v, 1);
  assert.equal(parsed.sk, SK);
  assert.equal(parsed.nonce, NONCE);
  assert.equal(typeof parsed.exp, "number");
});

test("serialize/parse round-trips and parse refuses extra or missing fields", () => {
  const payload = buildLinkDevicePayload({ secretKeyHex: SK, nonce: NONCE });
  const roundtrip = parseLinkDevicePayload(serializeLinkDevicePayload(payload));
  assert.equal(roundtrip.ok, true);
  assert.deepEqual(roundtrip.value, payload);

  const extra = JSON.parse(serializeLinkDevicePayload(payload));
  extra.stolen = "field";
  assert.equal(parseLinkDevicePayload(JSON.stringify(extra)).ok, false);

  const missing = JSON.parse(serializeLinkDevicePayload(payload));
  delete missing.nonce;
  assert.equal(parseLinkDevicePayload(JSON.stringify(missing)).ok, false);

  assert.equal(parseLinkDevicePayload("not json").ok, false);
});

test("a payload bound to a different nonce is refused", () => {
  const payload = buildLinkDevicePayload({ secretKeyHex: SK, nonce: NONCE });
  const wrong = checkLinkDevicePayload(payload, {
    expectedNonce: "other-nonce-99",
  });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error, "nonce-mismatch");
  const right = checkLinkDevicePayload(payload, { expectedNonce: NONCE });
  assert.equal(right.ok, true);
});

test("a payload past its five-minute lifetime is refused", () => {
  const now = Date.now();
  const payload = buildLinkDevicePayload({
    secretKeyHex: SK,
    nonce: NONCE,
    nowMs: now - 10 * 60 * 1000,
  });
  const result = checkLinkDevicePayload(payload, {
    expectedNonce: NONCE,
    nowMs: now,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "expired");
});

test("foreign and malformed links are refused before any redirect", () => {
  const pub = OTHER_SK;
  for (const cb of [
    "https://evil.example/steal",
    "http://evil.example",
    "javascript:alert(1)",
    "data:text/plain,x",
    "//evil.example",
    "creaton:evil",
  ]) {
    const search = `?pub=${pub}&nonce=${NONCE}&cb=${encodeURIComponent(cb)}`;
    const parsed = parseLinkDeviceRequest(search);
    assert.equal(parsed.ok, false, `must refuse cb=${cb}`);
    assert.equal(parsed.error, "bad-callback");
    assert.throws(() => buildLinkDeviceCallback(cb, "cipher", OTHER_SK));
  }
  assert.equal(
    parseLinkDeviceRequest(`?nonce=${NONCE}&cb=creaton://identity`).error,
    "missing-param",
  );
  assert.equal(
    parseLinkDeviceRequest(`?pub=zz&nonce=${NONCE}&cb=creaton://identity`)
      .error,
    "bad-pubkey",
  );
  assert.equal(
    parseLinkDeviceRequest(`?pub=${pub}&nonce=short&cb=creaton://identity`)
      .error,
    "bad-nonce",
  );
});

test("an allowed callback carries the ciphertext in p and the sender in from", () => {
  const url = buildLinkDeviceCallback(
    "creaton://identity",
    "cipher +/ text",
    OTHER_SK.toUpperCase(),
  );
  const p = new URL(url).searchParams.get("p");
  assert.equal(decodeBase64Url(p ?? ""), "cipher +/ text");
  assert.equal(url.includes("+"), false);
  assert.throws(() =>
    buildLinkDeviceCallback("creaton://identity", "", OTHER_SK),
  );
  // A `from` that is not a 64-hex pubkey is refused at build time.
  assert.throws(() =>
    buildLinkDeviceCallback("creaton://identity", "cipher", "zz"),
  );
  assert.equal(decodeBase64Url(encodeBase64Url("héllo ✓")), "héllo ✓");

  // The redirect parses back to exactly what was put in — `from` is
  // normalized to lowercase (case-insensitive hex, strict compare later).
  const parsedCallback = parseLinkDeviceCallback(new URL(url).search);
  assert.equal(parsedCallback.ok, true);
  assert.equal(parsedCallback.value.from, OTHER_SK);
  assert.ok(parsedCallback.value.p.length > 0);
});

test("a redirect missing p or from — or carrying a foreign from — is refused", () => {
  assert.equal(
    parseLinkDeviceCallback(`?from=${OTHER_SK}`).error,
    "missing-param",
  );
  assert.equal(parseLinkDeviceCallback("?p=AAAA").error, "missing-param");
  assert.equal(parseLinkDeviceCallback("?p=AAAA&from=zz").error, "bad-pubkey");
  const request = parseLinkDeviceRequest(
    `?pub=${OTHER_SK}&nonce=${NONCE}&cb=${encodeURIComponent("creaton://identity")}`,
  );
  assert.equal(request.ok, true);
  assert.equal(request.value.cb, "creaton://identity");
});

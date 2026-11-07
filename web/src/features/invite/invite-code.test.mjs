import assert from "node:assert/strict";
import test from "node:test";

import { inviteCodeProblem } from "./invite-code.ts";

const b64url = (value) =>
  Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const V2 = `v2.${b64url(Buffer.alloc(32, 7))}`;
const NOW = 1_800_000_000;

function v1(expires) {
  const payload = JSON.stringify({
    c: "0f9c",
    r: "member",
    e: expires,
    n: "x",
  });
  return `${b64url(payload)}.${b64url(Buffer.alloc(32, 1))}`;
}

test("a code the server could have made is left to the server", () => {
  assert.equal(inviteCodeProblem(V2, NOW), null);
  assert.equal(inviteCodeProblem(v1(NOW + 60), NOW), null);
});

test("anything that is not a code's shape is broken on its face", () => {
  for (const code of [
    "",
    "not-a-real-code",
    "demo",
    "v2.",
    "v2.abc",
    `${V2}A`,
    `${V2.slice(0, -1)}B`, // stray bits in the last character: not the canonical form
    `${V2}=`,
    "a.b.c",
    `${b64url("not json")}.${b64url("mac")}`,
    `${b64url(JSON.stringify({ c: 1, e: "soon" }))}.${b64url("mac")}`,
    "x".repeat(2000),
  ]) {
    assert.equal(inviteCodeProblem(code, NOW), "malformed", code.slice(0, 40));
  }
});

test("an older code past its date has expired", () => {
  assert.equal(inviteCodeProblem(v1(NOW - 1), NOW), "expired");
});

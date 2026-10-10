import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { nip19 } from "nostr-tools";

import { canAddMembers, parseMembers, parsePersonInput } from "./members.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);

describe("parseMembers", () => {
  it("reads each member and role the server wrote", () => {
    assert.deepEqual(
      parseMembers([
        ["d", "x"],
        ["p", A, "", "owner"],
        ["p", B, "", "member"],
      ]),
      [
        { pubkey: A, role: "owner" },
        { pubkey: B, role: "member" },
      ],
    );
  });
  it("defaults a missing role to member, skips repeats and anything that is not a key", () => {
    assert.deepEqual(
      parseMembers([["p", A], ["p", A, "", "admin"], ["p", "nope"], ["p"]]),
      [{ pubkey: A, role: "member" }],
    );
  });
});

describe("canAddMembers", () => {
  const members = [
    { pubkey: A, role: "owner" },
    { pubkey: B, role: "member" },
  ];
  it("lets owners and admins add people, and nobody else", () => {
    assert.equal(canAddMembers(members, A), true);
    assert.equal(canAddMembers([{ pubkey: B, role: "admin" }], B), true);
    assert.equal(canAddMembers(members, B), false);
    assert.equal(canAddMembers(members, "c".repeat(64)), false);
    assert.equal(canAddMembers(members, null), false);
  });
});

describe("parsePersonInput", () => {
  it("accepts a hex key in any case and an npub, with spaces around it", () => {
    assert.equal(parsePersonInput(` ${A.toUpperCase()} `), A);
    assert.equal(parsePersonInput(nip19.npubEncode(B)), B);
  });
  it("refuses everything else, including other kinds of address", () => {
    for (const bad of [
      "",
      "hello",
      A.slice(1),
      `${A}0`,
      "npub1notvalid",
      nip19.nsecEncode(Uint8Array.from({ length: 32 }, () => 7)),
    ]) {
      assert.equal(parsePersonInput(bad), null, bad);
    }
  });
});

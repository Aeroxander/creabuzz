import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { nip19 } from "nostr-tools";

import {
  boardRemovers,
  canAddMembers,
  parseMembers,
  parsePersonInput,
  canRemoveMember,
} from "./members.ts";

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

describe("boardRemovers", () => {
  it("is the owners and admins, and nobody else", () => {
    const removers = boardRemovers([
      { pubkey: A, role: "owner" },
      { pubkey: B, role: "admin" },
      { pubkey: "c".repeat(64), role: "member" },
      { pubkey: "d".repeat(64), role: "bot" },
    ]);
    assert.deepEqual([...removers].sort(), [A, B].sort());
    assert.equal(boardRemovers([]).size, 0);
  });
});

describe("joinedBoards", () => {
  const ME = "a".repeat(64);
  const OTHER = "b".repeat(64);
  const record = (d, at, people) => ({
    created_at: at,
    tags: [["d", d], ...people.map(([pk, role]) => ["p", pk, "", role])],
  });

  it("lists each board the person is on, with their role", async () => {
    const { joinedBoards } = await import("./members.ts");
    const joined = joinedBoards(
      [
        record("film", 10, [[ME, "owner"]]),
        record("music", 10, [
          [OTHER, "owner"],
          [ME, "member"],
        ]),
        record("art", 10, [[OTHER, "owner"]]),
      ],
      ME,
    );
    assert.deepEqual(
      [...joined],
      [
        ["film", "owner"],
        ["music", "member"],
      ],
    );
  });

  it("goes by the newest record, so leaving is honoured", async () => {
    const { joinedBoards } = await import("./members.ts");
    const joined = joinedBoards(
      [
        record("music", 10, [[ME, "member"]]),
        record("music", 20, [[OTHER, "owner"]]),
      ],
      ME,
    );
    assert.equal(joined.size, 0);
  });
});

describe("canRemoveMember", () => {
  it("lets owners remove anyone else, admins only those below admin, others nobody", () => {
    const members = [
      { pubkey: "o", role: "owner" },
      { pubkey: "a", role: "admin" },
      { pubkey: "b", role: "admin" },
      { pubkey: "m", role: "member" },
    ];
    assert.equal(canRemoveMember(members, "o", "a"), true);
    assert.equal(canRemoveMember(members, "o", "m"), true);
    assert.equal(canRemoveMember(members, "a", "m"), true);
    assert.equal(canRemoveMember(members, "a", "o"), false);
    assert.equal(canRemoveMember(members, "a", "b"), false);
    assert.equal(canRemoveMember(members, "m", "a"), false);
    assert.equal(
      canRemoveMember(members, "o", "o"),
      false,
      "leaving is not removing",
    );
    assert.equal(canRemoveMember(members, null, "m"), false);
  });
});

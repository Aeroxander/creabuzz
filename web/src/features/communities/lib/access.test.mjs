import assert from "node:assert/strict";
import { test } from "node:test";

import {
  accessSummary,
  describeInvite,
  inviteRequestBody,
  KIND_MEMBER_LIST,
  KIND_SET_ACCESS,
  looksLikeNotAMember,
  mayChangeAccess,
  mayInvite,
  parseAccess,
  parseMintedInvite,
  peopleFromEvents,
  roleOf,
  setAccessRecord,
} from "./access.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

test("only the two words the server uses are understood; anything else is no answer", () => {
  assert.equal(parseAccess("open"), "open");
  assert.equal(parseAccess("invite_only"), "invite_only");
  for (const other of [undefined, null, "", "closed", "INVITE_ONLY", 1, {}]) {
    assert.equal(parseAccess(other), null);
  }
});

test("the record that changes who may join says exactly one of the two words", () => {
  assert.deepEqual(setAccessRecord("invite_only"), {
    kind: KIND_SET_ACCESS,
    content: "",
    tags: [["access", "invite_only"]],
  });
  assert.deepEqual(setAccessRecord("open").tags, [["access", "open"]]);
  assert.equal(KIND_SET_ACCESS, 9034);
});

test("the settings are described in plain words", () => {
  assert.match(accessSummary("invite_only"), /invite link/);
  assert.match(accessSummary("open"), /address/);
});

test("the people are read from the newest list, owner first, then admins, then the rest in the server's order", () => {
  const older = {
    kind: KIND_MEMBER_LIST,
    created_at: 10,
    tags: [["member", A, "owner"]],
  };
  const newer = {
    kind: KIND_MEMBER_LIST,
    created_at: 20,
    tags: [
      ["member", C, "member"],
      ["member", B, "admin"],
      ["member", A, "owner"],
      ["p", "d".repeat(64), "", "member"],
    ],
  };
  const unrelated = { kind: 1, created_at: 99, tags: [["member", C, "owner"]] };
  const people = peopleFromEvents([older, unrelated, newer]);
  assert.deepEqual(
    people.map((p) => [p.pubkey.slice(0, 1), p.role]),
    [
      ["a", "owner"],
      ["b", "admin"],
      ["c", "member"],
      ["d", "member"],
    ],
  );
});

test("a list with nothing usable in it, or no list, gives nobody rather than a guess", () => {
  assert.deepEqual(peopleFromEvents([]), []);
  assert.deepEqual(
    peopleFromEvents([
      {
        kind: KIND_MEMBER_LIST,
        created_at: 1,
        tags: [
          ["member", "not-a-key", "owner"],
          ["member", A.toUpperCase().slice(0, 10), "owner"],
          ["other", A, "owner"],
        ],
      },
    ]),
    [],
  );
});

test("a person listed twice appears once, as their first entry says", () => {
  const people = peopleFromEvents([
    {
      kind: KIND_MEMBER_LIST,
      created_at: 1,
      tags: [
        ["member", A, "member"],
        ["member", A, "owner"],
      ],
    },
  ]);
  assert.deepEqual(people, [{ pubkey: A, role: "member" }]);
});

test("roles gate what is offered: owners and admins invite, only the owner changes who may join", () => {
  const people = peopleFromEvents([
    {
      kind: KIND_MEMBER_LIST,
      created_at: 1,
      tags: [
        ["member", A, "owner"],
        ["member", B, "admin"],
        ["member", C, "member"],
      ],
    },
  ]);
  assert.equal(roleOf(people, A), "owner");
  assert.equal(roleOf(people, A.toUpperCase()), "owner");
  assert.equal(roleOf(people, "e".repeat(64)), null);
  assert.equal(roleOf(people, null), null);

  assert.equal(mayInvite("owner"), true);
  assert.equal(mayInvite("admin"), true);
  assert.equal(mayInvite("member"), false);
  assert.equal(mayInvite(null), false);

  assert.equal(mayChangeAccess("owner"), true);
  assert.equal(mayChangeAccess("admin"), false);
  assert.equal(mayChangeAccess("member"), false);
  assert.equal(mayChangeAccess(null), false);
});

test("an invite request names its lifetime, and its limit only when there is one", () => {
  assert.deepEqual(inviteRequestBody(86_400, 1), {
    ttl_secs: 86_400,
    max_uses: 1,
  });
  assert.deepEqual(inviteRequestBody(604_800, null), { ttl_secs: 604_800 });
});

test("the server's answer to a new invite is read, and anything short of it is refused", () => {
  assert.deepEqual(
    parseMintedInvite({
      url: "http://acme.test/invite/v2.x",
      expires_at: 100,
      max_uses: 5,
    }),
    { url: "http://acme.test/invite/v2.x", expiresAt: 100, maxUses: 5 },
  );
  assert.equal(
    parseMintedInvite({ url: "http://a.test/i", expires_at: 1, max_uses: null })
      ?.maxUses,
    null,
  );
  for (const bad of [
    null,
    "x",
    {},
    { url: "", expires_at: 1 },
    { url: "http://a.test/i" },
    { url: 5, expires_at: 1 },
  ]) {
    assert.equal(parseMintedInvite(bad), null);
  }
});

test("a new invite is described by how long it works and for how many", () => {
  const now = 1_000_000;
  const day = 86_400;
  assert.equal(
    describeInvite({ url: "u", expiresAt: now + 7 * day, maxUses: null }, now),
    "Works for 7 days, for anyone who has it.",
  );
  assert.equal(
    describeInvite({ url: "u", expiresAt: now + day, maxUses: 1 }, now),
    "Works for 1 day, for one person.",
  );
  assert.equal(
    describeInvite({ url: "u", expiresAt: now + 5 * 3600, maxUses: 10 }, now),
    "Works for 5 hours, for up to 10 people.",
  );
  assert.equal(
    describeInvite({ url: "u", expiresAt: now + 600, maxUses: 2 }, now),
    "Works for less than 2 hours, for up to 2 people.",
  );
});

test("a refused sign-in is told from a broken connection by what the server said", () => {
  assert.equal(looksLikeNotAMember("restricted: not a relay member"), true);
  assert.equal(looksLikeNotAMember("relay_membership_required"), true);
  assert.equal(looksLikeNotAMember("timed out"), false);
  assert.equal(looksLikeNotAMember("server responded 500"), false);
});

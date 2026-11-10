import assert from "node:assert/strict";
import { test } from "node:test";

import {
  actsForProject,
  isTeamAnswerTags,
  MAX_TEAM_MEMBERS,
  memberState,
  parseFormerTeam,
  parseTeam,
  parseTeamAnswer,
  TEAM_LABEL,
  teamAnswerEvent,
  teamTags,
  teamView,
  withMember,
  withoutMember,
} from "./team.ts";

const FOUNDER = "f".repeat(64);
const ANN = "a".repeat(64);
const BO = "b".repeat(64);
const COORD = `37001:${FOUNDER}:nebula`;

const record = (team = [], formerTeam = []) => ({
  author: FOUNDER,
  coordinate: COORD,
  team,
  formerTeam,
});
let n = 0;
const answer = (author, word, invite, coordinate = COORD) => {
  n += 1;
  const { tags } = teamAnswerEvent({ answer: word, invite });
  return parseTeamAnswer({
    id: `id${n}`,
    pubkey: author,
    kind: 47003,
    created_at: 1_000 + n,
    tags: [["a", coordinate], ...tags],
  });
};

test("team tags round-trip, with a p tag per person and the date someone left", () => {
  const team = [{ pubkey: ANN, role: "member", invite: "inv1" }];
  const former = [{ pubkey: BO, until: 1_700_000_000 }];
  const tags = teamTags(team, former);
  assert.deepEqual(tags, [
    ["team", ANN, "member", "inv1"],
    ["p", ANN],
    ["team-left", BO, "1700000000"],
  ]);
  assert.deepEqual(parseTeam(tags, FOUNDER), team);
  assert.deepEqual(parseFormerTeam(tags), former);
});

test("a team tag is read as the server reads it: three parts are enough, the founder and repeats are left out", () => {
  const tags = [
    ["team", ANN, "member"],
    ["team", ANN, "lead", "later"],
    ["team", FOUNDER, "member"],
    ["team", "not-a-key", "member"],
    ["team", BO],
  ];
  assert.deepEqual(parseTeam(tags, FOUNDER), [
    { pubkey: ANN, role: "member", invite: "" },
  ]);
});

test("adding someone already on the team sends nothing, so a retry after a lost answer invites nobody twice", () => {
  const first = withMember(record(), ANN, "inv1");
  assert.deepEqual(first.team, [
    { pubkey: ANN, role: "member", invite: "inv1" },
  ]);
  assert.equal(withMember(record(first.team), ANN, "inv2"), null);
});

test("the founder cannot add themselves, a non-account, or a twentieth person", () => {
  assert.throws(() => withMember(record(), FOUNDER, "i"), /founder/);
  assert.throws(() => withMember(record(), "npub1xyz", "i"), /not an account/);
  const full = Array.from({ length: MAX_TEAM_MEMBERS }, (_, i) => ({
    pubkey: i.toString(16).padStart(64, "0"),
    role: "member",
    invite: "x",
  }));
  assert.throws(() => withMember(record(full), ANN, "i"), /Remove someone/);
});

test("removing someone writes down that they left and when; removing someone not there sends nothing", () => {
  const team = [{ pubkey: ANN, role: "member", invite: "inv1" }];
  const change = withoutMember(record(team), ANN, 1_800_000_000);
  assert.deepEqual(change.team, []);
  assert.deepEqual(change.formerTeam, [{ pubkey: ANN, until: 1_800_000_000 }]);
  assert.equal(withoutMember(record(), ANN, 1), null);
});

test("adding someone back takes them off the list of people who left, and asks them again", () => {
  const change = withMember(
    record([], [{ pubkey: ANN, until: 5 }]),
    ANN,
    "inv2",
  );
  assert.deepEqual(change.formerTeam, []);
  const member = change.team[0];
  // Their yes to the earlier invitation does not carry over.
  assert.equal(
    memberState(member, COORD, [answer(ANN, "yes", "inv1")]),
    "invited",
  );
  assert.equal(
    memberState(member, COORD, [answer(ANN, "yes", "inv2")]),
    "accepted",
  );
});

test("only the person's own answer to this invitation on this project counts", () => {
  const member = { pubkey: ANN, role: "member", invite: "inv1" };
  assert.equal(memberState(member, COORD, []), "invited");
  // Someone else's yes, a yes for another project, a yes for another invitation: none is theirs to this.
  const strangers = [
    answer(BO, "yes", "inv1"),
    answer(FOUNDER, "yes", "inv1"),
    answer(ANN, "yes", "inv1", `37001:${FOUNDER}:other`),
    answer(ANN, "yes", "old"),
  ];
  assert.equal(memberState(member, COORD, strangers), "invited");
  assert.equal(
    memberState(member, COORD, [...strangers, answer(ANN, "yes", "inv1")]),
    "accepted",
  );
});

test("a no is final for its invitation, whichever was signed first", () => {
  const member = { pubkey: ANN, role: "member", invite: "inv1" };
  const yes = answer(ANN, "yes", "inv1");
  const no = answer(ANN, "no", "inv1");
  assert.equal(memberState(member, COORD, [yes, no]), "declined");
  assert.equal(memberState(member, COORD, [no, yes]), "declined");
});

test("the view shows who said yes, who has not, and who left; a stranger's yes makes nobody a former member", () => {
  const team = [
    { pubkey: ANN, role: "member", invite: "i1" },
    { pubkey: BO, role: "member", invite: "i2" },
  ];
  const gone = "c".repeat(64);
  const stranger = "d".repeat(64);
  const view = teamView(record(team, [{ pubkey: gone, until: 9 }]), [
    answer(ANN, "yes", "i1"),
    answer(stranger, "yes", "i1"),
  ]);
  assert.deepEqual(
    view.members.map((m) => [m.pubkey, m.state]),
    [
      [ANN, "accepted"],
      [BO, "invited"],
    ],
  );
  assert.deepEqual(view.former, [{ pubkey: gone, until: 9 }]);
  assert.equal(actsForProject(view, FOUNDER, FOUNDER), true);
  assert.equal(actsForProject(view, FOUNDER, ANN), true);
  assert.equal(actsForProject(view, FOUNDER, BO), false);
  assert.equal(actsForProject(view, FOUNDER, stranger), false);
  assert.equal(actsForProject(view, FOUNDER, null), false);
});

test("an answer carries the label it is read by and is never mistaken for an update", () => {
  const { tags, content } = teamAnswerEvent({ answer: "yes", invite: "i1" });
  assert.ok(tags.some((t) => t[0] === "l" && t[1] === TEAM_LABEL));
  assert.equal(isTeamAnswerTags(tags), true);
  assert.equal(isTeamAnswerTags([["update-kind", "weekly"]]), false);
  assert.equal(content.title, "Joined the team");
  // Not an answer: another kind, no project, or a word that is neither yes nor no.
  const base = { id: "x", pubkey: ANN, created_at: 1 };
  assert.equal(
    parseTeamAnswer({ ...base, kind: 1, tags: [["a", COORD], ...tags] }),
    null,
  );
  assert.equal(parseTeamAnswer({ ...base, kind: 47003, tags }), null);
  assert.equal(
    parseTeamAnswer({
      ...base,
      kind: 47003,
      tags: [
        ["a", COORD],
        ["team-answer", "maybe"],
      ],
    }),
    null,
  );
});

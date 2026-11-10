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
  projectVoices,
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

test("team tags round-trip, with a p tag per person and the date and invitation of someone who left", () => {
  const team = [{ pubkey: ANN, role: "member", invite: "inv1" }];
  const former = [{ pubkey: BO, until: 1_700_000_000, invite: "old1" }];
  const tags = teamTags(team, former);
  assert.deepEqual(tags, [
    // Exactly three parts: the server refuses a team tag of any other shape.
    ["team", ANN, "member"],
    ["team-invite", ANN, "inv1"],
    ["p", ANN],
    ["team-left", BO, "1700000000", "old1"],
  ]);
  assert.deepEqual(parseTeam(tags, FOUNDER), team);
  assert.deepEqual(parseFormerTeam(tags), former);
});

test("a team tag is read as the server reads it: three parts are enough, the founder and repeats are left out", () => {
  const tags = [
    ["team", ANN, "member"],
    ["team", ANN, "lead"],
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

test("removing someone who said yes writes down that they left and when; removing someone not there sends nothing", () => {
  const team = [{ pubkey: ANN, role: "member", invite: "inv1" }];
  const change = withoutMember(record(team), ANN, 1_800_000_000, true);
  assert.deepEqual(change.team, []);
  assert.deepEqual(change.formerTeam, [
    { pubkey: ANN, until: 1_800_000_000, invite: "inv1" },
  ]);
  assert.equal(withoutMember(record(), ANN, 1, true), null);
});

test("removing someone who never said yes leaves no trace: the record must not say they were on the team", () => {
  const team = [{ pubkey: ANN, role: "member", invite: "inv1" }];
  const change = withoutMember(record(team), ANN, 1_800_000_000, false);
  assert.deepEqual(change.team, []);
  assert.deepEqual(change.formerTeam, []);
  assert.equal(
    teamTags(change.team, change.formerTeam).some((t) => t[0] === "team-left"),
    false,
  );
});

test("a team-left tag alone proves nothing: 'was on the team' needs the person's own yes to that invitation", () => {
  // A founder writes that a well-known account left, having added and removed it. The person signed nothing.
  const forged = record([], [{ pubkey: ANN, until: 9, invite: "inv1" }]);
  assert.deepEqual(teamView(forged, []).former, []);
  // Their yes to another invitation, or someone else's yes, does not bear it out either.
  assert.deepEqual(
    teamView(forged, [answer(ANN, "yes", "other"), answer(BO, "yes", "inv1")])
      .former,
    [],
  );
  assert.deepEqual(teamView(forged, [answer(ANN, "yes", "inv1")]).former, [
    { pubkey: ANN, until: 9, invite: "inv1" },
  ]);
  // A tag that names no invitation can never be borne out.
  const unnamed = record([], [{ pubkey: ANN, until: 9, invite: "" }]);
  assert.deepEqual(teamView(unnamed, [answer(ANN, "yes", "")]).former, []);
});

test("someone removed and added again must say yes again, even if the old invitation's name is put back", () => {
  const left = [{ pubkey: ANN, until: 5, invite: "inv1" }];
  // This app never reuses a name.
  assert.throws(() => withMember(record([], left), ANN, "inv1"), /used before/);
  assert.throws(() => withMember(record(), ANN, ""), /used before/);
  const change = withMember(record([], left), ANN, "inv2");
  // What the record says about their earlier time stays: it is what keeps the old invitation spent.
  assert.deepEqual(change.formerTeam, left);
  const member = change.team[0];
  const oldYes = answer(ANN, "yes", "inv1");
  assert.equal(memberState(member, COORD, [oldYes], left), "invited");
  assert.equal(
    memberState(member, COORD, [answer(ANN, "yes", "inv2")], left),
    "accepted",
  );
  // A record written by another app that puts the old name back: the old yes still does not count.
  const replayed = { pubkey: ANN, role: "member", invite: "inv1" };
  assert.equal(memberState(replayed, COORD, [oldYes], left), "invited");
  assert.equal(
    teamView(record([replayed], left), [oldYes]).members[0].state,
    "invited",
  );
  assert.equal(
    actsForProject(teamView(record([replayed], left), [oldYes]), FOUNDER, ANN),
    false,
  );
});

test("an answer to an invitation with no name is never a yes", () => {
  const unnamed = { pubkey: ANN, role: "member", invite: "" };
  assert.equal(
    memberState(unnamed, COORD, [answer(ANN, "yes", "")]),
    "invited",
  );
  assert.equal(memberState(unnamed, COORD, [answer(ANN, "no", "")]), "invited");
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

test("a no stands whichever was signed first: alone it declines, after a yes it is leaving", () => {
  const member = { pubkey: ANN, role: "member", invite: "inv1" };
  const yes = answer(ANN, "yes", "inv1");
  const no = answer(ANN, "no", "inv1");
  assert.equal(memberState(member, COORD, [no]), "declined");
  assert.equal(memberState(member, COORD, [yes, no]), "left");
  assert.equal(memberState(member, COORD, [no, yes]), "left");
  // Either way they no longer act for the project from this app.
  const view = teamView(record([member]), [yes, no]);
  assert.equal(actsForProject(view, FOUNDER, ANN), false);
});

test("the view shows who said yes, who has not, and who left; a stranger's yes makes nobody a former member", () => {
  const team = [
    { pubkey: ANN, role: "member", invite: "i1" },
    { pubkey: BO, role: "member", invite: "i2" },
  ];
  const gone = "c".repeat(64);
  const stranger = "d".repeat(64);
  const view = teamView(
    record(team, [{ pubkey: gone, until: 9, invite: "i0" }]),
    [
      answer(ANN, "yes", "i1"),
      answer(gone, "yes", "i0"),
      answer(stranger, "yes", "i1"),
    ],
  );
  assert.deepEqual(
    view.members.map((m) => [m.pubkey, m.state]),
    [
      [ANN, "accepted"],
      [BO, "invited"],
    ],
  );
  assert.deepEqual(view.former, [{ pubkey: gone, until: 9, invite: "i0" }]);
  assert.equal(actsForProject(view, FOUNDER, FOUNDER), true);
  assert.equal(actsForProject(view, FOUNDER, ANN), true);
  assert.equal(actsForProject(view, FOUNDER, BO), false);
  assert.equal(actsForProject(view, FOUNDER, stranger), false);
  assert.equal(actsForProject(view, FOUNDER, null), false);
});

test("who speaks for the project: the founder and members who said yes; someone who left, only until then", () => {
  const gone = "c".repeat(64);
  const quitter = "d".repeat(64);
  const team = [
    { pubkey: ANN, role: "member", invite: "i1" },
    { pubkey: BO, role: "member", invite: "i2" },
    { pubkey: quitter, role: "member", invite: "i3" },
  ];
  const no = answer(quitter, "no", "i3");
  const voices = projectVoices(
    record(team, [
      { pubkey: gone, until: 500, invite: "i0" },
      // Written about someone who never said yes: no voice at all.
      { pubkey: "e".repeat(64), until: 600, invite: "i9" },
    ]),
    [
      answer(ANN, "yes", "i1"),
      answer(gone, "yes", "i0"),
      answer(quitter, "yes", "i3"),
      no,
    ],
  );
  assert.deepEqual(
    [...voices].sort(),
    [
      [ANN, null],
      [gone, 500],
      [quitter, no.createdAt],
      [FOUNDER, null],
    ].sort(),
  );
  // Added, not yet a yes: the server lets them post, and they do not speak for the project.
  assert.equal(voices.has(BO), false);
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

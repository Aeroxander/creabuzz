import assert from "node:assert/strict";
import test from "node:test";

import {
  hasWaitingAsk,
  isJoinAskTags,
  JOIN_LABEL,
  joinAskEvent,
  MAX_PENDING_ASKS,
  parseJoinAsk,
  pendingAsks,
} from "./join.ts";
import {
  isTeamAnswerTags,
  memberState,
  parseTeamAnswer,
  TEAM_LABEL,
  withMember,
} from "./team.ts";

const founder = "f".repeat(64);
const alice = "a".repeat(64);
const bob = "b".repeat(64);
const carol = "c".repeat(64);
const coordinate = `37001:${founder}:orbit`;

const signed = (
  author,
  tags,
  createdAt = 100,
  id = `${author.slice(0, 4)}${createdAt}`,
) => ({
  id,
  pubkey: author,
  kind: 47003,
  created_at: createdAt,
  tags: [["a", coordinate], ...tags],
});
const ask = (author, invite, createdAt, id) =>
  parseJoinAsk(
    signed(author, joinAskEvent({ founder, invite }).tags, createdAt, id),
  );
const project = (team = [], formerTeam = []) => ({
  author: founder,
  coordinate,
  team,
  formerTeam,
});

test("an ask is one record with a label, a name, the person's own yes to that name, and the founder's key", () => {
  const { content, tags } = joinAskEvent({ founder, invite: "abc123" });
  assert.deepEqual(content, { title: "Asked to join", body: "" });
  assert.deepEqual(tags, [
    ["l", JOIN_LABEL],
    ["join-ask", "abc123"],
    ["l", TEAM_LABEL],
    ["team-answer", "yes"],
    ["team-invite", "abc123"],
    ["p", founder],
  ]);
  // A name is made when none is given, in the alphabet the server takes (lowercase letters and digits, at most 32).
  const made = joinAskEvent({ founder }).tags.find(
    (t) => t[0] === "join-ask",
  )[1];
  assert.match(made, /^[a-z0-9]{1,32}$/);
});

test("an ask is read back, and a record that is not one is not", () => {
  const event = signed(
    alice,
    joinAskEvent({ founder, invite: "abc123" }).tags,
    200,
    "id1",
  );
  assert.deepEqual(parseJoinAsk(event), {
    id: "id1",
    author: alice,
    coordinate,
    invite: "abc123",
    createdAt: 200,
  });
  assert.equal(isJoinAskTags(event.tags), true);
  assert.equal(parseJoinAsk({ ...event, kind: 1 }), null);
  assert.equal(parseJoinAsk({ ...event, tags: [["a", coordinate]] }), null);
  assert.equal(
    parseJoinAsk({ ...event, tags: [["join-ask", "x"]] }),
    null,
    "no project",
  );
  assert.equal(
    parseJoinAsk({
      ...event,
      tags: [
        ["a", coordinate],
        ["join-ask", ""],
      ],
    }),
    null,
  );
  assert.equal(parseJoinAsk({ ...event, pubkey: "nope" }), null);
  assert.equal(isJoinAskTags([["update-part", "done", "x"]]), false);
});

test("an ask is also a team answer, so the update lists never show it and the team reads the person's yes", () => {
  const tags = joinAskEvent({ founder, invite: "abc123" }).tags;
  assert.equal(isTeamAnswerTags(tags), true);
  const answer = parseTeamAnswer(signed(alice, tags));
  assert.equal(answer.answer, "yes");
  assert.equal(answer.invite, "abc123");
  assert.equal(answer.author, alice);
});

test("accepting an ask puts the person on the team, already said yes, by the name they gave", () => {
  const theAsk = ask(alice, "abc123", 100);
  const record = { author: founder, team: [], formerTeam: [] };
  const change = withMember(record, alice, theAsk.invite);
  assert.equal(change.team.length, 1);
  assert.equal(change.team[0].invite, "abc123");
  const answers = [
    parseTeamAnswer(
      signed(alice, joinAskEvent({ founder, invite: "abc123" }).tags),
    ),
  ];
  assert.equal(
    memberState(change.team[0], coordinate, answers, change.formerTeam),
    "accepted",
  );
  // An ask's yes joins nobody the founder does not list under its name.
  assert.equal(
    memberState(
      { pubkey: alice, role: "member", invite: "other" },
      coordinate,
      answers,
      [],
    ),
    "invited",
  );
});

test("the founder is shown each person's newest ask once, oldest first", () => {
  const asks = [
    ask(bob, "b2", 300),
    ask(alice, "a1", 100),
    ask(alice, "a2", 200),
    ask(carol, "c1", 150),
  ];
  assert.deepEqual(
    pendingAsks(asks, project()).map((a) => [a.author, a.invite]),
    [
      [carol, "c1"],
      [alice, "a2"],
      [bob, "b2"],
    ],
  );
});

test("an ask is not waiting once the person is on the record, is the founder, or its name was used", () => {
  const asks = [
    ask(alice, "a1", 100),
    ask(bob, "b1", 110),
    ask(carol, "c1", 120),
    ask(founder, "f1", 130),
  ];
  const left = [{ pubkey: carol, invite: "c1" }];
  assert.deepEqual(
    pendingAsks(asks, project([{ pubkey: alice }], left)).map((a) => a.author),
    [bob],
  );
  // The same person asking again with a new name after leaving is waiting again.
  assert.deepEqual(
    pendingAsks([...asks, ask(carol, "c2", 140)], project([], left)).map(
      (a) => a.invite,
    ),
    ["a1", "b1", "c2"],
  );
});

test("another project's asks are not this project's", () => {
  const other = parseJoinAsk({
    ...signed(alice, joinAskEvent({ founder, invite: "z" }).tags),
    tags: [
      ["a", `37001:${founder}:elsewhere`],
      ...joinAskEvent({ founder, invite: "z" }).tags,
    ],
  });
  assert.deepEqual(pendingAsks([other], project()), []);
});

test("no more than the bound are shown", () => {
  const many = Array.from({ length: MAX_PENDING_ASKS + 20 }, (_, i) =>
    ask(i.toString(16).padStart(64, "0"), `n${i}`, 1000 + i),
  );
  assert.equal(pendingAsks(many, project()).length, MAX_PENDING_ASKS);
});

test("a person knows their own ask is waiting until the founder lists them", () => {
  const mine = [ask(alice, "a1", 100)];
  assert.equal(hasWaitingAsk(mine, alice, project()), true);
  assert.equal(hasWaitingAsk(mine, bob, project()), false);
  assert.equal(hasWaitingAsk(mine, alice, project([{ pubkey: alice }])), false);
});

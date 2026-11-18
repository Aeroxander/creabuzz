import assert from "node:assert/strict";
import test from "node:test";

import {
  askAfterSignUpWaiting,
  clearAskAfterSignUp,
  hasWaitingAsk,
  isJoinAskTags,
  JOIN_LABEL,
  joinAskEvent,
  joinDeclineEvent,
  markAskAfterSignUp,
  MAX_PENDING_ASKS,
  parseJoinAsk,
  parseJoinDecline,
  pendingAsks,
  takeAskAfterSignUp,
  waitingAsks,
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

const decline = (who, asker, createdAt, id) =>
  parseJoinDecline(
    signed(
      who,
      joinDeclineEvent({ asker }).tags,
      createdAt,
      id ?? `d${createdAt}`,
    ),
  );

test("a decline is one record the founder signs, and is never listed as an update", () => {
  const { content, tags } = joinDeclineEvent({ asker: alice });
  assert.deepEqual(content, { title: "Turned an ask away", body: "" });
  assert.deepEqual(tags, [
    ["l", JOIN_LABEL],
    ["join-decline", alice],
  ]);
  assert.equal(isTeamAnswerTags(tags), true);
  assert.deepEqual(decline(founder, alice, 150, "d1"), {
    id: "d1",
    author: founder,
    coordinate,
    asker: alice,
    createdAt: 150,
  });
  // It is not an ask, and an ask is not a decline.
  assert.equal(parseJoinAsk(signed(founder, tags)), null);
  assert.equal(
    parseJoinDecline(signed(alice, joinAskEvent({ founder }).tags)),
    null,
  );
  assert.equal(
    parseJoinDecline(signed(founder, [["join-decline", "nope"]])),
    null,
  );
});

test("an ask the founder turned away is not waiting, until the person asks again", () => {
  const asks = [ask(alice, "a1", 100), ask(bob, "b1", 110)];
  const turned = [decline(founder, alice, 150)];
  assert.deepEqual(
    pendingAsks(asks, project(), turned).map((a) => a.author),
    [bob],
  );
  // A newer ask from the same person is waiting again; a decline as new as the ask still turns it away.
  const again = [...asks, ask(alice, "a2", 200)];
  assert.deepEqual(
    pendingAsks(again, project(), turned).map((a) => a.invite),
    ["b1", "a2"],
  );
  assert.deepEqual(
    pendingAsks(asks, project(), [decline(founder, alice, 100)]).map(
      (a) => a.author,
    ),
    [bob],
  );
});

test("only the founder's own decline, for this project, turns an ask away", () => {
  const asks = [ask(alice, "a1", 100)];
  // Signed by someone else, even a team member: no effect.
  assert.equal(
    pendingAsks(asks, project(), [decline(bob, alice, 150)]).length,
    1,
  );
  assert.equal(
    pendingAsks(asks, project([{ pubkey: bob }]), [decline(bob, alice, 150)])
      .length,
    1,
  );
  // About another project: no effect.
  const elsewhere = parseJoinDecline({
    ...signed(founder, joinDeclineEvent({ asker: alice }).tags, 150),
    tags: [
      ["a", `37001:${founder}:elsewhere`],
      ...joinDeclineEvent({ asker: alice }).tags,
    ],
  });
  assert.equal(pendingAsks(asks, project(), [elsewhere]).length, 1);
});

test("junk asks that fill the list's first page do not remove the ones behind them: the whole waiting list is counted", () => {
  const junk = Array.from({ length: MAX_PENDING_ASKS + 10 }, (_, i) =>
    ask(i.toString(16).padStart(64, "0"), `j${i}`, 1000 + i),
  );
  const real = ask(alice, "a1", 5000);
  const all = waitingAsks([...junk, real], project());
  assert.equal(all.length, MAX_PENDING_ASKS + 11);
  // The list shows the first page only, so the real ask is behind the junk until some of it is turned away ...
  assert.equal(
    pendingAsks([...junk, real], project()).some((a) => a.author === alice),
    false,
  );
  // ... and turning ten of them away brings it into view, and the count of what is hidden goes with it.
  const turned = junk
    .slice(0, 11)
    .map((a, i) => decline(founder, a.author, 6000 + i, `x${i}`));
  const after = pendingAsks([...junk, real], project(), turned);
  assert.equal(
    after.some((a) => a.author === alice),
    true,
  );
  assert.equal(
    waitingAsks([...junk, real], project(), turned).length - after.length,
    0,
  );
});

const memory = () => {
  const data = new Map();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
};

test("an Ask pressed while signed out waits for its own project, for ten minutes, and is used up once", () => {
  const store = memory();
  const t0 = 1_000_000;
  assert.equal(askAfterSignUpWaiting(store, coordinate, t0), false);
  markAskAfterSignUp(store, coordinate, t0);
  assert.equal(askAfterSignUpWaiting(store, coordinate, t0 + 9 * 60_000), true);
  // Another project's press is not this one's, and an old one is no longer good.
  assert.equal(
    askAfterSignUpWaiting(store, `37001:${founder}:elsewhere`, t0 + 1),
    false,
  );
  assert.equal(
    askAfterSignUpWaiting(store, coordinate, t0 + 11 * 60_000),
    false,
  );
  // Taken once: true the first time and then nothing, however often the page is drawn.
  assert.equal(takeAskAfterSignUp(store, coordinate, t0 + 1000), true);
  assert.equal(takeAskAfterSignUp(store, coordinate, t0 + 1000), false);
  // A press for another project is used up (forgotten) by a take for this one, never sent for it.
  markAskAfterSignUp(store, `37001:${founder}:elsewhere`, t0);
  assert.equal(takeAskAfterSignUp(store, coordinate, t0 + 1), false);
  assert.equal(
    askAfterSignUpWaiting(store, `37001:${founder}:elsewhere`, t0 + 1),
    false,
  );
  markAskAfterSignUp(store, coordinate, t0);
  clearAskAfterSignUp(store);
  assert.equal(askAfterSignUpWaiting(store, coordinate, t0 + 1), false);
});

test("storage that refuses is no waiting press and no error", () => {
  const broken = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
    removeItem() {
      throw new Error("blocked");
    },
  };
  markAskAfterSignUp(broken, coordinate);
  assert.equal(askAfterSignUpWaiting(broken, coordinate), false);
  assert.equal(takeAskAfterSignUp(broken, coordinate), false);
  clearAskAfterSignUp(broken);
  assert.equal(askAfterSignUpWaiting(null, coordinate), false);
});

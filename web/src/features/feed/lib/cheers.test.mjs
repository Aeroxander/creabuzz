import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cheerCountWords,
  cheerers,
  cheerKind,
  cheerLabel,
  cheerTarget,
  cheerWords,
} from "./cheers.ts";
import { buildVote } from "./feed-events.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const base = { at: 1, coordinate: "c" };
const update = (kept, missed = 0, first = false) => ({
  ...base,
  kind: "update",
  id: "u1",
  author: A,
  first,
  answers: { kept, missed, changed: 0 },
});
const goal = (state) => ({
  ...base,
  kind: "goal",
  id: "g",
  author: A,
  state,
});
const started = { ...base, kind: "started", id: "s1", author: A, text: "t" };

test("a start, a win and an honest miss can be cheered; a plain update and a changed goal cannot", () => {
  assert.deepEqual(cheerTarget(update(2)), {
    id: "u1",
    pubkey: A,
    kind: 47003,
  });
  // Nothing answered and not the first: nothing to cheer.
  assert.equal(cheerTarget(update(0)), null);
  assert.equal(cheerTarget(goal("changed")), null);
  assert.deepEqual(cheerTarget(goal("reached")), {
    id: "g",
    pubkey: A,
    kind: 47003,
  });
  assert.deepEqual(cheerTarget(goal("missed")), {
    id: "g",
    pubkey: A,
    kind: 47003,
  });
  assert.deepEqual(cheerTarget(started), { id: "s1", pubkey: A, kind: 47003 });
  assert.deepEqual(cheerTarget(update(0, 0, true)), {
    id: "u1",
    pubkey: A,
    kind: 47003,
  });
  assert.deepEqual(cheerTarget(update(0, 1)), {
    id: "u1",
    pubkey: A,
    kind: 47003,
  });
  // Accepted work: the cheer names the task and goes to whoever did it.
  assert.deepEqual(
    cheerTarget({
      ...base,
      kind: "work",
      id: "work:t1",
      taskId: "t1",
      author: A,
      helper: B,
    }),
    { id: "t1", pubkey: B, kind: 47003 },
  );
});

test("one cheer per account, however many it sent; down votes and other records are not cheers", () => {
  const r = (pubkey, target, content = "+", kind = 7) => ({
    kind,
    pubkey,
    content,
    tags: [["e", target]],
  });
  const got = cheerers(
    [
      r(A, "u1"),
      r(A, "u1"),
      r(B, "u1"),
      r(B, "u1", "-"),
      r(A, "other"),
      r(A, "u1", "+", 1),
    ],
    ["u1", "t1"],
  );
  assert.deepEqual([...(got.get("u1") ?? [])].sort(), [A, B]);
  assert.equal(got.has("other"), false);
  assert.equal(got.has("t1"), false);
});

test("the count reads as words", () => {
  assert.equal(cheerCountWords(0), "No cheers yet");
  assert.equal(cheerCountWords(1), "1 cheer");
  assert.equal(cheerCountWords(3), "3 cheers");
});

test("each record is cheered in its own words: luck for a start, a cheer for a win, thanks for an honest miss", () => {
  assert.equal(cheerKind(started), "luck");
  assert.equal(cheerKind(goal("reached")), "cheer");
  assert.equal(cheerKind(update(1)), "cheer");
  assert.equal(cheerKind(update(0, 0, true)), "cheer");
  // A miss is thanked, never cheered as a win; a kept promise in the same update still makes it a cheer.
  assert.equal(cheerKind(goal("missed")), "thanks");
  assert.equal(cheerKind(update(0, 2)), "thanks");
  assert.equal(cheerKind(update(1, 2)), "cheer");
  assert.equal(cheerWords("luck").button, "Good luck");
  assert.equal(cheerWords("thanks").button, "Thanks for saying so");
  assert.equal(cheerWords("cheer").button, "Cheer");
});

test("a count is said from the first cheer only", () => {
  assert.equal(cheerLabel("cheer", false, 0), "Cheer.");
  assert.equal(cheerLabel("luck", false, 0), "Good luck.");
  assert.equal(cheerLabel("cheer", false, 1), "Cheer. 1 cheer");
  assert.equal(cheerLabel("thanks", true, 3), "Thanks sent. 3 cheers");
});

test("a cheer is never tied to Shares: what the real cheerTarget names, and what is signed from it, is the record alone", () => {
  // Items that carry money-like fields the cheer must not pick up.
  const money = {
    shares: "500",
    price: "1.25",
    amount: "9",
    helperShares: "7",
  };
  const items = [
    { ...started, ...money },
    { ...goal("reached"), ...money },
    { ...goal("missed"), ...money },
    { ...update(1, 1), ...money },
    { ...update(0, 0, true), ...money },
    {
      ...base,
      kind: "work",
      id: "work:t1",
      taskId: "t1",
      author: A,
      helper: B,
      ...money,
    },
  ];
  for (const item of items) {
    const target = cheerTarget(item);
    assert.ok(target, `${item.kind} has a target`);
    assert.deepEqual(Object.keys(target).sort(), ["id", "kind", "pubkey"]);
    assert.equal(target.kind, 47003);
    assert.doesNotMatch(JSON.stringify(target), /500|1\.25|"9"|"7"/);
    // The signed reaction: an up vote on the record, naming the record, its author, its kind and the project.
    const vote = buildVote({
      target: { ...target, created_at: 0, tags: [], content: "" },
      direction: "+",
      launch: { pubkey: A, id: "nebula" },
    });
    assert.equal(vote.kind, 7);
    assert.equal(vote.content, "+");
    assert.deepEqual(vote.tags.map((t) => t[0]).sort(), ["a", "e", "k", "p"]);
  }
  // The words never speak of Shares, a price, a return or earning.
  for (const kind of ["luck", "cheer", "thanks"]) {
    const { button, sent } = cheerWords(kind);
    assert.doesNotMatch(
      `${button} ${sent} ${cheerLabel(kind, false, 2)}`,
      /share|price|return|profit|earn|pay|money/i,
    );
  }
});

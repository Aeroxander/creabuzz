import assert from "node:assert/strict";
import test from "node:test";

import { agreementNextAction } from "./agreement-next.ts";

/** The one field `agreementNextAction` reads: stage, index, dates, objection. */
const milestone = (index, stage, extra = {}) => ({
  index,
  stage,
  phase: "none",
  attempts: 0,
  windowEnds: 0,
  unlockedAt: 0,
  objection: null,
  ...extra,
});

const DAY = 86_400;
const view = (milestones) =>
  /** A lock reply reduced to what this module reads. */
  ({
    milestones,
    terms: { clawback: 30 * DAY },
    team: [],
    now: 100,
  });

test("a vote that ended is the next action, before anything earlier in order", () => {
  const next = agreementNextAction(
    view([
      milestone(0, "not-submitted"),
      milestone(1, "vote-ended", {
        phase: "voting",
        objection: { open: true, late: false, voteEnds: 500 },
      }),
      milestone(2, "waiting", { phase: "pending", windowEnds: 200 }),
    ]),
  );
  assert.equal(next?.index, 1);
  assert.equal(next?.state, "Vote ended");
  assert.equal(next?.role, "anyone");
});

test("an open vote carries the date the vote ends, named as a vote", () => {
  const next = agreementNextAction(
    view([
      milestone(0, "waiting", { phase: "pending", windowEnds: 300 }),
      milestone(1, "voting", {
        phase: "voting",
        objection: { open: true, late: false, voteEnds: 900 },
      }),
    ]),
  );
  assert.equal(next?.index, 1);
  assert.equal(next?.due, 900);
  assert.equal(next?.dateLine, "The vote ends");
  assert.match(next?.role, /holders/);
});

test("with no votes or windows open, the team's missing milestone is the next action", () => {
  const next = agreementNextAction(
    view([milestone(0, "not-submitted"), milestone(1, "not-submitted")]),
  );
  assert.equal(next?.index, 0);
  assert.equal(next?.state, "Not published");
  assert.equal(next?.role, "the team");
  assert.equal(next?.due, null);
});

test("a waiting window is named to holders with the date it closes", () => {
  const next = agreementNextAction(
    view([
      milestone(0, "unlocked", { phase: "stood" }),
      milestone(1, "waiting", { phase: "pending", windowEnds: 700 }),
    ]),
  );
  assert.equal(next?.index, 1);
  assert.equal(next?.state, "Open to objections");
  assert.equal(next?.due, 700);
  assert.equal(next?.dateLine, "The window to object ends");
});

test("an unlocked milestone inside the clawback period is dated by the end of the chance to object, not by the unlock's own day", () => {
  const next = agreementNextAction(
    view([milestone(0, "unlocked-open", { phase: "stood", unlockedAt: 200 })]),
  );
  assert.equal(next?.index, 0);
  assert.equal(next?.state, "Unlocked");
  assert.equal(next?.role, "holders who can object");
  assert.equal(next?.due, 200 + 30 * DAY);
  assert.equal(next?.dateLine, "The window to object ends");
});

test("every milestone stood through its windows: nothing is the next action", () => {
  assert.equal(
    agreementNextAction(view([milestone(0, "unlocked", { phase: "stood" })])),
    null,
  );
});

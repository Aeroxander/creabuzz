import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_ROLE, parseRole, stepsFor, wayInDone } from "./home-steps.ts";

const none = {
  named: false,
  lookedAtProject: false,
  follows: false,
  backed: false,
  published: false,
  setUpMilestones: false,
  madeWorkspace: false,
  ranHelper: false,
};

test("someone starts as a backer until they say otherwise, and a bad stored value does not break it", () => {
  assert.equal(DEFAULT_ROLE, "backer");
  assert.equal(parseRole(null), "backer");
  assert.equal(parseRole("founder"), "founder");
  assert.equal(parseRole("backer"), "backer");
  assert.equal(parseRole("admin"), "backer");
});

test("a backer is never asked to start a project or run an AI helper", () => {
  const labels = stepsFor("backer", none).map((s) => s.label.toLowerCase());
  for (const label of labels) {
    assert.doesNotMatch(
      label,
      /start a project|ai helper|ready-made|workspace/,
    );
  }
  assert.deepEqual(
    stepsFor("backer", none)
      .filter((s) => !s.optional)
      .map((s) => s.id),
    ["name", "look", "follow-or-back"],
  );
});

test("a founder is asked to publish and set up the agreement, with the workspace and helper for later", () => {
  const steps = stepsFor("founder", none);
  assert.deepEqual(
    steps.filter((s) => !s.optional).map((s) => s.id),
    ["name", "publish", "milestones"],
  );
  assert.deepEqual(
    steps.filter((s) => s.optional).map((s) => s.id),
    ["workspace", "helper"],
  );
});

test("nothing is ticked that has not happened", () => {
  for (const role of ["backer", "founder"]) {
    assert.ok(
      stepsFor(role, none).every((s) => !s.done),
      role,
    );
  }
});

test("a backer's way in is done once they have a name and have followed or backed a project", () => {
  assert.equal(wayInDone(stepsFor("backer", { ...none, named: true })), false);
  assert.equal(
    wayInDone(stepsFor("backer", { ...none, named: true, follows: true })),
    true,
  );
  assert.equal(
    wayInDone(stepsFor("backer", { ...none, named: true, backed: true })),
    true,
  );
});

test("following or backing counts as having looked, so the list never asks for a look that obviously happened", () => {
  const steps = stepsFor("backer", { ...none, follows: true });
  assert.equal(steps.find((s) => s.id === "look").done, true);
});

test("a founder's way in needs a published project and its funding agreement, not a workspace or a helper", () => {
  const base = { ...none, named: true, published: true };
  assert.equal(wayInDone(stepsFor("founder", base)), false);
  assert.equal(
    wayInDone(stepsFor("founder", { ...base, setUpMilestones: true })),
    true,
  );
  assert.equal(
    wayInDone(
      stepsFor("founder", { ...base, madeWorkspace: true, ranHelper: true }),
    ),
    false,
  );
});

test("backing is optional for a backer's way in: the money step never holds the list open", () => {
  const back = stepsFor("backer", none).find((s) => s.id === "back");
  assert.equal(back.optional, true);
});

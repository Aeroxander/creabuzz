import assert from "node:assert/strict";
import { test } from "node:test";

import { SANDBOX_ID } from "../../launchpad/lib/sandbox.ts";
import { parseStart, START_STEPS, startSteps } from "./start-steps.ts";

const none = { madeProject: false, hasIdea: false, hasSale: false };

test("the steps come in the order most projects take them", () => {
  assert.deepEqual(
    START_STEPS.map((s) => s.key),
    ["workspace", "idea", "raise", "run"],
  );
});

test("a newcomer has nothing done and is pointed at the first step", () => {
  const steps = startSteps(none, true);
  assert.deepEqual(
    steps.map((s) => s.done),
    [false, false, false, false],
  );
  assert.deepEqual(
    steps.map((s) => s.next),
    [true, false, false, false],
  );
});

test("each step is ticked only for what the person did, and the next one moves on", () => {
  const afterProject = startSteps({ ...none, madeProject: true }, true);
  assert.deepEqual(
    afterProject.map((s) => s.done),
    [true, false, false, false],
  );
  assert.equal(afterProject.find((s) => s.next)?.key, "idea");

  const afterIdea = startSteps(
    { madeProject: true, hasIdea: true, hasSale: false },
    true,
  );
  assert.equal(afterIdea.find((s) => s.next)?.key, "raise");
});

test("someone who went straight to a sale has also, in effect, shared an idea", () => {
  const steps = startSteps({ ...none, hasSale: true }, true);
  assert.equal(steps.find((s) => s.key === "idea")?.done, true);
  assert.equal(steps.find((s) => s.key === "raise")?.done, true);
  // The workspace step is still theirs to do: nothing here says they set one up.
  assert.equal(steps.find((s) => s.next)?.key, "workspace");
});

test("running it together is never ticked and never the next thing to do", () => {
  const steps = startSteps(
    { madeProject: true, hasIdea: true, hasSale: true },
    true,
  );
  const run = steps.find((s) => s.key === "run");
  assert.equal(run?.done, false);
  assert.equal(run?.next, false);
  assert.equal(steps.filter((s) => s.next).length, 0);
});

test("a build that offers no raises shows only the steps that need none", () => {
  const steps = startSteps(none, false);
  assert.deepEqual(
    steps.map((s) => s.key),
    ["workspace", "idea"],
  );
  assert.equal(steps.find((s) => s.next)?.key, "workspace");
  // Nothing on the page points at a sale or the raise sandbox.
  for (const step of steps) {
    assert.notDeepEqual(step.target, { to: "/launchpad", start: "sale" });
    assert.notEqual(step.target.to, "/launchpad/$launchId");
    assert.doesNotMatch(
      `${step.title} ${step.body} ${step.action}`,
      /raise|sale/i,
    );
  }
});

test("without raises, nothing is next once the place to work and the idea are done", () => {
  const steps = startSteps(
    { madeProject: true, hasIdea: true, hasSale: false },
    false,
  );
  assert.deepEqual(
    steps.map((s) => s.done),
    [true, true],
  );
  assert.equal(steps.filter((s) => s.next).length, 0);
});

test("with raises, the idea step still says interest comes before the raise", () => {
  const idea = startSteps(none, true).find((s) => s.key === "idea");
  assert.match(idea?.body ?? "", /before you raise/);
});

test("only the two known starts open a dialog", () => {
  assert.equal(parseStart("idea"), "idea");
  assert.equal(parseStart("sale"), "sale");
  assert.equal(parseStart("project"), undefined);
  assert.equal(parseStart(undefined), undefined);
  assert.equal(parseStart(1), undefined);
});

test("no step's words talk in protocol terms", () => {
  const text = START_STEPS.map(
    (s) => `${s.title} ${s.body} ${s.note ?? ""}`,
  ).join(" ");
  assert.doesNotMatch(text, /relay|nsec|npub|kind \d|contract|token/i);
});

test("the last step opens the sandbox launch the launchpad really has", () => {
  const run = START_STEPS.find((s) => s.key === "run");
  assert.deepEqual(run?.target, {
    to: "/launchpad/$launchId",
    launchId: SANDBOX_ID,
  });
});

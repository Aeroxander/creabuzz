import assert from "node:assert/strict";
import test from "node:test";

import { CAST, CAST_SHAPE, castByRole, castMember } from "./cast.ts";
import {
  INVARIANTS,
  INVARIANT_LABELS,
  checkAll,
  checksHold,
  failingChecks,
  uncheckedSteps,
} from "./invariants.ts";
import { STORY } from "./scenes.ts";
import { renderReport, reportHolds, runStory, storyIssues } from "./story.ts";

/**
 * The skeleton has to be worth extending: a story that measures nothing, or a
 * runner that passes a step nobody answered for, would make every later scene
 * look like proof (Review-Proven Rule 3).
 */

/** A world where nothing moved: every invariant holds. */
const quietWorld = (step) =>
  checkAll((invariant) => ({
    holds: true,
    detail: `${INVARIANT_LABELS[invariant]} — nothing moved: ${step.does}`,
  }));

// ---- the cast ----

test("the cast is the plan's cast, seat for seat", async () => {
  for (const [role, expected] of Object.entries(CAST_SHAPE)) {
    assert.equal(
      castByRole(role).length,
      expected,
      `${role} should have ${expected} seat(s)`,
    );
  }
  assert.equal(CAST.length, 11);
});

test("every seat says what it is there to do", async () => {
  for (const member of CAST) {
    assert.ok(member.purpose.length > 10, `${member.id} has no purpose`);
    assert.ok(castMember(member.id), `${member.id} is not findable`);
  }
});

// ---- the story's shape ----

test("the shipped story is one a runner will accept", async () => {
  assert.deepEqual(storyIssues(STORY, CAST), []);
});

test("a story that measures nothing is refused", async () => {
  const issues = storyIssues(
    {
      title: "Nothing",
      scenes: [
        {
          id: "s",
          title: "S",
          proves: "p",
          steps: [
            { actor: "founder", does: "does a thing", proves: "p", checks: [] },
          ],
        },
      ],
    },
    CAST,
  );
  assert.ok(issues.some((i) => i.includes("reads no invariant")));
  assert.ok(issues.some((i) => i.includes("ever reads")));
});

test("a step narrated by someone outside the cast is refused", async () => {
  const issues = storyIssues(
    {
      title: "Stranger",
      scenes: [
        {
          id: "s",
          title: "S",
          proves: "p",
          steps: [
            {
              actor: "the stranger",
              does: "wanders in",
              proves: "p",
              checks: INVARIANTS,
            },
          ],
        },
      ],
    },
    CAST,
  );
  assert.deepEqual(issues, [
    'scene "s" step 1 is narrated by "the stranger", who is not in the cast',
  ]);
});

test("two scenes cannot share an id", async () => {
  const issues = storyIssues(
    {
      title: "Duped",
      scenes: [
        { id: "s", title: "One", proves: "p", steps: STORY.scenes[0].steps },
        { id: "s", title: "Two", proves: "p", steps: STORY.scenes[0].steps },
      ],
    },
    CAST,
  );
  assert.ok(issues.some((i) => i.includes('two scenes share the id "s"')));
});

// ---- running one ----

test("a run records every step in order, with its readings", async () => {
  const report = await runStory(STORY, quietWorld);
  const expected = STORY.scenes.flatMap((scene) =>
    scene.steps.map((s) => s.does),
  );
  assert.equal(report.entries.length, expected.length);
  assert.deepEqual(
    report.entries.map((e) => e.step),
    expected,
  );
  // Scene order is preserved too, so the report reads as the story ran.
  assert.deepEqual(
    report.entries.map((e) => e.scene),
    STORY.scenes.flatMap((scene) => scene.steps.map(() => scene.id)),
  );
  assert.ok(reportHolds(report));
  assert.ok(checksHold(report.entries[0].checks));
});

test("a step the world did not answer for fails the run", async () => {
  const report = await runStory(STORY, (step) =>
    step.checks.slice(0, 1).map((invariant) => ({
      invariant,
      holds: true,
      detail: "only one of the four came back",
    })),
  );
  assert.equal(reportHolds(report), false);
  assert.ok(report.unanswered.length > 0);
  assert.match(report.unanswered[0], /funding-status#0/);
});

test("an invariant that does not hold fails the run and names the step", async () => {
  const report = await runStory(STORY, (_step, key) =>
    checkAll((invariant) => ({
      holds: invariant !== "treasury-solvent",
      detail:
        invariant === "treasury-solvent"
          ? `the treasury went empty at ${key}`
          : "fine",
    })),
  );
  assert.equal(reportHolds(report), false);
  assert.equal(failingChecks(report.failures).length, report.entries.length);
  assert.match(report.failures[0].detail, /funding-status#0/);
});

test("a step that checks nothing is visible, not silently fine", async () => {
  const report = await runStory(
    {
      title: "Unchecked",
      scenes: [
        {
          id: "s",
          title: "S",
          proves: "p",
          steps: [
            {
              actor: "founder",
              does: "waves it through",
              proves: "p",
              checks: [],
            },
          ],
        },
      ],
    },
    () => [],
  );
  assert.deepEqual(uncheckedSteps(report.entries), ["waves it through"]);
  assert.equal(reportHolds(report), false);
  assert.match(renderReport(report), /## Steps that checked nothing/);
});

// ---- the report ----

test("the report reads as a timeline a human can follow", async () => {
  const text = renderReport(await runStory(STORY, quietWorld));
  assert.match(text, /^# A whole project, start to finish/);
  assert.match(text, /## funding-status/);
  // The actor is named, not their id.
  assert.match(text, /\*\*the founder\*\* — publishes an idea/);
  // Every invariant is on the step's line.
  for (const label of Object.values(INVARIANT_LABELS)) {
    assert.ok(text.includes(label), `report is missing "${label}"`);
  }
  assert.match(text, /All \d+ steps held every invariant they read\./);
});

test("a failed run says so at the bottom, in one line", async () => {
  const text = renderReport(
    await runStory(STORY, () =>
      checkAll((invariant) => ({
        holds: invariant !== "supply-conserved",
        detail: "tokens appeared from nowhere",
      })),
    ),
  );
  assert.match(text, /## Invariant failures/);
  assert.match(text, /The story did not hold/);
});

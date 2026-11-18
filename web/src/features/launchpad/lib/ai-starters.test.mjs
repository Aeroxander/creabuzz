import assert from "node:assert/strict";
import { test } from "node:test";

import { firstPromises } from "./weekly-update.ts";
import { promiseLines } from "./promises.ts";
import { taskProblem } from "./tasks.ts";
import {
  aiStarterKinds,
  pressStarterPromises,
  replaceableByStarter,
  starterPromiseKinds,
  starterTasksLeft,
} from "./ai-starters.ts";

const AI = "AI agent or tool";

test("an AI project is offered the four kinds; any other project none", () => {
  assert.deepEqual(
    aiStarterKinds(AI).map((kind) => kind.label),
    ["AI app", "Agent or tool", "Dataset or benchmark", "AI media"],
  );
  assert.deepEqual(aiStarterKinds("Software"), []);
  assert.deepEqual(aiStarterKinds(""), []);
  assert.deepEqual(aiStarterKinds(null), []);
});

test("first promises are offered on the first weekly update only", () => {
  assert.equal(
    starterPromiseKinds({ category: AI, weeklyPosted: 0 }).length,
    4,
  );
  assert.deepEqual(starterPromiseKinds({ category: AI, weeklyPosted: 1 }), []);
  // Not known yet whether an update was posted: nothing is offered on a guess.
  assert.deepEqual(
    starterPromiseKinds({ category: AI, weeklyPosted: null }),
    [],
  );
  assert.deepEqual(
    starterPromiseKinds({ category: "Creative", weeklyPosted: 0 }),
    [],
  );
});

test("each kind's promises are exactly the three lines an update turns into promises", () => {
  for (const kind of aiStarterKinds(AI)) {
    const lines = promiseLines(kind.promises);
    assert.equal(lines.length, 3, kind.id);
    // None is cut or dropped by the update's own rule for "What's next".
    assert.deepEqual(firstPromises(kind.promises), {
      text: kind.promises,
      dropped: 0,
    });
    assert.deepEqual(lines, kind.promises.split("\n"));
  }
});

test("a press fills the box, a second press on the same kind clears it, and another kind replaces it", () => {
  const [app, tool] = aiStarterKinds(AI);
  const filled = pressStarterPromises("", app);
  assert.equal(filled, app.promises);
  assert.equal(pressStarterPromises(filled, app), "");
  assert.equal(pressStarterPromises(filled, tool), tool.promises);
});

test("words the founder wrote are never replaceable; an empty box or an unedited starter is", () => {
  const starters = aiStarterKinds(AI).map((kind) => kind.promises);
  assert.equal(replaceableByStarter("", starters), true);
  assert.equal(replaceableByStarter("  \n", starters), true);
  assert.equal(replaceableByStarter(`${starters[1]}\n`, starters), true);
  assert.equal(replaceableByStarter("Invite ten people", starters), false);
  // One edited word makes it the founder's own.
  assert.equal(
    replaceableByStarter(starters[0].replace("five", "six"), starters),
    false,
  );
});

test("every starter task can be made as it stands, and one already made is not offered again", () => {
  for (const kind of aiStarterKinds(AI)) {
    assert.ok(kind.tasks.length >= 3, kind.id);
    for (const task of kind.tasks)
      assert.equal(
        taskProblem({
          what: task.title,
          done: task.done,
          due: "",
          today: "2026-11-15",
        }),
        null,
        task.title,
      );
  }
  const [app] = aiStarterKinds(AI);
  const left = starterTasksLeft(app, [
    ` ${app.tasks[0].title.toUpperCase()} `,
    "Something else",
  ]);
  assert.deepEqual(
    left.map((task) => task.title),
    app.tasks.slice(1).map((task) => task.title),
  );
});

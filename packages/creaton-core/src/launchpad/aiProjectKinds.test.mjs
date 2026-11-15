import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AI_PROJECT_ACCOUNTABILITY,
  AI_PROJECT_KINDS,
  aiProjectKind,
} from "./aiProjectKinds.ts";

test("there are four kinds, each with its own id and chip words", () => {
  assert.deepEqual(
    AI_PROJECT_KINDS.map((kind) => kind.id),
    ["ai-app", "agent-tool", "dataset-benchmark", "ai-media"],
  );
  assert.equal(new Set(AI_PROJECT_KINDS.map((kind) => kind.label)).size, 4);
});

for (const kind of AI_PROJECT_KINDS) {
  test(`${kind.id}: hints, examples with numbers, three promises and three to five tasks`, () => {
    assert.ok(kind.goalHints.length >= 2);
    assert.ok(kind.howExamples.length >= 2);
    // Every way of saying how we will know carries a number, so it can be checked.
    for (const example of kind.howExamples)
      assert.match(example, /\d/, example);
    assert.equal(kind.promises.length, 3);
    assert.ok(kind.tasks.length >= 3 && kind.tasks.length <= 5);
    for (const task of kind.tasks) {
      assert.ok(task.title.trim().length > 5);
      // A finish line is written before anyone starts, and says what is handed in.
      assert.ok(task.done.trim().length > 20, task.title);
    }
  });
}

test("the wording fits the form it fills: a goal hint and a how example fit the goal limits", () => {
  // Start limits both boxes to 200 characters; a suggestion that does not fit would be cut when picked.
  for (const kind of AI_PROJECT_KINDS) {
    for (const text of [...kind.goalHints, ...kind.howExamples])
      assert.ok(text.length <= 200, text);
  }
});

test("no vendor, product or model name appears, and Shares are never said to be earned", () => {
  const all = JSON.stringify(AI_PROJECT_KINDS) + AI_PROJECT_ACCOUNTABILITY;
  assert.doesNotMatch(
    all,
    /openai|anthropic|claude|gpt|gemini|llama|mistral|midjourney|stable diffusion|hugging ?face|github|google|microsoft/i,
  );
  assert.doesNotMatch(all, /earn/i);
});

test("a kind is found by id, and an unknown id is none", () => {
  assert.equal(aiProjectKind("agent-tool")?.label, "Agent or tool");
  assert.equal(aiProjectKind("nope"), null);
  assert.equal(aiProjectKind(""), null);
  assert.equal(aiProjectKind(null), null);
});

test("the accountability line says a named person answers, and that an agent does not sign", () => {
  assert.match(AI_PROJECT_ACCOUNTABILITY, /named person answers/);
  assert.match(AI_PROJECT_ACCOUNTABILITY, /signed by a person/);
});

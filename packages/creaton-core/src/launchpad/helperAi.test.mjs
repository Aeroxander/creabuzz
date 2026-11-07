import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AI_DISCLOSURE,
  fenceAiRequest,
  parseTakeOnDraft,
  parseWorkCheck,
  takeOnDraftPrompt,
  workCheckPrompt,
} from "./helperAi.ts";

test("the work check gives only the form's words, says links cannot be opened, and reads a list back", () => {
  const p = workCheckPrompt({
    doneWhen: "docs merged and reviewed",
    evidence: "https://example.com/pr/1",
    met: "",
    notMet: "",
  });
  assert.match(p.system, /You cannot open links/);
  assert.match(p.system, /never add facts/);
  assert.match(p.user, /It will be judged against: docs merged and reviewed/);
  assert.match(p.user, /How they checked it: \(not said\)/);
  assert.deepEqual(
    parseWorkCheck('{"gaps":["Say which pages","a","b","c","d","e"]}'),
    ["Say which pages", "a", "b", "c", "d"],
  );
  assert.deepEqual(parseWorkCheck('```json\n{"gaps":[]}\n```'), []);
  assert.equal(parseWorkCheck("Looks good to me!"), null);
});

test("only a valid empty list reads as a clean check: any entry that is not a non-blank string rejects the whole reply", () => {
  assert.deepEqual(parseWorkCheck('{"gaps":[]}'), []);
  assert.deepEqual(parseWorkCheck('["Explain which tests ran"]'), null);
  assert.deepEqual(parseWorkCheck('{"gaps":["Explain which tests ran"]}'), [
    "Explain which tests ran",
  ]);
  for (const reply of [
    '{"gaps":[{"text":"Missing tests"}]}',
    '{"gaps":[7]}',
    '{"gaps":["ok",{"text":"x"}]}',
    '{"gaps":["ok",null]}',
    '{"gaps":["  ",""]}',
    '{"gaps":["ok"," "]}',
    '{"gap":[]}',
    '{"gaps":"none"}',
    "not json",
  ])
    assert.equal(parseWorkCheck(reply), null, reply);
  // The same gap twice is one gap.
  assert.deepEqual(
    parseWorkCheck('{"gaps":["Say which pages","Say which pages "]}'),
    ["Say which pages"],
  );
});

test("an AI answer is used only while the form is open and its words are what they were when it was asked", () => {
  let form = { deliver: "A guide", for: "New people" };
  let open = true;
  const current = fenceAiRequest(
    () => form,
    () => open,
  );
  assert.equal(current(), true);
  // Another object with the same words is the same request.
  form = { ...form };
  assert.equal(current(), true);
  form = { ...form, deliver: "A shorter guide" };
  assert.equal(current(), false, "an edit made while it ran is kept");
  form = { deliver: "A guide", for: "New people" };
  assert.equal(current(), true);
  open = false;
  assert.equal(current(), false, "a cancelled form is not filled in");
});

test("the AI disclosure names where the words go, not that only you see them", () => {
  assert.match(AI_DISCLOSURE, /this server's AI service/);
  assert.doesNotMatch(AI_DISCLOSURE, /only you/i);
});

test("the interviewer's answers become a draft, kept within the limits", () => {
  const p = takeOnDraftPrompt({
    area: "Docs",
    doneWhen: null,
    answers: { good: "writing", time: "two evenings", care: "" },
  });
  assert.match(p.user, /Done when: \(its words are not published\)/);
  assert.match(
    p.user,
    /What in this work area do you care about\? \(no answer\)/,
  );
  assert.deepEqual(
    parseTakeOnDraft(
      '{"deliver":"A short guide","for":"New contributors","days":10.4}',
    ),
    { deliver: "A short guide", for: "New contributors", days: 10 },
  );
  assert.equal(
    parseTakeOnDraft('{"deliver":"x","for":"y","days":500}').days,
    90,
  );
  assert.equal(parseTakeOnDraft('{"deliver":"x","days":3}'), null);
  assert.equal(parseTakeOnDraft("Sure, here you go"), null);
});

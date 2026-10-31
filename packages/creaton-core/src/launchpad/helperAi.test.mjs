import assert from "node:assert/strict";
import { test } from "node:test";

import {
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
    parseWorkCheck('{"gaps":["Say which pages"," ","a","b","c","d","e"]}'),
    ["Say which pages", "a", "b", "c", "d"],
  );
  assert.deepEqual(parseWorkCheck('```json\n{"gaps":[]}\n```'), []);
  assert.equal(parseWorkCheck("Looks good to me!"), null);
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

import assert from "node:assert/strict";
import { test } from "node:test";

import { checkDraftPrompt, parseCheckDraft } from "./checkNoteAi.ts";

const note = {
  since: 1,
  outside: "Two teachers used the guide.",
  items: [
    {
      text: "Ship the guide",
      expected: "Two newcomers submit",
      checkBy: 2,
      happened: "partly",
      why: "One submitted",
      next: "keep",
      becomes: "",
    },
    {
      text: "Find a reviewer",
      expected: "",
      checkBy: null,
      happened: null,
      why: "",
      next: null,
      becomes: "",
    },
  ],
  finished: [{ key: "b:1", title: "Write the guide" }],
  turnedDown: [{ key: "b:2", title: "Translate" }],
  causes: [{ label: 'The "done when" was unclear', count: 1 }],
  stuck: "",
  lapsed: 1,
  change: "",
  summary: "",
};

test("the prompt carries only the note's facts, and the rules say to invent nothing and rank no one", () => {
  const { system, user } = checkDraftPrompt(
    note,
    "Teachers who want open lesson plans",
  );
  assert.match(system, /Never add numbers, people, events or results/);
  assert.match(system, /Do not name or rank individuals/);
  assert.match(system, /exactly one question per Now item/);
  assert.match(user, /Aim: Teachers who want open lesson plans/);
  assert.match(
    user,
    /1\. Ship the guide\. Expected: Two newcomers submit\. Happened: partly\. What the founder saw: One submitted\. The founder's choice: keep\./,
  );
  assert.match(user, /2\. Find a reviewer\. No expectation was set\./);
  assert.match(user, /what was missing: The "done when" was unclear, 1/);
  assert.match(
    checkDraftPrompt({ ...note, outside: "" }, "").user,
    /Aim: \(not set\)[\s\S]*\(the founder has not said yet\)/,
  );
});

test("a reply is read only when it is the JSON asked for, with one question per item", () => {
  const good = JSON.stringify({
    summary: "The guide is half there.",
    questions: [
      "What would make more newcomers submit?",
      "Is one reviewer enough?",
      "extra",
    ],
  });
  assert.deepEqual(parseCheckDraft(good, 2), {
    summary: "The guide is half there.",
    questions: [
      "What would make more newcomers submit?",
      "Is one reviewer enough?",
    ],
  });
  // A fenced reply is read too; missing questions are left empty.
  assert.deepEqual(
    parseCheckDraft('```json\n{"summary":"x","questions":["q"]}\n```', 2),
    { summary: "x", questions: ["q", ""] },
  );
  assert.equal(parseCheckDraft("Here is your summary: ...", 2), null);
  assert.equal(parseCheckDraft('{"summary":"","questions":[]}', 2), null);
  assert.equal(parseCheckDraft('{"summary":"x"}', 2), null);
  assert.equal(
    parseCheckDraft(
      JSON.stringify({ summary: "s".repeat(900), questions: [] }),
      0,
    )?.summary.length,
    600,
  );
});

test("an AI summary lands only on the note it was asked about; newer edits are never undone", async () => {
  const { acceptCheckDraft } = await import("./checkNoteAi.ts");
  const asked = structuredClone(note);
  // Nothing changed while the AI wrote: the summary is added to the note as it is now.
  assert.deepEqual(acceptCheckDraft(asked, structuredClone(note), "Sum."), {
    ...note,
    summary: "Sum.",
  });
  // The founder changed what they saw, or a keep/change/drop answer, while it wrote: the draft is set aside.
  const edited = structuredClone(note);
  edited.outside = "Three teachers used it.";
  assert.equal(acceptCheckDraft(asked, edited, "Sum."), null);
  const decided = structuredClone(note);
  decided.items[1].next = "drop";
  assert.equal(acceptCheckDraft(asked, decided, "Sum."), null);
});

test("lapsed dates go to the AI as dates, never as work that did not come in", () => {
  const { user } = checkDraftPrompt(note, "");
  assert.doesNotMatch(user, /without the work/);
});

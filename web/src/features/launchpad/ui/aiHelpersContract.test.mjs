import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The AI helpers on the work-check, take-on and challenge forms. The mocked browser
 * suite cannot hold an AI answer back while someone types, or switch a build to contributor-only per test, so, as in
 * `contributorOnlyGatesContract.test.mjs`, the components' source is the seam for the wiring. The rules themselves are
 * pure and driven in core: `fenceAiRequest`, `parseWorkCheck` and `AI_DISCLOSURE` in `helperAi.test.mjs`.
 */

const source = (name) =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

test("the newcomer interviewer drops a draft when the form changed or closed while it ran", () => {
  const interview = source("./TakeOnInterview.tsx");
  assert.match(
    interview,
    /const current = fenceAiRequest\(\s*\(\) => latest\.current,\s*\(\) => mounted\.current,?\s*\)/,
  );
  // The fence covers the answers and the form's own fields, passed in from TakeOnWork.
  assert.match(
    interview,
    /latest\.current = \{ answers, form, areaTitle, doneWhen \};/,
  );
  assert.match(interview, /if \(!current\(\)\) \{/);
  assert.ok(
    interview.indexOf("if (!current()) {") < interview.indexOf("onDraft({"),
    "the fence is checked before the draft is handed over",
  );
  const work = source("./TakeOnWork.tsx");
  assert.match(work, /form=\{draft\}/);
  // A late draft never reopens a cancelled form, and a cancelled AI draft is not still waiting to be read next time.
  assert.match(
    work,
    /setDraft\(null\);\s*setTried\(false\);\s*setFailure\(null\);\s*setAiDrafted\(false\);/,
  );
  assert.match(
    work,
    /setDraft\(\(current\) =>\s*current === null \? null : \{ \.\.\.current, \.\.\.next \},?\s*\)/,
  );
});

test("the challenge's AI follow-ups and summary are dropped when the answers changed or the form closed while it ran", () => {
  const challenge = source("./ChallengeQuestions.tsx");
  assert.match(challenge, /const current = fenceAiRequest\(/);
  assert.ok(
    challenge.indexOf("if (!current()) {") > -1 &&
      challenge.indexOf("if (!current()) {") <
        challenge.indexOf("followUps: questions.map"),
    "the fence is checked before the follow-ups are applied",
  );
});

test("the work check shows a result only for the words it read, and drops it on a new try", () => {
  const check = source("./WorkCheckAi.tsx");
  assert.match(check, /setResult\(null\);/);
  assert.match(check, /result && result\.asked === asked/);
  assert.match(check, /data-testid="work-claim-ai-stale"/);
});

test("every AI helper says the words go to the server's AI service, and none says only you see them", () => {
  for (const file of [
    "./WorkCheckAi.tsx",
    "./TakeOnInterview.tsx",
    "./ChallengeQuestions.tsx",
  ]) {
    const text = source(file);
    assert.match(text, /AI_DISCLOSURE/, file);
    assert.doesNotMatch(text, /Only you see this/, file);
  }
});

test("the case against a vote is not said to come from before the vote opened", () => {
  const challenge = source("./ChallengeQuestions.tsx");
  assert.doesNotMatch(challenge, /before it went out/);
  assert.match(challenge, /data-testid="decision-challenged-date"/);
});

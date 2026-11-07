import assert from "node:assert/strict";
import { test } from "node:test";

import {
  challengeContent,
  EMPTY_CHALLENGE,
  parseChallenge,
} from "./challenge.ts";
import {
  challengeSummaryPrompt,
  followUpPrompt,
  parseChallengeSummary,
  parseFollowUps,
} from "./challengeAi.ts";

const context = {
  kind: "Award Shares for reviewed work",
  aim: "Teachers who want open lesson plans",
  now: ["Ship the guide"],
  lastCheck: { outside: "Two teachers used it", change: "Pair newcomers" },
};
const answers = { ...EMPTY_CHALLENGE, caseAgainst: "25 Shares is a lot" };

test("the prompts give only the facts, ask for at most two follow-ups, then a summary that says what was skipped", () => {
  const ask = followUpPrompt(context, answers);
  assert.match(ask.system, /Never add numbers, people, events or results/);
  assert.match(ask.system, /at most 2 follow-up questions/);
  assert.match(ask.user, /The vote: Award Shares for reviewed work\./);
  assert.match(ask.user, /What has to go right for this to work\? \(skipped\)/);
  assert.match(
    ask.user,
    /What is the strongest case against it\? 25 Shares is a lot/,
  );
  const sum = challengeSummaryPrompt(context, answers, [
    { question: "What would make it fair?", answer: "" },
  ]);
  assert.match(sum.system, /three-line summary/);
  assert.match(sum.user, /What would make it fair\? \(skipped\)/);
  assert.match(
    followUpPrompt({ ...context, lastCheck: null, now: [] }, answers).user,
    /There is no check note yet\.[\s\S]*/,
  );
});

test("replies are read only when they are the JSON asked for", () => {
  assert.deepEqual(parseFollowUps('{"followUps":["A?"," ","B?","C?"]}'), [
    "A?",
    "B?",
  ]);
  assert.deepEqual(parseFollowUps('```json\n{"followUps":[]}\n```'), []);
  assert.equal(parseFollowUps("Sure! Here are some questions"), null);
  assert.equal(parseChallengeSummary('{"summary":"Short."}'), "Short.");
  assert.equal(parseChallengeSummary('{"summary":""}'), null);
  assert.equal(parseChallengeSummary("[1,2]"), null);
});

test("follow-ups and the summary travel with the challenge and read back", () => {
  const content = challengeContent({
    decision: `0x${"ab".repeat(32)}`,
    proposer: `0x${"12".repeat(20)}`,
    title: "Award",
    answers,
    extras: {
      followUps: [
        {
          question: "What would make it fair?",
          answer: "Compare to the docs area",
        },
      ],
      summary: "It works if the page stays current.",
    },
  });
  assert.match(content.body, /^It works if the page stays current\./);
  const read = parseChallenge({
    id: "e",
    pubkey: "1".repeat(64),
    kind: 47003,
    created_at: 1,
    content: JSON.stringify(content),
  });
  assert.deepEqual(read.followUps, [
    {
      question: "What would make it fair?",
      answer: "Compare to the docs area",
    },
  ]);
  assert.equal(read.summary, "It works if the page stays current.");
});

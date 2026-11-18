import assert from "node:assert/strict";
import { test } from "node:test";

import {
  challengeAnswered,
  challengeContent,
  challengeFor,
  challengeProblem,
  EMPTY_CHALLENGE,
  parseChallenge,
} from "./challenge.ts";

const ID = `0x${"ab".repeat(32)}`;
const WALLET = `0x${"12".repeat(20)}`;
const KEY = "1".repeat(64);
const STRANGER = "9".repeat(64);

const answers = {
  mustGoRight: "Two reviewers stay for a month",
  caseAgainst: "",
  instead: "Wait for the guide",
};

const event = (pubkey, at, content) => ({
  id: `${pubkey}${at}`,
  pubkey,
  kind: 47003,
  created_at: at,
  content: JSON.stringify(content),
});

test("a challenge publishes its answers, skips included, naming the vote and the wallet that opens it", () => {
  const content = challengeContent({
    decision: ID.toUpperCase().replace("0X", "0x"),
    proposer: WALLET,
    title: "Award 25 Shares",
    answers,
  });
  assert.equal(content.title, "Before the vote: Award 25 Shares");
  assert.match(
    content.body,
    /What is the strongest case against it\? \(skipped\)/,
  );
  const read = parseChallenge(event(KEY, 5, content));
  assert.equal(read.decision, ID);
  assert.equal(read.proposer, WALLET);
  assert.deepEqual(read.answers, { ...answers, caseAgainst: "" });
});

test("nothing answered is no challenge, and an answer has a length limit", () => {
  assert.equal(challengeAnswered(EMPTY_CHALLENGE), false);
  assert.equal(
    challengeAnswered({ ...EMPTY_CHALLENGE, instead: "wait" }),
    true,
  );
  assert.match(
    challengeProblem({ ...EMPTY_CHALLENGE, caseAgainst: "x".repeat(401) }),
    /under 400/,
  );
  const empty = challengeContent({
    decision: ID,
    proposer: WALLET,
    title: "x",
    answers: EMPTY_CHALLENGE,
  });
  assert.equal(parseChallenge(event(KEY, 5, empty)), null);
  assert.equal(parseChallenge(event(KEY, 5, { title: "News" })), null);
});

test("only a challenge for this vote, from the wallet that opened it, signed by whoever bound that wallet, is shown", () => {
  const mine = parseChallenge(
    event(
      KEY,
      5,
      challengeContent({ decision: ID, proposer: WALLET, title: "x", answers }),
    ),
  );
  const forged = parseChallenge(
    event(
      STRANGER,
      9,
      challengeContent({ decision: ID, proposer: WALLET, title: "x", answers }),
    ),
  );
  const bound = new Set([`${KEY}:${WALLET}`]);
  const decision = {
    id: ID,
    proposer: WALLET.toUpperCase().replace("0X", "0x"),
  };
  assert.equal(challengeFor(decision, [mine, forged], bound)?.author, KEY);
  // Another vote, or one opened from another wallet, is not challenged by it.
  assert.equal(
    challengeFor({ ...decision, id: `0x${"cd".repeat(32)}` }, [mine], bound),
    null,
  );
  assert.equal(
    challengeFor(
      { ...decision, proposer: `0x${"34".repeat(20)}` },
      [mine],
      bound,
    ),
    null,
  );
  assert.equal(challengeFor(decision, [mine], new Set()), null);
});

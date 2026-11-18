import assert from "node:assert/strict";
import { test } from "node:test";

import { KIND_FORECAST } from "../kinds.generated.ts";
import { encodeFunctionData, encodeParameters } from "./evmAbi.ts";
import {
  accuracy,
  brier,
  countingForecasts,
  DAY,
  forecastTemplate,
  middleForecast,
  parseForecast,
  parseQuestion,
  postBountyQuestion,
  questionOf,
  readPostBountyQuestion,
  readWorkBountyQuestion,
  TOPIC_CLAIM_RELEASED,
  TOPIC_RUN_STARTED,
  workBountyQuestion,
} from "./forecast.ts";
import { NO_APPEAL, OPEN_BOUNTY_SIGNATURES } from "./openBounty.ts";
import { encodeCall0, encodeCallId, SIGNATURES } from "./work.ts";

const CONTRACT = `0x${"9d".repeat(20)}`;
const Q = `forecast:postbounty:31337:${CONTRACT}:7`;
const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const words = (...v) => `0x${v.map(word).join("")}`;

// ---- questions and records ------------------------------------------------------------------------

test("a question names one bounty in the shape the server checks", () => {
  const q = {
    kind: "postbounty",
    chainId: 31337,
    contract: CONTRACT.toUpperCase().replace("0X", "0x"),
    id: 7n,
  };
  assert.equal(questionOf(q), Q);
  assert.deepEqual(parseQuestion(Q), {
    kind: "postbounty",
    chainId: 31337,
    contract: CONTRACT,
    id: 7n,
  });
  for (const bad of [
    `forecast:raise:31337:${CONTRACT}:7`,
    `forecast:postbounty:031337:${CONTRACT}:7`,
    `forecast:postbounty:31337:${CONTRACT}:07`,
    `forecast:postbounty:31337:0x9d:7`,
    `forecast:postbounty:31337:${CONTRACT}:7:x`,
  ]) {
    assert.equal(parseQuestion(bad), null, bad);
  }
});

test("a forecast record holds the question, a whole percent and a reason, as the server requires", () => {
  assert.deepEqual(forecastTemplate(Q, 62, "  They shipped two like it. "), {
    kind: KIND_FORECAST,
    tags: [
      ["t", Q],
      ["forecast", "62"],
    ],
    content: "They shipped two like it.",
  });
  assert.throws(() => forecastTemplate(Q, 101, "r"), /0 to 100/);
  assert.throws(() => forecastTemplate(Q, 50.5, "r"), /0 to 100/);
  assert.throws(() => forecastTemplate(Q, 50, "  "), /reason/);
  assert.throws(() => forecastTemplate(Q, 50, "é".repeat(501)), /reason/);
  assert.ok(forecastTemplate(Q, 0, "é".repeat(500)));
  assert.throws(() => forecastTemplate("forecast:x", 50, "r"), /question/);
});

const event = (over = {}) => ({
  id: "e1",
  pubkey: "a".repeat(64),
  kind: KIND_FORECAST,
  created_at: 1_000,
  tags: [
    ["t", Q],
    ["forecast", "40"],
  ],
  content: "reason",
  ...over,
});

test("a record the server would refuse is not read as a forecast", () => {
  assert.deepEqual(parseForecast(event()), {
    id: "e1",
    author: "a".repeat(64),
    question: Q,
    percent: 40,
    reason: "reason",
    createdAt: 1_000,
  });
  assert.equal(parseForecast(event({ kind: 1 })), null);
  assert.equal(parseForecast(event({ content: " " })), null);
  for (const p of ["101", "050", "-1", "4.5", ""]) {
    assert.equal(
      parseForecast(
        event({
          tags: [
            ["t", Q],
            ["forecast", p],
          ],
        }),
      ),
      null,
      p,
    );
  }
  assert.equal(
    parseForecast(
      event({
        tags: [
          ["t", Q],
          ["t", Q],
          ["forecast", "4"],
        ],
      }),
    ),
    null,
  );
});

// ---- counting and scoring ---------------------------------------------------------------------------

const f = (author, percent, createdAt) => ({
  id: `${author}${createdAt}`,
  author,
  question: Q,
  percent,
  reason: "r",
  createdAt,
});

test("each person's latest forecast strictly before the cutoff counts", () => {
  const all = [
    f("ann", 20, 100),
    f("ann", 70, 200),
    f("ann", 99, 300),
    f("bo", 50, 299),
    f("cy", 10, 300),
  ];
  const counted = countingForecasts(all, 300);
  assert.deepEqual(
    counted.map((x) => [x.author, x.percent]),
    [
      ["bo", 50],
      ["ann", 70],
    ],
  );
});

test("the middle forecast is the median, rounded for an even count", () => {
  assert.equal(middleForecast([]), null);
  assert.equal(middleForecast([f("a", 30, 1)]), 30);
  assert.equal(
    middleForecast([f("a", 90, 1), f("b", 10, 1), f("c", 40, 1)]),
    40,
  );
  assert.equal(middleForecast([f("a", 10, 1), f("b", 41, 1)]), 26);
});

test("accuracy is 100 times one minus the mean Brier score; always saying 50% scores 75", () => {
  assert.equal(brier(100, true), 0);
  assert.equal(brier(100, false), 1);
  assert.equal(brier(50, true), 0.25);
  assert.equal(accuracy([]), null);
  assert.equal(
    accuracy([
      { percent: 50, done: true },
      { percent: 50, done: false },
    ]),
    75,
  );
  assert.equal(
    accuracy([
      { percent: 100, done: true },
      { percent: 0, done: false },
    ]),
    100,
  );
  assert.equal(
    accuracy([
      { percent: 80, done: true },
      { percent: 30, done: false },
    ]),
    94,
  );
});

// ---- cutoffs and outcomes ------------------------------------------------------------------------

const post = (over = {}) => ({
  creator: "0x1",
  openedAt: 0,
  deadline: 30 * DAY,
  refundsFrom: 53 * DAY,
  post: "0x0",
  wordsHash: "0x0",
  total: 100n,
  refunded: 0n,
  counting: 100n,
  claimCount: 1,
  runClaim: 0,
  runSince: 0,
  paidClaim: 0,
  court: false,
  appeal: NO_APPEAL,
  ...over,
});

test("a post bounty's question closes at its first run or a day before its deadline, and settles on payment or refunds", () => {
  assert.deepEqual(postBountyQuestion(post(), null, DAY), {
    cutoff: 29 * DAY,
    outcome: null,
  });
  assert.deepEqual(postBountyQuestion(post(), 5 * DAY, DAY), {
    cutoff: 5 * DAY,
    outcome: null,
  });
  assert.equal(postBountyQuestion(post(), 29.5 * DAY, DAY).cutoff, 29 * DAY);
  assert.equal(
    postBountyQuestion(post({ paidClaim: 1 }), 5 * DAY, 99 * DAY).outcome,
    "done",
  );
  assert.equal(
    postBountyQuestion(post(), null, 30 * DAY).outcome,
    "not-done",
    "refunds at the deadline with no run",
  );
  assert.equal(
    postBountyQuestion(
      post({ runClaim: 1, runSince: 25 * DAY }),
      25 * DAY,
      31 * DAY,
    ).outcome,
    null,
  );
});

const work = (over = {}) => ({
  mandate: `0x${"b1".repeat(20)}`,
  openedAt: 0,
  deadline: 30 * DAY,
  projectId: `0x${word(1)}`,
  window: 7 * DAY,
  refundsFrom: 51 * DAY,
  total: 100n,
  refunded: 0n,
  paidClaim: null,
  contributor: null,
  ...over,
});

test("a work-area bounty's question closes at its first released submission and settles on payment or refundsFrom", () => {
  assert.equal(workBountyQuestion(work(), null, DAY).cutoff, 29 * DAY);
  assert.equal(workBountyQuestion(work(), 3 * DAY, DAY).cutoff, 3 * DAY);
  assert.equal(
    workBountyQuestion(
      work({ paidClaim: "0x1", contributor: "0x2" }),
      3 * DAY,
      9 * DAY,
    ).outcome,
    "done",
  );
  assert.equal(workBountyQuestion(work(), null, 51 * DAY - 1).outcome, null);
  assert.equal(workBountyQuestion(work(), null, 51 * DAY).outcome, "not-done");
});

// ---- readers --------------------------------------------------------------------------------------

test("a post bounty's state is read with its earliest run", async () => {
  const chain = {
    now: async () => 2 * DAY,
    call: async (_to, data) => {
      // This bounty names no court: the contract answers the zero address, so
      // the court read is a real answer rather than a failed one.
      if (data === encodeCall0(OPEN_BOUNTY_SIGNATURES.court)) return words(0);
      assert.equal(
        data,
        encodeFunctionData(OPEN_BOUNTY_SIGNATURES.bounties, ["uint256"], [7n]),
      );
      return words(
        1,
        0,
        30 * DAY,
        53 * DAY,
        0,
        0,
        100,
        0,
        100,
        1,
        1,
        6 * DAY,
        0,
      );
    },
    logs: async ({ topics }) => {
      assert.equal(topics[0], TOPIC_RUN_STARTED);
      return [
        { topics, data: words(6 * DAY) },
        { topics, data: words(4 * DAY) },
      ];
    },
  };
  assert.deepEqual(await readPostBountyQuestion(chain, CONTRACT, 7n), {
    cutoff: 4 * DAY,
    outcome: null,
  });
});

test("a work-area bounty's cutoff is its work area's first submission released after it opened", async () => {
  const MANDATE = `0x${"b1".repeat(20)}`;
  const CLAIMS = `0x${"c1".repeat(20)}`;
  const claimIds = [1, 2, 3].map((n) => `0x${word(n)}`);
  // Claim 1: another work area. Claim 2: this one, released before the bounty opened. Claim 3: this one, day 8.
  const projectOf = { [claimIds[0]]: 9, [claimIds[1]]: 1, [claimIds[2]]: 1 };
  const releasedOf = {
    [claimIds[0]]: 2 * DAY,
    [claimIds[1]]: DAY / 2,
    [claimIds[2]]: 8 * DAY,
  };
  const chain = {
    now: async () => 10 * DAY,
    call: async (to, data) => {
      if (to === CONTRACT) {
        return words(
          BigInt(MANDATE),
          DAY,
          30 * DAY,
          1,
          7 * DAY,
          51 * DAY,
          100,
          0,
          0,
          0,
        );
      }
      if (to === MANDATE && data === encodeCall0(SIGNATURES.mandateClaims))
        return words(BigInt(CLAIMS));
      for (const id of claimIds) {
        if (
          to === MANDATE &&
          data === encodeCallId(SIGNATURES.claimProject, id)
        )
          return words(projectOf[id]);
        if (to === CLAIMS && data === encodeCallId(SIGNATURES.claim, id)) {
          return words(0xda, 0, 0, 1, 1, 1, 99 * DAY, releasedOf[id]);
        }
      }
      throw new Error(`unexpected ${to} ${data}`);
    },
    logs: async ({ address, topics }) => {
      assert.equal(address, CLAIMS);
      assert.equal(topics[0], TOPIC_CLAIM_RELEASED);
      return claimIds.map((id) => ({
        topics: [TOPIC_CLAIM_RELEASED, id],
        data: encodeParameters(
          ["address", "uint256"],
          [`0x${"da".repeat(20)}`, 0n],
        ),
      }));
    },
  };
  assert.deepEqual(await readWorkBountyQuestion(chain, CONTRACT, 3n), {
    cutoff: 8 * DAY,
    outcome: null,
  });
});

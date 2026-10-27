import assert from "node:assert/strict";
import { test } from "node:test";

import {
  caseKind,
  caseQuestion,
  caseStatusLine,
  owedLine,
  rulingWords,
  seatProblem,
  stakeLine,
  timeoutLabel,
} from "./court-copy.ts";

const date = (s) => `day ${s / 86_400}`;
const DAY = 86_400;

test("each period of a case reads as one sentence with its deadline", () => {
  const at = (period, over = {}) =>
    caseStatusLine(
      { period, periodStart: 10 * DAY, rounds: 1, ruling: 0, ...over },
      date,
    );
  assert.equal(
    at("evidence"),
    "Collecting evidence until day 12. Then jurors are drawn.",
  );
  assert.equal(
    at("evidence", { rounds: 2 }),
    "Appealed. The larger panel can be drawn now.",
  );
  assert.equal(at("commit"), "Jurors seal their votes until day 12.");
  assert.equal(at("reveal"), "Jurors open their votes until day 12.");
  assert.equal(
    at("appeal", { ruling: 1 }),
    "The panel ruled for the work. Anyone can appeal to a larger panel until day 12.",
  );
  assert.equal(
    at("appeal", { ruling: 2, rounds: 3 }),
    "The last panel ruled against the work. It can be settled now.",
  );
  assert.equal(at("ruled", { ruling: 1 }), "Final ruling: for the work.");
  assert.equal(at("ruled"), "Final: no ruling, so the bounty stays as it was.");
  assert.equal(rulingWords(0), "neither way");
});

test("a juror's stake is told in seats", () => {
  const seat = 100n * 10n ** 18n;
  assert.equal(stakeLine(0n, 0n, seat), "You have nothing staked.");
  assert.equal(
    stakeLine(3n * seat, seat, seat),
    "You stake 300 CREATE: 3 seats, 2 free.",
  );
  assert.equal(
    stakeLine(seat + seat / 2n, 0n, seat),
    "You stake 150 CREATE: 1 seat, 1 free.",
  );
});

test("what the court owes names only what is owed", () => {
  assert.equal(owedLine(3_000_000n, 0n), "The court owes you 3 USDC.");
  assert.equal(
    owedLine(1_500_000n, 50n * 10n ** 18n),
    "The court owes you 1.5 USDC and 50 CREATE.",
  );
});

test("ending an unheard case says what stands", () => {
  assert.equal(timeoutLabel(1), "End it with no ruling");
  assert.equal(timeoutLabel(2), "End it: the last ruling stands");
});

test("stakes and take-outs leave whole seats, as the court asks", () => {
  const seat = 100n * 10n ** 18n;
  assert.equal(
    seatProblem("stake", 0n, seat - 1n, seat),
    "Stake at least 100 CREATE: one seat.",
  );
  assert.equal(seatProblem("stake", 0n, seat, seat), null);
  assert.equal(seatProblem("stake", seat, 1n, seat), null, "adding to a seat");
  assert.equal(
    seatProblem("unstake", 2n * seat, seat + 1n, seat),
    "Take out all of it, or leave at least 100 CREATE: one seat.",
  );
  assert.equal(seatProblem("unstake", 2n * seat, 2n * seat, seat), null);
  assert.equal(seatProblem("unstake", 2n * seat, seat, seat), null);
});

test("each kind of case asks its own question and says what a ruling does", () => {
  assert.equal(
    caseQuestion("remix").yes,
    "Yes, it broke them",
    "for, on a remix, means it broke the terms",
  );
  assert.equal(caseQuestion("bounty").yes, "Yes, it does");
  assert.equal(
    rulingWords(1, "remix"),
    "that the project broke its terms, so its bond goes to the parent",
  );
  assert.equal(
    rulingWords(2, "remix"),
    "that the project kept its terms, so its bond stays",
  );
  assert.equal(rulingWords(1), "for the work");
  const ruled = (kind, ruling) =>
    caseStatusLine(
      { period: "ruled", periodStart: 0, rounds: 1, ruling, kind },
      String,
    );
  assert.equal(ruled("remix", 0), "Final: no ruling, so the bond stays.");
  assert.equal(
    ruled("remix", 1),
    "Final ruling: that the project broke its terms, so its bond goes to the parent.",
  );
  assert.equal(caseKind({ about: null }), "other");
  assert.equal(caseKind({ about: { kind: "remix" } }), "remix");
});

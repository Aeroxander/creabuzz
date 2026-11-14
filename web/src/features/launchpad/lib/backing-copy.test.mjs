import assert from "node:assert/strict";
import test from "node:test";

import { BACKING_ERROR_NAMES } from "@creaton/core/launchpad/backing.ts";
import { USER_REJECTED_MESSAGE } from "@creaton/core/launchpad/wallet-errors.ts";

import {
  ALL_REFUSAL_LINES,
  backingFailure,
  backingLimits,
  cutLine,
  HONEST_LINE,
  milestoneLine,
  milestoneOutcomeLine,
  money,
  NOT_SHARES_LINE,
  nextMilestoneFact,
  notHereLine,
  OPEN_NOW_HELP,
  OPEN_ROUND_HELP,
  PHASE_CHIP,
  positionLine,
  shortRef,
  spanWords,
  staleReadLine,
  stateLine,
  unitsPhrase,
  WHAT_IT_IS,
} from "./backing-copy.ts";

const token = { address: "0x", decimals: 6, symbol: "tTEST" };

/** Words for a protocol, not for a person (PLAIN-WORDS.md): none may appear in anything the page says. */
const PROTOCOL_WORDS =
  /\bescrow|\btranche|\bQ96|\bnsec|\bnpub|\brelay\b|\bgas\b|\btx\b|\btransaction|\bslippage|\bcalldata|\bERC-?20|\brevert|\bmint|\bburn|\bDAO\b|\bonchain|\bon-chain|\bvesting|\bquorum|\bearn/i;

const everySentence = () => [
  HONEST_LINE,
  WHAT_IT_IS,
  NOT_SHARES_LINE,
  OPEN_NOW_HELP,
  OPEN_ROUND_HELP,
  ...["none", "waiting", "live", "failed", "abandoned"].flatMap((p) => [
    stateLine(p, true),
    stateLine(p, false),
    PHASE_CHIP[p],
  ]),
  ...backingLimits(),
  ...ALL_REFUSAL_LINES,
  ...["no-dao", "no-network", "no-factory"].map(notHereLine),
  ...[
    { kind: "window", leaveBy: 1_700_000_000, releasableFrom: 1_700_000_000 },
    { kind: "release", until: 1 },
    { kind: "cancel" },
    { kind: "wait", from: 1_700_000_000 },
    { kind: "ready" },
  ].flatMap((n) => [
    nextMilestoneFact(n).label,
    nextMilestoneFact(n).value,
    milestoneLine(n, "3 tTEST") ?? "",
  ]),
];

test("nothing the page says speaks in protocol words, and none of it hints at a return", () => {
  for (const line of everySentence()) {
    assert.doesNotMatch(line, PROTOCOL_WORDS, line);
  }
});

test("the legal lines are whole and always in the list a backer reads", () => {
  const limits = backingLimits();
  assert.ok(limits.includes("You may get back less than you paid."));
  assert.ok(limits.includes("Do not put in money you cannot lose."));
  assert.ok(limits.includes(NOT_SHARES_LINE));
  assert.ok(
    limits.some((l) =>
      /Nothing checks that it is true except backers choosing to leave/.test(l),
    ),
  );
  assert.ok(
    limits.some((l) =>
      /has not had an outside security or legal review/.test(l),
    ),
  );
  assert.ok(
    limits.some((l) =>
      /gives up the part of your money that is held for the project to the backers who stay/.test(
        l,
      ),
    ),
  );
  assert.equal(
    HONEST_LINE,
    "You can sell any time. At each milestone you can stay or leave with your held money back.",
  );
});

test("each state says one thing and the founder is told how to open it", () => {
  assert.match(stateLine("none", true), /You can open it/);
  assert.doesNotMatch(stateLine("none", false), /You can open/);
  assert.match(stateLine("failed", false), /takes their money back/);
  assert.match(stateLine("abandoned", false), /get their held money back/);
});

test("every refusal the contract can make has a sentence with a next step, and the raw name only goes to Technical details", () => {
  for (const name of BACKING_ERROR_NAMES) {
    const out = backingFailure(`execution reverted: ${name}()`);
    assert.doesNotMatch(out.text, new RegExp(`\\b${name}\\b`), name);
    assert.doesNotMatch(out.text, PROTOCOL_WORDS, name);
    assert.ok(out.text.length > 20 && /[.]$/.test(out.text), name);
    assert.match(out.detail ?? "", new RegExp(name), name);
  }
});

test("a selector in place of a name, a rejection in the wallet, and an unknown failure are each said plainly", () => {
  assert.match(
    backingFailure("revert 0x7dd37f70").text,
    /price moved more than you allowed/,
  );
  assert.deepEqual(backingFailure(USER_REJECTED_MESSAGE), {
    text: "You said no in your wallet, so nothing was sent.",
    detail: null,
  });
  const odd = backingFailure(
    "execution reverted: some other thing at 0x12345678",
  );
  assert.equal(
    odd.text,
    "That step was refused, so nothing changed. Refresh and try again.",
  );
  assert.match(odd.detail, /some other thing/);
  // A sentence the app wrote already is kept as it is.
  assert.deepEqual(
    backingFailure("Your passkey was not accepted. Try again."),
    {
      text: "Your passkey was not accepted. Try again.",
      detail: null,
    },
  );
  assert.equal(backingFailure("").detail, null);
});

test("amounts carry their symbol, and units say one unit or many", () => {
  assert.equal(money(12_500_000n, token), "12.5 tTEST");
  assert.equal(money(12_500_000n, { ...token, symbol: null }), "12.5");
  assert.equal(unitsPhrase(10n ** 18n), "1 unit");
  assert.equal(unitsPhrase(25n * 10n ** 17n), "2.5 units");
});

test("time is said as a span in whole days or hours, never as soon", () => {
  assert.equal(spanWords(6 * 86_400 + 5), "6 days");
  assert.equal(spanWords(86_400), "1 day");
  assert.equal(spanWords(3 * 3_600), "3 hours");
  assert.equal(spanWords(1_200), "less than an hour");
  assert.equal(spanWords(-5), "less than an hour");
});

test("a read that was cut, or a failed refresh, is said", () => {
  assert.equal(cutLine(false, 0), null);
  assert.match(cutLine(true, 0), /more backing history than could be read/);
  assert.match(
    cutLine(false, 2),
    /2 records could not be read and are left out/,
  );
  assert.match(cutLine(false, 1), /1 record could not be read and is left out/);
  assert.match(staleReadLine(Date.now() - 3 * 3_600_000), /3 hours ago/);
  assert.match(staleReadLine(0), /may be out of date/);
});

test("a milestone's record line says what was released and how many left", () => {
  assert.equal(
    milestoneOutcomeLine("released", "5 tTEST", 0),
    "Released 5 tTEST to the project.",
  );
  assert.equal(
    milestoneOutcomeLine("released", "5 tTEST", 1),
    "Released 5 tTEST to the project. 1 backer left.",
  );
  assert.equal(
    milestoneOutcomeLine("cancelled", "", 3),
    "Not settled in time: nothing was released. 3 backers left.",
  );
  assert.equal(milestoneOutcomeLine("open", "", 0), "Open.");
  assert.equal(shortRef(`0x${"ab12cd34".repeat(8)}`), "ab12cd34");
});

test("a position says what the units are worth to sell now and what is held, and nothing when there is no position", () => {
  const snapshot = {
    holderUnits: 3n * 10n ** 18n,
    holderSellValue: 4_000_000n,
    holderEscrow: 500_000n,
  };
  assert.equal(
    positionLine(snapshot, token),
    "You hold 3 units. Selling them now pays 4 tTEST. 0.5 tTEST of what you paid is held for the project.",
  );
  assert.equal(positionLine({ ...snapshot, holderUnits: 0n }, token), null);
});

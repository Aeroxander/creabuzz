import assert from "node:assert/strict";
import test from "node:test";

import {
  backingProgress,
  backingTax,
  backingWeight,
  isResolvable,
  missedMinimum,
  positionWeight,
  priceIsAllowed,
  remainingRoom,
  reserveAfterTax,
  tokensAtRisk,
  tokensForReserve,
} from "./proposal-funding.ts";

/**
 * The numbers a backer is shown must be the numbers the chain settles at.
 * Every figure below is also asserted in `contracts/test/ProposalVault.t.sol`,
 * so a change to either side that is not mirrored on the other fails here.
 */

const VAT = 500; // 5%, the contract fixture's tax

test("the tax and the reserve agree with the contract fixture", () => {
  // ProposalVault.t.sol: 1_000 pledged, 5% tax -> 50 to the treasury, 950
  // reserved, 475e18 tokens escrowed at a price of 2.
  assert.equal(backingTax(1_000, VAT), 50n);
  assert.equal(reserveAfterTax(1_000, VAT), 950n);
  assert.equal(tokensForReserve(950n, 2), 475n * 10n ** 18n);

  // The 200 case: 10 tax, 190 reserved, 95e18 tokens.
  assert.equal(backingTax(200, VAT), 10n);
  assert.equal(
    tokensForReserve(reserveAfterTax(200, VAT), 2),
    95n * 10n ** 18n,
  );
});

test("a tax can never buy extra weight", () => {
  // Tokens are priced off the reserve, not the gross commitment: the tax is
  // money that left, so it must not mint anything.
  const gross = 1_000n;
  const reserve = reserveAfterTax(gross, VAT);
  assert.ok(tokensForReserve(reserve, 2) < tokensForReserve(gross, 2));
});

test("zero price mints nothing instead of dividing by zero", () => {
  assert.equal(tokensForReserve(1_000n, 0), 0n);
});

test("the price is refused below the treasury's value per token", () => {
  assert.equal(priceIsAllowed(5, 5), true);
  assert.equal(priceIsAllowed(6, 5), true);
  assert.equal(
    priceIsAllowed(4, 5),
    false,
    "buy-then-ragequit must be impossible",
  );
});

test("backing weight earns the stake back and at most as much again", () => {
  const TOKEN = 475n * 10n ** 18n;
  const position = { tokens: TOKEN, startBlock: 100 };
  const T = 1_000;

  assert.equal(positionWeight(position, 100, T), TOKEN);
  assert.equal(positionWeight(position, 100 + T / 2, T), (TOKEN * 3n) / 2n);
  assert.equal(positionWeight(position, 100 + T, T), TOKEN * 2n);
  assert.equal(positionWeight(position, 100 + 10 * T, T), TOKEN * 2n);
});

test("backing after a snapshot buys nothing", () => {
  const position = { tokens: 475n * 10n ** 18n, startBlock: 101 };
  assert.equal(positionWeight(position, 100, 1_000), 0n);
});

test("weight is summed per proposal and never leaks across", () => {
  const positions = [
    { proposalId: "p1", tokens: "100", currency: "200", startBlock: 10 },
    { proposalId: "p1", tokens: "50", currency: "100", startBlock: 20 },
    { proposalId: "p2", tokens: "999", currency: "999", startBlock: 10 },
  ];
  // At block 20 with a 100-block window: the first p1 position has aged 10
  // blocks (100 + 10), the second none (50), p2 has aged 10 (999 + 99).
  assert.equal(backingWeight(positions, "p1", 20, 100), 160n);
  assert.equal(backingWeight(positions, "p2", 20, 100), 1_098n);
  assert.equal(backingWeight(positions, "nope", 20, 100), 0n);
});

test("resolved proposals are no longer at risk", () => {
  const positions = [
    { proposalId: "p1", tokens: "100", currency: "100", startBlock: 1 },
    { proposalId: "p2", tokens: "200", currency: "200", startBlock: 1 },
  ];
  assert.equal(
    tokensAtRisk(positions, () => false),
    300n,
  );
  assert.equal(
    tokensAtRisk(positions, (id) => id === "p1"),
    200n,
  );
  assert.equal(
    tokensAtRisk(positions, () => true),
    0n,
    "nothing is at risk once it resolves",
  );
});

test("a proposal is judged once it clears its minimum or runs out of time", () => {
  const open = {
    id: "p",
    checkHash: "c",
    minAmount: "100",
    maxAmount: "1_000",
    deadline: 100,
    reserved: "95",
    state: "open",
  };
  assert.equal(isResolvable({ ...open, reserved: "100" }, 50), true);
  assert.equal(isResolvable(open, 50), false);
  assert.equal(missedMinimum(open, 50), false);
  // Out of time and below the minimum: anyone may close it.
  assert.equal(missedMinimum(open, 101), true);
  assert.equal(isResolvable(open, 101), true);
});

test("a resolved proposal is neither resolvable nor closable again", () => {
  const done = {
    id: "p",
    checkHash: "c",
    minAmount: "100",
    maxAmount: "1_000",
    deadline: 100,
    reserved: "500",
    state: "verified",
  };
  assert.equal(isResolvable(done, 50), false);
  assert.equal(missedMinimum(done, 200), false);
});

test("the remaining room is what the cap has left", () => {
  const proposal = {
    id: "p",
    checkHash: "c",
    minAmount: "100",
    maxAmount: "1_000",
    deadline: 100,
    reserved: "600",
    state: "open",
  };
  assert.equal(remainingRoom(proposal), 400n);
  assert.equal(remainingRoom({ ...proposal, reserved: "5_000" }), 0n);
});

test("the progress line reads as plain words", () => {
  assert.equal(
    backingProgress({
      id: "p",
      checkHash: "c",
      minAmount: "1_000",
      maxAmount: "5_000",
      deadline: 100,
      reserved: "950",
      state: "open",
    }),
    "950 of 1000 needed",
  );
});

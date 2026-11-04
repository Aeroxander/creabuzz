/**
 * Pins `roundUnit` (web/src/features/launchpad/lib/rounds-copy.ts), the function that names what a
 * round trades. It is pure, so it is pinned here by `node --test`.
 *
 * These tests document the function's CURRENT behaviour, including the argument mistake its funding
 * caller makes today (`FundingCard.tsx` passes the round's own token where the DAO's Shares belongs).
 * The last test states that defect explicitly; it is not an endorsement of it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

// The module lives in the web app, not in this package: the funding card and the rounds card both
// render it, so it is pinned where the rest of the pure launchpad copy is pinned.
import { roundUnit } from "../../../../web/src/features/launchpad/lib/rounds-copy.ts";

const SHARES = "0xAAaa000000000000000000000000000000000001";
const LOOT = "0xbbbb000000000000000000000000000000000002";

test("a holders' round trades Shares, whatever the DAO's Shares address", () => {
  assert.equal(roundUnit({ funding: false, shares: SHARES }, SHARES), "Shares");
  assert.equal(roundUnit({ funding: false, shares: LOOT }, SHARES), "Shares");
  // A holders' round opens on the DAO's Shares (WeeklyRounds.open), so an unread address changes nothing.
  assert.equal(roundUnit({ funding: false, shares: SHARES }, null), "Shares");
});

test("a funding round whose token is the DAO's Shares says Shares, ignoring address case", () => {
  assert.equal(roundUnit({ funding: true, shares: SHARES }, SHARES), "Shares");
  assert.equal(
    roundUnit({ funding: true, shares: SHARES.toLowerCase() }, SHARES),
    "Shares",
  );
  assert.equal(
    roundUnit({ funding: true, shares: SHARES }, SHARES.toLowerCase()),
    "Shares",
  );
});

test("a funding round whose token is another contract says non-voting shares", () => {
  // FundingTerms.reserve returns `asShares ? shares() : loot()`, and WeeklyRounds._openRound stores
  // that token on the round, so a non-voting sale's round carries the DAO's Loot here.
  assert.equal(
    roundUnit({ funding: true, shares: LOOT }, SHARES),
    "non-voting shares",
  );
  // Any other token is treated the same way: it is not the DAO's Shares, so it cannot vote.
  assert.equal(
    roundUnit(
      { funding: true, shares: "0xcccc000000000000000000000000000000000003" },
      SHARES,
    ),
    "non-voting shares",
  );
});

test("an unknown DAO Shares address falls back to plain shares", () => {
  assert.equal(roundUnit({ funding: true, shares: LOOT }, null), "shares");
  // No token on the round reads the same way: it claims no vote either.
  assert.equal(roundUnit({ funding: true, shares: "" }, SHARES), "shares");
});

test("documented: a funding round compared against its own token always reads Shares", () => {
  // `FundingCard.tsx` passes `shares={round.shares}` into RoundPanel, so roundUnit compares the
  // round's token with itself and can never say "non-voting shares". Both tokens read "Shares".
  const sharesRound = { funding: true, shares: SHARES };
  const lootRound = { funding: true, shares: LOOT };
  assert.equal(roundUnit(sharesRound, sharesRound.shares), "Shares");
  assert.equal(roundUnit(lootRound, lootRound.shares), "Shares");
  // The same rounds, given the DAO's Shares as the second argument, tell the two apart.
  assert.equal(roundUnit(sharesRound, SHARES), "Shares");
  assert.equal(roundUnit(lootRound, SHARES), "non-voting shares");
});

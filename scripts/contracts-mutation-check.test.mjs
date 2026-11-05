import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "contracts-mutation-check.mjs");

function run(...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

const entries = JSON.parse(run("--list").stdout || "[]");
const at = (file, guardPart) => entries.filter((e) => e.file.endsWith(file) && e.guard.includes(guardPart));

// The secondary-market candidate's entries: its own contracts, plus the entries on the patched DAO's Shares that carry the
// "Secondary market:" prefix. (Older entries are outside this test's remit: --check on all of them is run by hand.)
const mineOnly = (e) =>
  /(^|\/)(SecondaryMarket|SecondaryMarketFactory|ActivationVoting|ContributorKitV2)\.sol$/.test(e.file) ||
  e.name.startsWith("Secondary market:");

test("every secondary-market entry's guard is in its file exactly once and its tests exist (no forge run)", () => {
  const indices = entries.filter(mineOnly).map((e) => String(e.i));
  assert.ok(indices.length > 0, "no secondary-market entries");
  const out = run("--check", ...indices);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /every entry is well formed/);
});

// A guard nobody mutates is a guard nobody has proved a test notices (TESTING.md). These are the secondary-market
// candidate's guards, located by their text, so a rewritten guard that drops its entry fails here.
const REQUIRED = [
  // SecondaryMarket: listing terms, round pacing, order intake, capacity, balance-delta intake checks
  ["SecondaryMarket.sol", "revert NotDao()"],
  ["SecondaryMarket.sol", "levels > MAX_LEVELS"],
  ["SecondaryMarket.sol", "span % levels"],
  ["SecondaryMarket.sol", "revert TooSoon("],
  ["SecondaryMarket.sol", "revert DaoCannotSell()"],
  ["SecondaryMarket.sol", "revert NoCapacity()"],
  ["SecondaryMarket.sol", "received != before + amount"],
  ["SecondaryMarket.sol", "received != before + escrow"],
  // one reentrancy entry per entrypoint, plus the modifier itself
  ["SecondaryMarket.sol", "function sell("],
  ["SecondaryMarket.sol", "function bid("],
  ["SecondaryMarket.sol", "function cancelSell("],
  ["SecondaryMarket.sol", "function cancelBid("],
  ["SecondaryMarket.sol", "function settle("],
  ["SecondaryMarket.sol", "function claimShares("],
  ["SecondaryMarket.sol", "function claimQuote("],
  ["SecondaryMarket.sol", "revert Reentrancy()"],
  // claim path
  ["SecondaryMarket.sol", "(r.settled || isVoid) &&"],
  ["SecondaryMarket.sol", "quoteIn[id] < amount"],
  ["SecondaryMarket.sol", "quoteIn[id] -= amount"],
  // SecondaryMarketFactory
  ["SecondaryMarketFactory.sol", "revert NotAuthorizedKit()"],
  ["SecondaryMarketFactory.sol", "revert AlreadyListed("],
  ["SecondaryMarketFactory.sol", "revert UnprovenDao()"],
  ["SecondaryMarketFactory.sol", "revert UnprovenQuote()"],
  ["SecondaryMarketFactory.sol", "votingWeight()"],
  ["SecondaryMarketFactory.sol", "_predictedShares(dao)"],
  ["SecondaryMarketFactory.sol", "policy.market()"],
  ["SecondaryMarketFactory.sol", "mandateFactory()"],
  // MolochPatched Shares: the market exemption and the sale ceiling
  ["MolochPatched.sol", "validator != address(0)"],
  ["MolochPatched.sol", "shares-transfer-exempt"],
  ["MolochPatched.sol", "IShareSalePolicy(policy).saleCapacity(from)"],
  // ActivationVoting
  ["ActivationVoting.sol", "revert MintToMarket()"],
  ["ActivationVoting.sol", "revert NotInCreationBlock()"],
  ["ActivationVoting.sol", "_escrowDeposit(from, amount)"],
  ["ActivationVoting.sol", "revert PreparedReturnMismatch()"],
  ["ActivationVoting.sol", "amount > pendSum + matureOwned"],
  ["ActivationVoting.sol", "revert MarketOnly()"],
  // ContributorKitV2: the read-backs and the input checks
  ["ContributorKitV2.sol", "tokens.transferExempt()"],
  ["ContributorKitV2.sol", "tokens.salePolicy()"],
  ["ContributorKitV2.sol", "version != 1"],
  ["ContributorKitV2.sol", "p.saleStart"],
  ["ContributorKitV2.sol", "p.saleCliff > p.saleDuration"],
  ["ContributorKitV2.sol", "p.lotSize > MAX_LOT_SIZE_BOUND"],
];

for (const [file, part] of REQUIRED) {
  test(`${file} has a mutation entry for ${part}`, () => {
    assert.ok(at(file, part).length >= 1, `no entry in scripts/contracts-mutation-check.mjs breaks ${part} in ${file}`);
  });
}

test("each secondary-market entry names the test files that must catch it", () => {
  const mine = entries.filter(mineOnly);
  assert.ok(mine.length > 0);
  for (const e of mine) {
    assert.ok(Array.isArray(e.tests) && e.tests.length > 0, `${e.name}: no test files named`);
    for (const t of e.tests) assert.ok(existsSync(join(dirname(SCRIPT), "..", "contracts", t)), `${e.name}: ${t} missing`);
  }
});

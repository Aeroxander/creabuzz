// Claimable-position derivation + the token-share representation binding.
//
// Derivation (hermit env: `. ./bin/activate-hermit`, `cast 1.4.3-stable`):
//
//   cast sig 'shares()'          -> 0x03314efa
//   cast sig 'loot()'            -> 0x9b7b2ab0
//   cast sig 'balanceOf(address)'-> 0x70a08231
//   cast sig 'totalSupply()'     -> 0x18160ddd
//   cast sig 'ragequittable()'   -> 0x14a6d7de
//
// Representation finding being bound here (READ the assertion names):
// majeur shares/loot are ERC-20-ish TOKENS (`Moloch.sol:1052` `contract
// Shares`, `balanceOf` mapping + `totalSupply`; `contract Loot` at 1606) —
// the position reads are `balanceOf`/`totalSupply` on the `shares()`/`loot()`
// addresses, NOT a scan of kind:37011 events. The derivation mirrors
// `Moloch.sol:772-793` exactly: `total = sharesTotal + lootTotal` before the
// burn, `due = pool * amt / total` floor per token, ETH pool = the DAO's
// balance.
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHolderBalanceReads,
  buildRagequitReads,
  decodeAddress,
  deriveClaimablePosition,
  overdrawsPosition,
  SELECTOR_BALANCE_OF,
  SELECTOR_LOOT,
  SELECTOR_RAGEQUITTABLE,
  SELECTOR_SHARES,
  SELECTOR_TOTAL_SUPPLY,
} from "./ragequit-position.ts";
import { ETH_TOKEN } from "./ragequit-tx.ts";

const DAO = `0x${"da".repeat(20)}`;
const HOLDER = `0x${"22".repeat(20)}`;
const SHARES_TK = `0x${"aa".repeat(20)}`;
const LOOT_TK = `0x${"bb".repeat(20)}`;
const ERC20 = `0x${"cc".repeat(20)}`;

function word(value) {
  return value.toString(16).padStart(64, "0");
}

test("the read vocabulary is the pinned token representation (cast sig goldens)", () => {
  assert.equal(SELECTOR_SHARES, "0x03314efa");
  assert.equal(SELECTOR_LOOT, "0x9b7b2ab0");
  assert.equal(SELECTOR_BALANCE_OF, "0x70a08231");
  assert.equal(SELECTOR_TOTAL_SUPPLY, "0x18160ddd");
  assert.equal(SELECTOR_RAGEQUITTABLE, "0x14a6d7de");
});

test("position reads are balanceOf/totalSupply on TOKEN addresses — not 37011 events", () => {
  const reads = buildRagequitReads(DAO, [ETH_TOKEN, ERC20]);
  const byName = new Map(reads.map((r) => [r.name + (r.token ?? ""), r]));

  assert.equal(
    byName.get("shares")?.data,
    SELECTOR_SHARES,
    "the shares token address comes from the DAO's shares() getter",
  );
  assert.equal(byName.get("loot")?.data, SELECTOR_LOOT);
  assert.equal(byName.get("shares-total")?.to, DAO);
  assert.equal(byName.get("shares-total")?.data, SELECTOR_TOTAL_SUPPLY);
  assert.equal(byName.get("loot-total")?.data, SELECTOR_TOTAL_SUPPLY);

  // The ERC-20 pool read is the DAO's own balanceOf (Moloch.sol:1999).
  const pool = byName.get(`pool${ERC20}`);
  assert.equal(pool?.to, ERC20, "pool reads hit the token contract");
  assert.equal(
    pool?.data,
    `${SELECTOR_BALANCE_OF}${DAO.slice(2).toLowerCase().padStart(64, "0")}`,
  );

  const ethPool = byName.get(`pool${ETH_TOKEN}`);
  assert.ok(ethPool, "the ETH sentinel must be part of the reads");
  assert.equal(ethPool.to, DAO, "the ETH pool is the DAO's own balance");
});

test("holder balances are balanceOf reads on the shares/loot token addresses", () => {
  const [shares, loot] = buildHolderBalanceReads(SHARES_TK, LOOT_TK, HOLDER);
  assert.equal(shares.to, SHARES_TK);
  assert.equal(loot.to, LOOT_TK);
  const holderWord = HOLDER.slice(2).toLowerCase().padStart(64, "0");
  assert.equal(shares.data, `${SELECTOR_BALANCE_OF}${holderWord}`);
  assert.equal(loot.data, `${SELECTOR_BALANCE_OF}${holderWord}`);
});

test("decodeAddress reads the low 20 bytes of a return word", () => {
  assert.equal(
    decodeAddress(`0x${word(0n).slice(0, 24)}${SHARES_TK.slice(2)}`),
    SHARES_TK,
  );
});

test("full-shares exit: due = pool * shares / (sharesTotal + lootTotal)", () => {
  const rows = deriveClaimablePosition({
    sharesToBurn: 100n,
    lootToBurn: 0n,
    sharesBalance: 100n,
    lootBalance: 0n,
    sharesTotal: 1000n,
    lootTotal: 500n, // loot counts in the denominator (Moloch.sol:772)
    pools: [
      { token: ETH_TOKEN, pool: 300n },
      { token: ERC20, pool: 7n },
    ],
  });
  // total = 1500, amt = 100 → 1/15 of each pool, floored.
  assert.deepEqual(rows, [
    { token: ETH_TOKEN, pool: 300n, due: 20n }, // 300*100/1500
    { token: ERC20, pool: 7n, due: 0n }, // 7*100/1500 = 0.46 → floor 0
  ]);
});

test("partial burns prorate against the same pre-burn denominator", () => {
  const rows = deriveClaimablePosition({
    sharesToBurn: 250n,
    lootToBurn: 250n,
    sharesBalance: 250n,
    lootBalance: 250n,
    sharesTotal: 1000n,
    lootTotal: 1000n,
    pools: [{ token: ETH_TOKEN, pool: 1000n }],
  });
  // amt = 500, total = 2000 → quarter of the pool.
  assert.equal(rows[0].due, 250n);
});

test("zero supply claims zero — the chain's mulDiv(…, 0) must never be reached", () => {
  const rows = deriveClaimablePosition({
    sharesToBurn: 5n,
    lootToBurn: 0n,
    sharesBalance: 5n,
    lootBalance: 0n,
    sharesTotal: 0n,
    lootTotal: 0n,
    pools: [{ token: ETH_TOKEN, pool: 100n }],
  });
  assert.equal(rows[0].due, 0n);
});

test("a zero burn claims zero (NotOk would revert onchain)", () => {
  const rows = deriveClaimablePosition({
    sharesToBurn: 0n,
    lootToBurn: 0n,
    sharesBalance: 10n,
    lootBalance: 10n,
    sharesTotal: 100n,
    lootTotal: 100n,
    pools: [{ token: ETH_TOKEN, pool: 100n }],
  });
  assert.equal(rows[0].due, 0n);
});

test("overdraw detection flags burns above the holder's own position", () => {
  const base = {
    sharesToBurn: 11n,
    lootToBurn: 1n,
    sharesBalance: 10n,
    lootBalance: 0n,
    sharesTotal: 100n,
    lootTotal: 100n,
    pools: [],
  };
  assert.equal(overdrawsPosition(base), true);
  assert.equal(
    overdrawsPosition({ ...base, sharesToBurn: 10n, lootToBurn: 0n }),
    false,
  );
});

test("floor rounding never overpays — a full-exit due is bounded by the pool", () => {
  const rows = deriveClaimablePosition({
    sharesToBurn: 3n,
    lootToBurn: 0n,
    sharesBalance: 3n,
    lootBalance: 0n,
    sharesTotal: 7n,
    lootTotal: 0n,
    pools: [{ token: ETH_TOKEN, pool: 10n }],
  });
  assert.equal(rows[0].due, 4n); // 10*3/7 = 4.28… → 4
  assert.ok(rows[0].due <= rows[0].pool);
});

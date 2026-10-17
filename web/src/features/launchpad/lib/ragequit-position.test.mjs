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
  buildLockedOfRead,
  buildLockGuardRead,
  buildRagequitReads,
  buildSupplyReads,
  burnableShares,
  decodeAddress,
  decodeSymbol,
  deriveClaimablePosition,
  exitDenominator,
  overdrawsPosition,
  SELECTOR_BALANCE_OF,
  SELECTOR_LOCK_GUARD,
  SELECTOR_LOCKED_OF,
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
  assert.equal(SELECTOR_LOCK_GUARD, "0x36bc529d"); // cast sig 'lockGuard()'
  assert.equal(SELECTOR_LOCKED_OF, "0xa5f1e282"); // cast sig 'lockedOf(address)'
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
  // The supply is a read on the TOKENS, whose addresses only the DAO's answers give: it is not part of this first pass,
  // and above all it is never asked of the DAO itself (which has no totalSupply(): the whole read reverted).
  assert.equal(byName.get("shares-total"), undefined);
  assert.equal(byName.get("loot-total"), undefined);
  const [sharesTotal, lootTotal] = buildSupplyReads(SHARES_TK, LOOT_TK);
  assert.equal(sharesTotal.to, SHARES_TK);
  assert.equal(sharesTotal.data, SELECTOR_TOTAL_SUPPLY);
  assert.equal(lootTotal.to, LOOT_TK);
  assert.equal(lootTotal.data, SELECTOR_TOTAL_SUPPLY);

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

test("holder and DAO balances are balanceOf reads on the shares/loot token addresses", () => {
  const reads = buildHolderBalanceReads(SHARES_TK, LOOT_TK, HOLDER, DAO);
  const byName = new Map(reads.map((r) => [r.name, r]));
  const holderWord = HOLDER.slice(2).toLowerCase().padStart(64, "0");
  const daoWord = DAO.slice(2).toLowerCase().padStart(64, "0");
  assert.equal(byName.get("holder-shares")?.to, SHARES_TK);
  assert.equal(byName.get("holder-loot")?.to, LOOT_TK);
  assert.equal(
    byName.get("holder-shares")?.data,
    `${SELECTOR_BALANCE_OF}${holderWord}`,
  );
  assert.equal(
    byName.get("holder-loot")?.data,
    `${SELECTOR_BALANCE_OF}${holderWord}`,
  );
  // The patched exit takes the DAO's own Shares and Loot out of the
  // denominator, so the preview has to read them.
  assert.equal(byName.get("dao-shares")?.to, SHARES_TK);
  assert.equal(byName.get("dao-loot")?.to, LOOT_TK);
  assert.equal(
    byName.get("dao-shares")?.data,
    `${SELECTOR_BALANCE_OF}${daoWord}`,
  );
  assert.equal(
    byName.get("dao-loot")?.data,
    `${SELECTOR_BALANCE_OF}${daoWord}`,
  );
});

test("the lock reads are lockGuard() on the Shares token, then lockedOf(holder) on the guard", () => {
  const guardRead = buildLockGuardRead(SHARES_TK);
  assert.equal(guardRead.to, SHARES_TK);
  assert.equal(guardRead.data, SELECTOR_LOCK_GUARD);
  const lockedRead = buildLockedOfRead(ERC20, HOLDER);
  assert.equal(lockedRead.to, ERC20);
  assert.equal(
    lockedRead.data,
    `${SELECTOR_LOCKED_OF}${HOLDER.slice(2).toLowerCase().padStart(64, "0")}`,
  );
});

test("Shares the DAO holds itself leave the denominator (ragequit-excludes-treasury-shares)", () => {
  // 1000 Shares outstanding, 760 of them the DAO's own: a member with 100
  // takes 100/240 of each pool, not 100/1000.
  const input = {
    sharesToBurn: 100n,
    lootToBurn: 0n,
    sharesBalance: 100n,
    lootBalance: 0n,
    sharesTotal: 1000n,
    lootTotal: 0n,
    daoHeld: 760n,
    pools: [{ token: ETH_TOKEN, pool: 2400n }],
  };
  assert.equal(exitDenominator(input), 240n);
  assert.equal(deriveClaimablePosition(input)[0].due, 1000n); // 2400*100/240
  // The old denominator would have paid 240 — a quarter of the truth here.
  assert.notEqual(deriveClaimablePosition(input)[0].due, 240n);
});

test("loot the DAO holds also leaves the denominator", () => {
  const input = {
    sharesToBurn: 50n,
    lootToBurn: 0n,
    sharesBalance: 50n,
    lootBalance: 0n,
    sharesTotal: 100n,
    lootTotal: 100n,
    daoHeld: 100n,
    pools: [{ token: ETH_TOKEN, pool: 1000n }],
  };
  assert.equal(exitDenominator(input), 100n);
  assert.equal(deriveClaimablePosition(input)[0].due, 500n);
});

test("when only the DAO holds anything the denominator is zero and nothing is claimed", () => {
  const input = {
    sharesToBurn: 1n,
    lootToBurn: 0n,
    sharesBalance: 1n,
    lootBalance: 0n,
    sharesTotal: 100n,
    lootTotal: 0n,
    daoHeld: 100n,
    pools: [{ token: ETH_TOKEN, pool: 1000n }],
  };
  assert.equal(exitDenominator(input), 0n);
  assert.equal(deriveClaimablePosition(input)[0].due, 0n);
});

test("only unlocked Shares can be burned (the patched burn refuses to dip into the lock)", () => {
  assert.equal(burnableShares(100n, 0n), 100n);
  assert.equal(burnableShares(100n, 40n), 60n);
  assert.equal(burnableShares(100n, 100n), 0n);
  // A lock larger than the balance (balance moved out) leaves nothing, never a negative.
  assert.equal(burnableShares(100n, 250n), 0n);
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
    daoHeld: 0n,
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
    daoHeld: 0n,
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
    daoHeld: 0n,
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
    daoHeld: 0n,
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
    daoHeld: 0n,
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
    daoHeld: 0n,
    pools: [{ token: ETH_TOKEN, pool: 10n }],
  });
  assert.equal(rows[0].due, 4n); // 10*3/7 = 4.28… → 4
  assert.ok(rows[0].due <= rows[0].pool);
});

test("a token's symbol is read from either answer an ERC-20 gives", () => {
  const name = (text) =>
    Buffer.from(text, "utf8").toString("hex").padEnd(64, "0");
  // The dynamic-string form: offset, length, padded bytes.
  assert.equal(
    decodeSymbol(`0x${word(32n)}${word(4n)}${name("USDC")}`),
    "USDC",
  );
  // The older fixed 32-byte form.
  assert.equal(decodeSymbol(`0x${name("MKR")}`), "MKR");
  // Neither: no symbol, never garbage.
  assert.equal(decodeSymbol("0x"), null);
  assert.equal(decodeSymbol(`0x${word(32n)}${word(0n)}`), null);
});

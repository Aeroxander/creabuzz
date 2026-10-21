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
  buildTotalLockedRead,
  buildSupplyReads,
  burnableShares,
  decodeAddress,
  decodeSymbol,
  deriveClaimablePosition,
  exitDenominator,
  fetchRagequitPosition,
  overdrawsPosition,
  SELECTOR_BALANCE_OF,
  SELECTOR_LOCK_GUARD,
  SELECTOR_LOCKED_OF,
  SELECTOR_LOOT,
  SELECTOR_RAGEQUITTABLE,
  SELECTOR_SHARES,
  SELECTOR_TOTAL_LOCKED,
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
  assert.equal(SELECTOR_TOTAL_LOCKED, "0x56891412"); // cast sig 'totalLocked()'
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

test("Shares a milestone lock still holds back leave the denominator too (D72)", () => {
  // 1000 Shares: the DAO holds 300, the team's 240 are still locked. A backer
  // with 180 takes 180 of the 460 that can leave, not 180 of 700.
  const input = {
    sharesToBurn: 180n,
    lootToBurn: 0n,
    sharesBalance: 180n,
    lootBalance: 0n,
    sharesTotal: 1000n,
    lootTotal: 0n,
    daoHeld: 300n,
    lockedTotal: 240n,
    pools: [{ token: ETH_TOKEN, pool: 800n }],
  };
  assert.equal(exitDenominator(input), 460n);
  assert.equal(deriveClaimablePosition(input)[0].due, 313n); // floor(800*180/460)
});

test("a locked total above what can leave claims nothing, as the chain refuses it", () => {
  const input = {
    sharesToBurn: 10n,
    lootToBurn: 0n,
    sharesBalance: 10n,
    lootBalance: 0n,
    sharesTotal: 100n,
    lootTotal: 0n,
    daoHeld: 50n,
    lockedTotal: 60n,
    pools: [{ token: ETH_TOKEN, pool: 1000n }],
  };
  assert.equal(exitDenominator(input), 0n);
  assert.equal(deriveClaimablePosition(input)[0].due, 0n);
});

test("the locked total is totalLocked() on the guard", () => {
  const guard = `0x${"ee".repeat(20)}`;
  const read = buildTotalLockedRead(guard);
  assert.equal(read.to, guard);
  assert.equal(read.data, SELECTOR_TOTAL_LOCKED);
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
    lockedTotal: 0n,
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
    lockedTotal: 0n,
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
    lockedTotal: 0n,
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
    lockedTotal: 0n,
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
    lockedTotal: 0n,
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
    lockedTotal: 0n,
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
    lockedTotal: 0n,
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
    lockedTotal: 0n,
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
    lockedTotal: 0n,
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

// ---------------------------------------------------------------------------
// The fetcher against a chain, including DAOs and locks made before D72
// ---------------------------------------------------------------------------

const LOCK = `0x${"1c".repeat(20)}`;
const USDC = `0x${"cc".repeat(20)}`;
const ENDPOINT = "http://chain.test";
const addrWord = (a) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
const u = (n) => `0x${word(BigInt(n))}`;

/**
 * A DAO with 1,000 Shares: 100 its own, 300 the team's (240 still locked; the founder holds 200 of them, 160 locked),
 * 600 the backers', and 650 USDC in its treasury. `over` adds or removes answers (null removes: the call reverts).
 */
function daoChain(over = {}) {
  const answers = {
    [`${DAO} ${SELECTOR_RAGEQUITTABLE}`]: u(1),
    [`${DAO} ${SELECTOR_SHARES}`]: addrWord(SHARES_TK),
    [`${DAO} ${SELECTOR_LOOT}`]: addrWord(LOOT_TK),
    [`${DAO} 0xaf56f7dc`]: u(0), // leaving(): a DAO made after D72
    [`${USDC} ${SELECTOR_BALANCE_OF}`]: u(650),
    [`${SHARES_TK} ${SELECTOR_TOTAL_SUPPLY}`]: u(1000),
    [`${LOOT_TK} ${SELECTOR_TOTAL_SUPPLY}`]: u(0),
    [`${SHARES_TK} ${SELECTOR_BALANCE_OF}${word(BigInt(HOLDER))}`]: u(200),
    [`${LOOT_TK} ${SELECTOR_BALANCE_OF}${word(BigInt(HOLDER))}`]: u(0),
    [`${SHARES_TK} ${SELECTOR_BALANCE_OF}${word(BigInt(DAO))}`]: u(100),
    [`${LOOT_TK} ${SELECTOR_BALANCE_OF}${word(BigInt(DAO))}`]: u(0),
    [`${SHARES_TK} ${SELECTOR_LOCK_GUARD}`]: addrWord(LOCK),
    [`${LOCK} ${SELECTOR_LOCKED_OF}`]: u(160),
    [`${LOCK} ${SELECTOR_TOTAL_LOCKED}`]: u(240),
    ...over,
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const { to, data } = body.params[0];
    const exact = answers[`${to.toLowerCase()} ${data}`];
    const answer =
      exact !== undefined
        ? exact
        : answers[`${to.toLowerCase()} ${data.slice(0, 10)}`];
    const reply =
      answer instanceof Error
        ? { error: { code: -32000, message: answer.message } }
        : answer === undefined || answer === null
          ? { error: { code: 3, message: "execution reverted" } }
          : { result: answer };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...reply }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return () => {
    globalThis.fetch = original;
  };
}

test("a DAO made after D72 leaves the Shares still locked out of its exit", async () => {
  const restore = daoChain();
  try {
    const position = await fetchRagequitPosition(ENDPOINT, DAO, HOLDER, [USDC]);
    assert.equal(position.exitRule, "current");
    assert.equal(position.lockedTotal, 240n);
    assert.equal(position.sharesBurnable, 40n);
    // 1000 − 100 the DAO's − 240 locked = 660 count; 40 of them take 650 × 40 / 660.
    assert.equal(position.rows[0].due, (650n * 40n) / 660n);
  } finally {
    restore();
  }
});

test("a DAO and lock made before D72 still get an exit preview, worked out the way their exit pays", async () => {
  // Neither the lock's `totalLocked()` nor the DAO's `leaving()` exists yet: that DAO's exit counts locked Shares.
  const restore = daoChain({
    [`${LOCK} ${SELECTOR_TOTAL_LOCKED}`]: null,
    [`${DAO} 0xaf56f7dc`]: null,
  });
  try {
    const position = await fetchRagequitPosition(ENDPOINT, DAO, HOLDER, [USDC]);
    assert.equal(position.exitRule, "legacy");
    assert.equal(
      position.lockedTotal,
      0n,
      "the old exit leaves nothing locked out",
    );
    assert.equal(position.sharesBurnable, 40n);
    // 1000 − 100 the DAO's = 900 count; 40 of them take 650 × 40 / 900.
    assert.equal(position.rows[0].due, (650n * 40n) / 900n);
  } finally {
    restore();
  }
});

test("a DAO made after D72 with a lock that cannot say what it holds is unknown, not a figure", async () => {
  // That DAO's exit asks the lock and is refused, so nothing it would pay can be worked out.
  const restore = daoChain({ [`${LOCK} ${SELECTOR_TOTAL_LOCKED}`]: null });
  try {
    const position = await fetchRagequitPosition(ENDPOINT, DAO, HOLDER, [USDC]);
    assert.equal(position.exitRule, "unknown");
  } finally {
    restore();
  }
});

test("a network failure reading the lock is an error, never a smaller or larger exit", async () => {
  const restore = daoChain({
    [`${LOCK} ${SELECTOR_TOTAL_LOCKED}`]: new Error("header not found"),
  });
  try {
    await assert.rejects(fetchRagequitPosition(ENDPOINT, DAO, HOLDER, [USDC]));
  } finally {
    restore();
  }
});

/**
 * The connected account's ragequit position — what an exit would pay out.
 *
 * Share representation answer (derived from the vendored majeur source, not
 * assumed): shares and loot are **ERC-20-ish tokens**, not event-ledger
 * ownership. `contracts/lib/majeur/src/Moloch.sol:1052` declares
 * `contract Shares` with `mapping(address => uint256) public balanceOf` and
 * `uint256 public totalSupply` (line 1067), mirrored by `contract Loot`
 * (line 1606); the DAO exposes them via `shares()` / `loot()` getters and the
 * exit burns via `burnFromMoloch` (Moloch.sol:776-777). So the position read
 * is plain `balanceOf` + `totalSupply` on those two token addresses — the
 * same read vocabulary as any ERC-20 — and NOT a scan of kind:37011 grant
 * events. (37011 grants are the org plane's delegation record; nothing in the
 * majeur ragequit path reads them.)
 *
 * Claimable derivation — `Moloch.sol:772-793`, verbatim, plus the Creaton
 * patch `ragequit-excludes-treasury-shares` (MolochPatched.sol):
 *
 *   total = shares.totalSupply() + loot.totalSupply()      // BEFORE the burn
 *   total -= shares.balanceOf(dao) + loot.balanceOf(dao)   // patch: the DAO's own
 *   total -= lockGuard.totalLocked()                        // patch (D72): Shares still locked
 *   amt   = sharesToBurn + lootToBurn
 *   pool  = tk == address(0) ? dao.balance : balanceOfThis(tk)
 *   due   = mulDiv(pool, amt, total)                        // floor
 *   due  -= mulDiv(due, fee, 10_000)                        // patch (D135): the exit fee stays
 *                                                           //   (none for the last units that can leave, D136)
 *
 * The fee is the one the DAO's funding terms set (`exitFeeOf(dao)`, zero without terms or while they are under
 * notice), read through `votingWeight() -> mandateFactory() -> fundingTerms()` as the exit itself reads it.
 *
 * DAOs and locks made before D72 have no `totalLocked()`, and their exit never
 * subtracted it: for them the preview uses the old total (`exitRule: "legacy"`).
 * A DAO made after D72 whose lock cannot answer is `"unknown"`: its exit asks
 * the lock and is refused, so nothing here says what it would pay.
 *
 * Shares a holder has not yet earned (the milestone lock guard) cannot be
 * burned: `burnFromMoloch` reverts `LockedShares` unless the balance covers the
 * burn plus the locked amount, so the exit burns `balance - lockedOf(holder)`.
 *
 * `balanceOfThis(tk)` is the token's `balanceOf(dao)` (Moloch.sol:1999), so
 * the pools are reads of the DAO's own balances. ETH is the zero-address
 * sentinel read via `eth_getBalance`.
 *
 * Reads are composed here (pure) and executed thinly against the launchpad
 * RPC seam (`../chain.ts`); the composed call bytes are selector-bound in
 * `ragequit-position.test.mjs` to `cast sig` goldens recorded there.
 */
import { decodeU256, ethCall, ethGetBalance } from "../chain.ts";
import type { TokenInfo } from "./exit-tokens.ts";
import { ETH_TOKEN } from "./ragequit-tx.ts";

/** `cast sig` goldens (recorded in `ragequit-position.test.mjs`). */
export const SELECTOR_SHARES = "0x03314efa"; // shares()
export const SELECTOR_LOOT = "0x9b7b2ab0"; // loot()
export const SELECTOR_BALANCE_OF = "0x70a08231"; // balanceOf(address)
export const SELECTOR_TOTAL_SUPPLY = "0x18160ddd"; // totalSupply()
export const SELECTOR_RAGEQUITTABLE = "0x14a6d7de"; // ragequittable()
const SELECTOR_DECIMALS = "0x313ce567"; // decimals()
const SELECTOR_SYMBOL = "0x95d89b41"; // symbol()
export const SELECTOR_LOCK_GUARD = "0x36bc529d"; // lockGuard()
export const SELECTOR_LOCKED_OF = "0xa5f1e282"; // lockedOf(address)
export const SELECTOR_TOTAL_LOCKED = "0x56891412"; // totalLocked()
const SELECTOR_LEAVING = "0xaf56f7dc"; // leaving() — only DAOs made after D72/D73 have it
export const SELECTOR_VOTING_WEIGHT = "0x6f533638"; // votingWeight()
export const SELECTOR_MANDATE_FACTORY = "0xb04b7bdb"; // mandateFactory()
export const SELECTOR_FUNDING_TERMS = "0xb881228a"; // fundingTerms()
export const SELECTOR_EXIT_FEE_OF = "0xecdc9f59"; // exitFeeOf(address)

function addressWord(address: string): string {
  return address.toLowerCase().slice(2).padStart(64, "0");
}

/** Decode an `address` return word. */
export function decodeAddress(hex: string): string {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (body.length < 64) {
    throw new Error(`ragequit-position: expected a 32-byte word, got ${hex}`);
  }
  return `0x${body.slice(24, 64).toLowerCase()}`;
}

/**
 * Decode an ERC-20 `symbol()` answer: a dynamic string, or the 32-byte word some older tokens return instead. Null when
 * it is neither, so the caller can keep a neutral word instead of printing garbage.
 */
export function decodeSymbol(hex: string): string | null {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  const text = (bytes: string): string | null => {
    const pairs = bytes.match(/../g) ?? [];
    const chars = pairs
      .map((pair) => Number.parseInt(pair, 16))
      .filter((code) => code !== 0);
    if (chars.length === 0 || chars.some((c) => c < 0x20 || c > 0x7e)) {
      return null;
    }
    return String.fromCharCode(...chars);
  };
  if (body.length >= 128) {
    const length = Number(BigInt(`0x${body.slice(64, 128)}`));
    if (length > 0 && length <= 32 && body.length >= 128 + length * 2) {
      return text(body.slice(128, 128 + length * 2));
    }
  }
  if (body.length === 64) return text(body);
  return null;
}

/**
 * A token's symbol and decimals. Either is null when the token did not answer: callers then show raw units rather than
 * inventing a scale (an unreadable six-decimal token read as 18 decimals prints a trillion times too small).
 */
export async function fetchTokenInfo(
  endpoint: string,
  token: string,
): Promise<TokenInfo> {
  let decimals: number | null = null;
  let symbol: string | null = null;
  try {
    const d = decodeU256(await ethCall(endpoint, token, SELECTOR_DECIMALS));
    if (d <= 36n) decimals = Number(d);
  } catch {
    // Left unknown: shown as raw units.
  }
  try {
    symbol = decodeSymbol(await ethCall(endpoint, token, SELECTOR_SYMBOL));
  } catch {
    // Left unknown.
  }
  return { symbol, decimals };
}

/** One composed view call: `{ name, to, data }`, executed by the fetcher. */
export interface RagequitRead {
  name:
    | "ragequittable"
    | "shares"
    | "loot"
    | "holder-shares"
    | "holder-loot"
    | "dao-shares"
    | "dao-loot"
    | "shares-total"
    | "loot-total"
    | "lock-guard"
    | "locked-of"
    | "total-locked"
    | "pool";
  to: string;
  data: string;
  /** For `pool` reads: the token the pool is denominated in. */
  token?: string;
}

/**
 * Compose the chain-state reads the position needs. Pure — the fetcher
 * executes these bytes unchanged, and the test binds them to the pinned
 * selectors.
 */
export function buildRagequitReads(
  dao: string,
  tokens: readonly string[],
): RagequitRead[] {
  const target = dao.toLowerCase();
  const reads: RagequitRead[] = [
    { name: "ragequittable", to: target, data: SELECTOR_RAGEQUITTABLE },
    { name: "shares", to: target, data: SELECTOR_SHARES },
    { name: "loot", to: target, data: SELECTOR_LOOT },
  ];
  for (const token of tokens) {
    const tk = token.toLowerCase();
    if (tk === ETH_TOKEN) {
      reads.push({ name: "pool", to: target, data: "", token: tk });
      continue;
    }
    // balanceOf(dao) — Moloch.sol:1999 balanceOfThis(tk).
    reads.push({
      name: "pool",
      to: tk,
      data: `${SELECTOR_BALANCE_OF}${addressWord(target)}`,
      token: tk,
    });
  }
  return reads;
}

/**
 * How many Shares and Loot exist: `totalSupply()` on the two TOKEN contracts, whose addresses are only known once the
 * DAO has answered `shares()` and `loot()`. (These were once sent to the DAO itself, which has no such function, so the
 * whole position read reverted.)
 */
export function buildSupplyReads(
  sharesToken: string,
  lootToken: string,
): RagequitRead[] {
  return [
    {
      name: "shares-total",
      to: sharesToken.toLowerCase(),
      data: SELECTOR_TOTAL_SUPPLY,
    },
    {
      name: "loot-total",
      to: lootToken.toLowerCase(),
      data: SELECTOR_TOTAL_SUPPLY,
    },
  ];
}

/**
 * The holder's share/loot balances and the DAO's own — composed against the
 * token addresses. The DAO's balances leave the exit denominator.
 */
export function buildHolderBalanceReads(
  sharesToken: string,
  lootToken: string,
  holder: string,
  dao: string,
): RagequitRead[] {
  const who = addressWord(holder);
  const self = addressWord(dao);
  const shares = sharesToken.toLowerCase();
  const loot = lootToken.toLowerCase();
  return [
    { name: "holder-shares", to: shares, data: `${SELECTOR_BALANCE_OF}${who}` },
    { name: "holder-loot", to: loot, data: `${SELECTOR_BALANCE_OF}${who}` },
    { name: "dao-shares", to: shares, data: `${SELECTOR_BALANCE_OF}${self}` },
    { name: "dao-loot", to: loot, data: `${SELECTOR_BALANCE_OF}${self}` },
  ];
}

/** `lockGuard()` on the Shares token (zero address = no guard set). */
export function buildLockGuardRead(sharesToken: string): RagequitRead {
  return {
    name: "lock-guard",
    to: sharesToken.toLowerCase(),
    data: SELECTOR_LOCK_GUARD,
  };
}

/** `lockedOf(holder)` on the lock guard. */
export function buildLockedOfRead(guard: string, holder: string): RagequitRead {
  return {
    name: "locked-of",
    to: guard.toLowerCase(),
    data: `${SELECTOR_LOCKED_OF}${addressWord(holder)}`,
  };
}

/** `totalLocked()` on the lock guard: every Share it still holds back, which the exit leaves out (D72). */
export function buildTotalLockedRead(guard: string): RagequitRead {
  return {
    name: "total-locked",
    to: guard.toLowerCase(),
    data: SELECTOR_TOTAL_LOCKED,
  };
}

/**
 * What the holder can actually burn: the balance minus whatever the lock guard
 * still holds back (the patched Shares refuse a burn that would dip into it).
 */
export function burnableShares(balance: bigint, locked: bigint): bigint {
  return locked >= balance ? 0n : balance - locked;
}

/** What one token would pay out on exit. */
export interface ClaimableRow {
  /** Token address; {@link ETH_TOKEN} for ETH. */
  token: string;
  /** The DAO's balance of `token` (the pool). */
  pool: bigint;
  /**
   * What `sharesToBurn + lootToBurn` takes from `pool` right now, after the exit fee
   * (`mulDiv(pool, amt, total)`, floor — Moloch.sol:791 — less {@link afterExitFee}'s part).
   */
  due: bigint;
  /** What the exit fee leaves in the treasury out of this pool's share. */
  fee: bigint;
}

export interface PositionInput {
  /** Shares to burn. */
  sharesToBurn: bigint;
  /** Loot to burn. */
  lootToBurn: bigint;
  /** The holder's shares balance. */
  sharesBalance: bigint;
  /** The holder's loot balance. */
  lootBalance: bigint;
  /** `shares.totalSupply()` before the burn. */
  sharesTotal: bigint;
  /** `loot.totalSupply()` before the burn. */
  lootTotal: bigint;
  /**
   * Shares + loot the DAO holds itself. The patched exit leaves them out of
   * the denominator, so they never shrink a member's payout.
   */
  daoHeld: bigint;
  /**
   * Every Share the milestone lock still holds back (`totalLocked()`, zero with no lock). They can never leave yet, so
   * the patched exit leaves them out of the denominator too (D72).
   */
  lockedTotal: bigint;
  /** Per-token DAO pools (token address → balance). */
  pools: ReadonlyArray<{ token: string; pool: bigint }>;
  /** The exit fee in basis points (`exitFeeOf(dao)`, D135); none when left out. */
  exitFeeBps?: bigint;
}

/** What the exit fee (in basis points) leaves in the treasury out of `due`: rounded down, as the chain does. */
export function exitFeePart(due: bigint, feeBps: bigint): bigint {
  return feeBps === 0n ? 0n : (due * feeBps) / 10_000n;
}

/**
 * The exit denominator: everything outstanding except what the DAO holds and what the lock still holds back. A locked
 * total above what is left makes the chain refuse the exit; here it claims nothing.
 */
export function exitDenominator(input: PositionInput): bigint {
  const outstanding = input.sharesTotal + input.lootTotal;
  const left = input.daoHeld >= outstanding ? 0n : outstanding - input.daoHeld;
  return input.lockedTotal >= left ? 0n : left - input.lockedTotal;
}

/**
 * Pure claimable derivation (Moloch.sol:772-793 and the treasury-shares
 * patch). Floor-division; a zero denominator claims zero (the chain's `div(0)`
 * would revert inside `mulDiv` — the UI never sends a call in that state).
 */
export function deriveClaimablePosition(input: PositionInput): ClaimableRow[] {
  const total = exitDenominator(input);
  const amt = input.sharesToBurn + input.lootToBurn;
  // The last units that can leave leave no one to keep a fee (D136).
  const feeBps = amt >= total ? 0n : (input.exitFeeBps ?? 0n);
  return input.pools.map(({ token, pool }) => {
    const whole = total === 0n || amt === 0n ? 0n : (pool * amt) / total;
    const fee = exitFeePart(whole, feeBps);
    return { token, pool, due: whole - fee, fee };
  });
}

/**
 * True when leaving now pays nothing: every currency the exit names comes to zero for this holder (an empty treasury, or
 * a share too small to round to one unit). The exit still destroys the Shares, so the screen must say so and ask (D144).
 */
export function exitPaysNothing(rows: readonly ClaimableRow[]): boolean {
  return rows.every((row) => row.due === 0n);
}

/** True when the burn inputs exceed the holder's own position. */
export function overdrawsPosition(input: PositionInput): boolean {
  return (
    input.sharesToBurn > input.sharesBalance ||
    input.lootToBurn > input.lootBalance
  );
}

/**
 * How the DAO's exit counts the Shares its lock still holds back. `current`: left out of the total (D72). `legacy`: a DAO
 * made before D72 counts them, so the preview does too. `unknown`: the DAO leaves them out but its lock does not say how
 * many, so its exit refuses to run and no figure can be given.
 */
type ExitRule = "current" | "legacy" | "unknown";

/** A contract that does not have the function: the call reverts, or answers nothing. A network failure is not one. */
export function isRefusal(error: unknown): boolean {
  return (
    error instanceof Error &&
    (/revert/i.test(error.message) ||
      error.message === "expected 32-byte return")
  );
}

/** The position as the UI shows it. */
export interface RagequitPosition {
  /** `ragequittable()` — false means the exit reverts with `NotOk()`. */
  ragequittable: boolean;
  /** The shares token address (`shares()`). */
  sharesToken: string;
  /** The loot token address (`loot()`). */
  lootToken: string;
  sharesBalance: bigint;
  /** Shares the lock guard still holds back (milestone-locked team Shares). */
  sharesLocked: bigint;
  /** Shares an exit can burn: the balance minus the locked amount. */
  sharesBurnable: bigint;
  lootBalance: bigint;
  sharesTotal: bigint;
  lootTotal: bigint;
  /** Shares + loot the DAO holds itself (outside the exit denominator). */
  daoHeld: bigint;
  /**
   * Every Share the lock still holds back, across the team, that the exit leaves out of its denominator (D72). Zero for a
   * `legacy` DAO, whose exit counts them.
   */
  lockedTotal: bigint;
  /** How this DAO's exit counts locked Shares; with `unknown` the rows are not what an exit would pay. */
  exitRule: ExitRule;
  /** The exit fee leaving pays now, in basis points (D135): zero without funding terms or while they are under notice. */
  exitFeeBps: bigint;
  /** Whether this exit pays it: not when it takes every unit that can leave (D136). */
  feeApplies: boolean;
  /** Pools + claimable rows for a full exit of the burnable Shares (loot untouched). */
  rows: ClaimableRow[];
  /** True when nobody but the DAO holds Shares or Loot. */
  zeroSupply: boolean;
}

/** Thin fetcher over `../chain.ts`'s RPC seam; pure logic lives above. */
export async function fetchRagequitPosition(
  endpoint: string,
  dao: string,
  holder: string,
  tokens: readonly string[],
): Promise<RagequitPosition> {
  const reads = buildRagequitReads(dao, tokens);
  const results = new Map<string, bigint | boolean | string>();
  for (const read of reads) {
    if (read.name === "pool" && read.token === ETH_TOKEN) {
      results.set("pool:eth", await ethGetBalance(endpoint, dao));
      continue;
    }
    const raw = await ethCall(endpoint, read.to, read.data);
    if (read.name === "ragequittable") {
      results.set(read.name, decodeU256(raw) !== 0n);
    } else if (read.name === "shares" || read.name === "loot") {
      results.set(read.name, decodeAddress(raw));
    } else if (read.name === "pool") {
      results.set(`pool:${read.token}`, decodeU256(raw));
    } else {
      results.set(read.name, decodeU256(raw));
    }
  }
  const sharesToken = results.get("shares") as string;
  const lootToken = results.get("loot") as string;
  for (const read of [
    ...buildSupplyReads(sharesToken, lootToken),
    ...buildHolderBalanceReads(sharesToken, lootToken, holder, dao),
  ]) {
    results.set(
      read.name,
      decodeU256(await ethCall(endpoint, read.to, read.data)),
    );
  }
  // The lock guard is optional: a DAO with no guard locks nothing.
  const guardRead = buildLockGuardRead(sharesToken);
  const guard = decodeAddress(
    await ethCall(endpoint, guardRead.to, guardRead.data),
  );
  let sharesLocked = 0n;
  let lockedTotal = 0n;
  let exitRule: ExitRule = "current";
  if (!/^0x0{40}$/.test(guard)) {
    const lockedRead = buildLockedOfRead(guard, holder);
    sharesLocked = decodeU256(
      await ethCall(endpoint, lockedRead.to, lockedRead.data),
    );
    const totalRead = buildTotalLockedRead(guard);
    try {
      lockedTotal = decodeU256(
        await ethCall(endpoint, totalRead.to, totalRead.data),
      );
    } catch (error) {
      if (!isRefusal(error)) throw error;
      // A lock made before D72. Whether that matters depends on the DAO: one made before D72 never asks the lock and
      // counts locked Shares; one made after asks, is refused, and cannot pay an exit at all.
      exitRule = (await answers(endpoint, dao, SELECTOR_LEAVING))
        ? "unknown"
        : "legacy";
    }
  }
  const sharesTotal = results.get("shares-total") as bigint;
  const lootTotal = results.get("loot-total") as bigint;
  const sharesBalance = results.get("holder-shares") as bigint;
  const lootBalance = results.get("holder-loot") as bigint;
  const daoHeld =
    (results.get("dao-shares") as bigint) + (results.get("dao-loot") as bigint);
  const sharesBurnable = burnableShares(sharesBalance, sharesLocked);
  const exitFeeBps = await readExitFee(endpoint, dao);
  const pools = tokens.map((token) => {
    const key =
      token.toLowerCase() === ETH_TOKEN
        ? "pool:eth"
        : `pool:${token.toLowerCase()}`;
    return {
      token: token.toLowerCase(),
      pool: (results.get(key) as bigint) ?? 0n,
    };
  });
  // The default view is a full exit of the burnable Shares (loot stays — the
  // CLI's semantic, org_ragequit.rs: burns shares only; loot exit is a
  // separate surface).
  const input = {
    sharesToBurn: sharesBurnable,
    lootToBurn: 0n,
    sharesBalance,
    lootBalance,
    sharesTotal,
    lootTotal,
    daoHeld,
    lockedTotal,
    pools,
    exitFeeBps,
  };
  const rows = deriveClaimablePosition(input);
  return {
    ragequittable: (results.get("ragequittable") as boolean) ?? false,
    sharesToken,
    lootToken,
    sharesBalance,
    sharesLocked,
    sharesBurnable,
    lootBalance,
    sharesTotal,
    lootTotal,
    daoHeld,
    lockedTotal,
    exitRule,
    exitFeeBps,
    feeApplies: exitFeeBps > 0n && sharesBurnable < exitDenominator(input),
    rows,
    zeroSupply: exitDenominator(input) === 0n,
  };
}

/**
 * The exit fee this DAO's exit charges now, read the way the exit reads it. A DAO, policy, factory or terms contract from
 * before the fee has no such call and its exit charges none: a refusal is zero. A network failure throws.
 */
async function readExitFee(endpoint: string, dao: string): Promise<bigint> {
  try {
    const policy = decodeAddress(
      await ethCall(endpoint, dao, SELECTOR_VOTING_WEIGHT),
    );
    const factory = decodeAddress(
      await ethCall(endpoint, policy, SELECTOR_MANDATE_FACTORY),
    );
    const terms = decodeAddress(
      await ethCall(endpoint, factory, SELECTOR_FUNDING_TERMS),
    );
    return decodeU256(
      await ethCall(
        endpoint,
        terms,
        `${SELECTOR_EXIT_FEE_OF}${addressWord(dao)}`,
      ),
    );
  } catch (error) {
    if (isRefusal(error)) return 0n;
    throw error;
  }
}

/** Whether `to` has the view function `selector`: true when it answers, false when it refuses; a network failure throws. */
async function answers(
  endpoint: string,
  to: string,
  selector: string,
): Promise<boolean> {
  try {
    decodeU256(await ethCall(endpoint, to, selector));
    return true;
  } catch (error) {
    if (isRefusal(error)) return false;
    throw error;
  }
}

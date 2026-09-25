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
 * Claimable derivation — `Moloch.sol:772-793`, verbatim:
 *
 *   total = shares.totalSupply() + loot.totalSupply()      // BEFORE the burn
 *   amt   = sharesToBurn + lootToBurn
 *   pool  = tk == address(0) ? dao.balance : balanceOfThis(tk)
 *   due   = mulDiv(pool, amt, total)                        // floor
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
import { ETH_TOKEN } from "./ragequit-tx.ts";

/** `cast sig` goldens (recorded in `ragequit-position.test.mjs`). */
export const SELECTOR_SHARES = "0x03314efa"; // shares()
export const SELECTOR_LOOT = "0x9b7b2ab0"; // loot()
export const SELECTOR_BALANCE_OF = "0x70a08231"; // balanceOf(address)
export const SELECTOR_TOTAL_SUPPLY = "0x18160ddd"; // totalSupply()
export const SELECTOR_RAGEQUITTABLE = "0x14a6d7de"; // ragequittable()

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

/** One composed view call: `{ name, to, data }`, executed by the fetcher. */
export interface RagequitRead {
  name:
    | "ragequittable"
    | "shares"
    | "loot"
    | "holder-shares"
    | "holder-loot"
    | "shares-total"
    | "loot-total"
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
    { name: "shares-total", to: target, data: SELECTOR_TOTAL_SUPPLY },
    { name: "loot-total", to: target, data: SELECTOR_TOTAL_SUPPLY },
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

/** The holder's share/loot balances — composed against the token addresses. */
export function buildHolderBalanceReads(
  sharesToken: string,
  lootToken: string,
  holder: string,
): RagequitRead[] {
  const who = addressWord(holder);
  return [
    {
      name: "holder-shares",
      to: sharesToken.toLowerCase(),
      data: `${SELECTOR_BALANCE_OF}${who}`,
    },
    {
      name: "holder-loot",
      to: lootToken.toLowerCase(),
      data: `${SELECTOR_BALANCE_OF}${who}`,
    },
  ];
}

/** What one token would pay out on exit. */
export interface ClaimableRow {
  /** Token address; {@link ETH_TOKEN} for ETH. */
  token: string;
  /** The DAO's balance of `token` (the pool). */
  pool: bigint;
  /**
   * What `sharesToBurn + lootToBurn` claims from `pool` right now
   * (`mulDiv(pool, amt, total)`, floor — Moloch.sol:791).
   */
  due: bigint;
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
  /** Per-token DAO pools (token address → balance). */
  pools: ReadonlyArray<{ token: string; pool: bigint }>;
}

/**
 * Pure claimable derivation (Moloch.sol:772-793). Floor-division; a zero
 * supply claims zero (the chain's `div(0)` would revert inside `mulDiv` —
 * the UI never sends a call in that state).
 */
export function deriveClaimablePosition(input: PositionInput): ClaimableRow[] {
  const total = input.sharesTotal + input.lootTotal;
  const amt = input.sharesToBurn + input.lootToBurn;
  return input.pools.map(({ token, pool }) => ({
    token,
    pool,
    due: total === 0n || amt === 0n ? 0n : (pool * amt) / total,
  }));
}

/** True when the burn inputs exceed the holder's own position. */
export function overdrawsPosition(input: PositionInput): boolean {
  return (
    input.sharesToBurn > input.sharesBalance ||
    input.lootToBurn > input.lootBalance
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
  lootBalance: bigint;
  sharesTotal: bigint;
  lootTotal: bigint;
  /** Pools + claimable rows for a full-shares exit (loot untouched). */
  rows: ClaimableRow[];
  /** True when the full-shares claimable derivation needs more supply. */
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
  for (const read of buildHolderBalanceReads(sharesToken, lootToken, holder)) {
    results.set(
      read.name,
      decodeU256(await ethCall(endpoint, read.to, read.data)),
    );
  }
  const sharesTotal = results.get("shares-total") as bigint;
  const lootTotal = results.get("loot-total") as bigint;
  const sharesBalance = results.get("holder-shares") as bigint;
  const lootBalance = results.get("holder-loot") as bigint;
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
  // The default view is a full-shares exit (loot stays — the CLI's semantic,
  // org_ragequit.rs: burns shares only; loot exit is a separate surface).
  const rows = deriveClaimablePosition({
    sharesToBurn: sharesBalance,
    lootToBurn: 0n,
    sharesBalance,
    lootBalance,
    sharesTotal,
    lootTotal,
    pools,
  });
  return {
    ragequittable: (results.get("ragequittable") as boolean) ?? false,
    sharesToken,
    lootToken,
    sharesBalance,
    lootBalance,
    sharesTotal,
    lootTotal,
    rows,
    zeroSupply: sharesTotal + lootTotal === 0n,
  };
}

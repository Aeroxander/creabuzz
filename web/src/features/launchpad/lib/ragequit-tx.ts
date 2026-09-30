/**
 * Majeur `ragequit` calldata composer.
 *
 * The onchain exit (majeur `Moloch.sol:759` `ragequit(address[] tokens,
 * uint256 sharesToBurn, uint256 lootToBurn)`) burns shares/loot and pays out
 * each holder's proportional claim on the DAO's own balances. The call bytes
 * are composed here with the launchpad money-action contract (`bid-tx.ts`):
 * every sender receives the same bytes, and every byte is bound to `cast`
 * goldens in `ragequit-tx.test.mjs` (the exact `cast calldata` commands are
 * recorded there).
 *
 * Contract semantics pinned from `contracts/lib/majeur/src/Moloch.sol`
 * (`ragequit`, lines 759-810) and
 * `crates/buzz-cli/src/commands/org_ragequit.rs` (the CLI's call semantics):
 *
 * - `tokens` must be strictly ascending (the contract reverts on
 *   `token <= prev`), must not be empty, and must not include the shares
 *   token, the loot token, the DAO itself, or `address(1007)` — the composer
 *   normalizes to ascending, dedupes, and rejects the forbidden set so the
 *   composed call can never revert on those preconditions;
 * - `sharesToBurn` and `lootToBurn` cannot both be zero;
 * - the ETH claim is the zero address sentinel (`address(0)`);
 * - the payout per token is `mulDiv(pool, amt, total)` with
 *   `amt = sharesToBurn + lootToBurn` and `total = shares.totalSupply() +
 *   loot.totalSupply()` measured before the burn (see `ragequit-position.ts`
 *   for the derivation the UI shows).
 *
 * Encoder: `identity/lib/userop-abi.ts` `abiEncodeCall` (import READ-ONLY).
 * `address[]` is encoded as `tuple[]` of single-`address` tuples — a static
 * tuple encodes inline, so the bytes are exactly `abi.encode(address[])` (the
 * goldens prove it).
 */
import { abiEncodeCall } from "../../identity/lib/userop-abi.ts";

/** ETH claim sentinel — `Moloch.sol:790` `tk == address(0) ? this.balance`. */
export const ETH_TOKEN = `0x${"00".repeat(20)}`;

/** `cast sig 'ragequit(address[],uint256,uint256)'` (pinned golden). */
export const RAGEQUIT_SELECTOR = "0x29f64d1a";
export const RAGEQUIT_SIGNATURE = "ragequit(address[],uint256,uint256)";

export interface RagequitCallInput {
  /** Token addresses to claim (ETH = {@link ETH_TOKEN}). Order is normalized. */
  tokens: string[];
  /** Shares to burn (`sharesToBurn`). */
  sharesToBurn: bigint;
  /** Loot to burn (`lootToBurn`). */
  lootToBurn: bigint;
  /**
   * Addresses the contract forbids inside the token list: the shares token,
   * the loot token, the DAO itself, and `address(1007)`
   * (`Moloch.sol:785-787`). Callers pass what the position read discovered.
   */
  forbidden?: readonly string[];
}

function requireAddress(value: string, what: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`ragequit-tx: ${what} must be a 0x address, got ${value}`);
  }
  return value.toLowerCase();
}

function requireU256(value: bigint, what: string): bigint {
  if (value < 0n || value >= 1n << 256n) {
    throw new Error(`ragequit-tx: ${what} must fit uint256`);
  }
  return value;
}

/**
 * Normalize a token list to the contract's precondition: lowercase, deduped,
 * strictly ascending. Throws on a forbidden token or when the list is empty.
 */
export function normalizeRagequitTokens(
  tokens: readonly string[],
  forbidden: readonly string[] = [],
): string[] {
  if (tokens.length === 0) {
    throw new Error(
      "ragequit-tx: at least one token is required (use ETH_TOKEN for ETH)",
    );
  }
  const banned = new Set(
    forbidden.map((t) => requireAddress(t, "forbidden token")),
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tokens) {
    const token = requireAddress(raw, "token");
    if (banned.has(token)) {
      throw new Error(
        `ragequit-tx: token ${token} cannot be ragequit (shares/loot/DAO)`,
      );
    }
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  out.sort();
  return out;
}

/**
 * Compose `ragequit(address[],uint256,uint256)` calldata.
 *
 * Throws when the inputs cannot produce a call the contract accepts:
 * empty/duplicated/unsorted-normalized token lists are normalized away, but a
 * zero-total burn or a forbidden token is a real user error and fails here.
 */
export function encodeRagequitCalldata(input: RagequitCallInput): string {
  const tokens = normalizeRagequitTokens(input.tokens, input.forbidden ?? []);
  const sharesToBurn = requireU256(input.sharesToBurn, "sharesToBurn");
  const lootToBurn = requireU256(input.lootToBurn, "lootToBurn");
  if (sharesToBurn === 0n && lootToBurn === 0n) {
    throw new Error(
      "ragequit-tx: sharesToBurn and lootToBurn cannot both be zero",
    );
  }
  const data = abiEncodeCall(RAGEQUIT_SIGNATURE, [
    {
      kind: "tuple[]",
      items: tokens.map((token) => [
        { kind: "address" as const, value: token },
      ]),
    },
    { kind: "uint", value: sharesToBurn },
    { kind: "uint", value: lootToBurn },
  ]);
  if (!data.toLowerCase().startsWith(RAGEQUIT_SELECTOR)) {
    throw new Error(
      `ragequit-tx: encoder produced selector ${data.slice(0, 10)}`,
    );
  }
  return data;
}

/**
 * One sender-seam call: the burn + claim is a single tx to the DAO. Shape
 * matches `bid-tx.ts`'s `UnsignedTx` — `value` is a hex quantity string so
 * the same bytes reach wallet and sponsored adapters unchanged.
 */
export interface RagequitTx {
  to: string;
  /** Quantity string; a ragequit moves no value. */
  value: string;
  data: string;
}

/** Compose the single `ragequit` call for the sender seam (bytes identical for every sender). */
export function buildRagequitTx(
  dao: string,
  input: RagequitCallInput,
): RagequitTx {
  return {
    to: requireAddress(dao, "dao"),
    value: "0x0",
    data: encodeRagequitCalldata(input),
  };
}

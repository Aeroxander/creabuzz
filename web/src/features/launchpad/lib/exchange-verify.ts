/**
 * Whether the exchange contracts a build names are the ones it was built to trust.
 *
 * The exchange is Limit Break's, deployed by them at the same address on every chain it is on, so the check is cheap
 * and strong: pin the keccak256 of each contract's runtime code in the build, and before the app offers a market, read
 * the code at the address and compare. A different hash, an address with no code, or a node that cannot answer all
 * mean "unverified", and the market stays off; the app never shows a market it could not check.
 *
 * Only the local test chain skips the pins (its exchange is a throwaway clone). Any other chain needs them
 * (`exchangeAddresses` in `../chain.ts` refuses an unpinned entry).
 *
 * Alias-free: `exchange-verify.test.mjs` drives it under `node --test`.
 */

import { keccak_256 } from "@noble/hashes/sha3.js";

export const EXCHANGE_CONTRACTS = [
  "amm",
  "hook",
  "registry",
  "poolType",
] as const;
export type ExchangeContract = (typeof EXCHANGE_CONTRACTS)[number];
export type CodeHashes = Record<ExchangeContract, string>;

const HASH = /^0x[0-9a-f]{64}$/;

/** A pinned hash as written in a build's config, or null when it is not 32 bytes of hex. Lower-cased. */
export function parseCodeHash(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const lower = value.trim().toLowerCase();
  return HASH.test(lower) ? lower : null;
}

/** keccak256 of runtime code given as `0x…` hex. `eth_getCode`'s answer, hashed the way a block explorer does. */
export function codeHashOf(code: string): string {
  const hex = code.startsWith("0x") ? code.slice(2) : code;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return `0x${Array.from(keccak_256(bytes), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export interface ExchangeCheck {
  /** `verified` only when every contract's code hashes to its pin. */
  state: "verified" | "unverified" | "unreadable";
  /** The contracts whose code is not the pinned code. */
  mismatched: ExchangeContract[];
  /** The contracts with no code at their address. */
  empty: ExchangeContract[];
}

/** Compare the code at each address with its pin. `getCode` is `eth_getCode`; it may throw. */
export async function verifyExchange(
  addresses: Record<ExchangeContract, string>,
  pins: CodeHashes,
  getCode: (address: string) => Promise<string>,
): Promise<ExchangeCheck> {
  const mismatched: ExchangeContract[] = [];
  const empty: ExchangeContract[] = [];
  let unreadable = false;
  await Promise.all(
    EXCHANGE_CONTRACTS.map(async (name) => {
      let code: string;
      try {
        code = await getCode(addresses[name]);
      } catch {
        unreadable = true;
        return;
      }
      if (typeof code !== "string" || code === "0x" || code.length <= 2) {
        empty.push(name);
      } else if (codeHashOf(code) !== pins[name]) {
        mismatched.push(name);
      }
    }),
  );
  if (unreadable) return { state: "unreadable", mismatched, empty };
  return {
    state:
      mismatched.length === 0 && empty.length === 0 ? "verified" : "unverified",
    mismatched,
    empty,
  };
}

/** What to tell a person when the market is off because the check did not pass, in plain words. */
export function exchangeCheckNote(check: ExchangeCheck): string {
  if (check.state === "verified") return "";
  if (check.state === "unreadable") {
    return "The market is off for now: the network could not be asked whether the market contracts are the right ones.";
  }
  return "The market is off: the contracts at the configured addresses are not the ones this build was made to trust.";
}

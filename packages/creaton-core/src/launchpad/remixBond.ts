/**
 * A remix's bond to its parent (N12, `contracts/src/RemixBond.sol`, docs/v3-review/REMIX-PARENT-SHARE.md): the calls, a
 * launch record's key, the reader for a remix's latest bond, and what anyone can do with it.
 *
 * Pure apart from the reader, whose chain is injected (`remixBond.test.mjs` runs it against a fake one). Selectors are
 * pinned to `cast` in the same test.
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import { decodeParameters, encodeFunctionData } from "./evmAbi.ts";
import { topicOf } from "./work.ts";
import type { WorkChain } from "./workRead.ts";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const DAY = 86_400;
export const MIN_TERM_DAYS = 30;
export const MAX_TERM_DAYS = 730;

export const REMIX_BOND_SIGNATURES = {
  post: "post(bytes32,bytes32,address,string,uint256,uint64)",
  openCase: "openCase(uint256)",
  release: "release(uint256)",
  payParent: "payParent(uint256)",
  bonds: "bonds(uint256)",
} as const;

export const TOPIC_BOND_POSTED = topicOf(
  "Posted(uint256,bytes32,bytes32,address,address,uint256,uint64,string)",
);

/** A launch record's key in the bond contract: keccak256 of its coordinate, "37001:<author>:<id>". */
export function recordKey(coordinate: string): string {
  return `0x${bytesToHex(keccak_256(utf8ToBytes(coordinate)))}`;
}

export function encodePostBond(input: {
  remix: string;
  parent: string;
  parentDao: string;
  terms: string;
  amount: bigint;
  days: number;
}): string {
  if (!ADDRESS_RE.test(input.parentDao)) {
    throw new Error("the parent has no DAO to pay");
  }
  if (input.amount <= 0n) throw new Error("the bond must be above zero");
  if (
    !Number.isInteger(input.days) ||
    input.days < MIN_TERM_DAYS ||
    input.days > MAX_TERM_DAYS
  ) {
    throw new Error(
      `the bond is held from ${MIN_TERM_DAYS} to ${MAX_TERM_DAYS} days`,
    );
  }
  return encodeFunctionData(
    REMIX_BOND_SIGNATURES.post,
    ["bytes32", "bytes32", "address", "string", "uint256", "uint64"],
    [
      recordKey(input.remix),
      recordKey(input.parent),
      input.parentDao,
      input.terms,
      input.amount,
      BigInt(input.days * DAY),
    ],
  );
}

const id1 = (sig: string, id: bigint) =>
  encodeFunctionData(sig, ["uint256"], [id]);
export const encodeOpenBondCase = (id: bigint): string =>
  id1(REMIX_BOND_SIGNATURES.openCase, id);
export const encodeReleaseBond = (id: bigint): string =>
  id1(REMIX_BOND_SIGNATURES.release, id);
export const encodePayParent = (id: bigint): string =>
  id1(REMIX_BOND_SIGNATURES.payParent, id);

export interface RemixBondView {
  id: bigint;
  poster: string;
  parentDao: string;
  releasesAt: number;
  state: "held" | "forfeited" | "returned" | "paid";
  /** The court case open on it, or 0. */
  openCase: number;
  amount: bigint;
  /** The parent's terms, in the words the bond was posted against. */
  terms: string;
}

const STATES = ["none", "held", "forfeited", "returned", "paid"] as const;

/** What anyone can do with a bond at chain time `now`: the contract's own conditions. */
export function bondActions(
  bond: RemixBondView,
  now: number,
): { openCase: boolean; release: boolean; payParent: boolean } {
  const held = bond.state === "held" && bond.openCase === 0;
  return {
    openCase: held && now < bond.releasesAt,
    release: held && now >= bond.releasesAt,
    payParent: bond.state === "forfeited",
  };
}

interface LogLike {
  topics?: unknown;
  data?: unknown;
}

/** The latest bond posted for the remix at `coordinate`, or null when it has none. */
export async function readRemixBond(
  chain: Pick<WorkChain, "call" | "logs">,
  contract: string,
  coordinate: string,
): Promise<RemixBondView | null> {
  const logs = await chain.logs({
    address: contract,
    topics: [TOPIC_BOND_POSTED, null, recordKey(coordinate)],
  });
  const posted = logs
    .flatMap((raw) => {
      const log = raw as LogLike;
      const t = Array.isArray(log.topics) ? (log.topics as string[]) : [];
      if (t.length !== 4 || typeof log.data !== "string") return [];
      try {
        const [, , , , terms] = decodeParameters(
          ["address", "address", "uint256", "uint64", "string"],
          log.data,
        );
        return [{ id: BigInt(t[1]), terms: String(terms) }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => (a.id > b.id ? -1 : 1));
  const latest = posted[0];
  if (!latest) return null;
  const [poster, parentDao, releasesAt, state, openCase, amount] =
    decodeParameters(
      [
        "address",
        "address",
        "uint64",
        "uint8",
        "uint64",
        "uint128",
        "bytes32",
        "bytes32",
        "bytes32",
      ],
      await chain.call(contract, id1(REMIX_BOND_SIGNATURES.bonds, latest.id)),
    ) as [string, string, bigint, bigint, bigint, bigint];
  const named = STATES[Number(state)];
  if (!named || named === "none") return null;
  return {
    id: latest.id,
    poster: poster.toLowerCase(),
    parentDao: parentDao.toLowerCase(),
    releasesAt: Number(releasesAt),
    state: named,
    openCase: Number(openCase),
    amount,
    terms: latest.terms,
  };
}

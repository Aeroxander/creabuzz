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
const MIN_TERM_DAYS = 30;
const MAX_TERM_DAYS = 730;

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

/**
 * Who a remix's own bond can come from, and what it must be for: anyone can post a bond naming any record, so only one
 * posted by the remix's DAO or its founder (as the kit's launch event names them), to the parent's DAO and against the
 * parent's record, is the project's.
 */
export interface RemixBondBinding {
  posters: readonly string[];
  parent: string;
  parentDao: string;
}

/** The latest bond the remix at `coordinate` itself posted to its parent, or null when it has none. */
export async function readRemixBond(
  chain: Pick<WorkChain, "call" | "logs">,
  contract: string,
  coordinate: string,
  binding: RemixBondBinding,
): Promise<RemixBondView | null> {
  const posters = new Set(binding.posters.map((a) => a.toLowerCase()));
  const parentKey = recordKey(binding.parent).toLowerCase();
  const wantDao = binding.parentDao.toLowerCase();
  if (posters.size === 0 || !ADDRESS_RE.test(wantDao)) return null;
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
        const [poster, dao, , , terms] = decodeParameters(
          ["address", "address", "uint256", "uint64", "string"],
          log.data,
        ) as [string, string, bigint, bigint, string];
        if (
          !posters.has(poster.toLowerCase()) ||
          dao.toLowerCase() !== wantDao ||
          t[3].toLowerCase() !== parentKey
        ) {
          return [];
        }
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

/** What a court case about bond `id` is judged against: the terms it was posted against (checked against the hash the
 * bond keeps), its amount and who it goes to if the court finds the terms broken. Null when the bond cannot be read. */
export async function readBondCase(
  chain: Pick<WorkChain, "call" | "logs">,
  contract: string,
  id: bigint,
): Promise<{ terms: string | null; amount: bigint; parentDao: string } | null> {
  const [record, logs] = await Promise.all([
    chain.call(contract, id1(REMIX_BOND_SIGNATURES.bonds, id)),
    chain.logs({
      address: contract,
      topics: [TOPIC_BOND_POSTED, `0x${id.toString(16).padStart(64, "0")}`],
    }),
  ]);
  const fields = decodeParameters(
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
    record,
  ) as [string, string, bigint, bigint, bigint, bigint, string, string, string];
  if (Number(fields[3]) === 0) return null;
  let terms: string | null = null;
  const data = (logs[0] as LogLike | undefined)?.data;
  if (typeof data === "string") {
    try {
      const [, , , , words] = decodeParameters(
        ["address", "address", "uint256", "uint64", "string"],
        data,
      );
      const hash = `0x${bytesToHex(keccak_256(utf8ToBytes(String(words))))}`;
      if (hash === fields[8].toLowerCase()) terms = String(words);
    } catch {}
  }
  return { terms, amount: fields[5], parentDao: fields[1].toLowerCase() };
}

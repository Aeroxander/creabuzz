/**
 * Who earned a DAO's Shares, how many, and for which accepted work, read from the chain.
 *
 * An award is a DAO vote, and the work budget it counts against says so in its own event:
 * `ContributionConsumed(claimId, contributor, shares)`, emitted only for a claim the reviewers approved, whose challenge
 * window passed, and that was never awarded before. Every one of those events, from every work budget the DAO made, is
 * a line here; the claim's project is read from the budget that holds it. Nothing comes from what someone wrote about
 * the work, so the page cannot show an award the chain did not make.
 *
 * The Shares in existence now are read too, so each person's part is a share of all of them, and what was not earned
 * through work (the founders' starting Shares, less anything given back) is shown as the difference.
 *
 * Bounded (Review-Proven Rule 4): at most `MAX_BUDGETS` work budgets and `MAX_AWARDS` awards; past that the snapshot
 * says it is cut short.
 *
 * Alias-free: `contributions.test.mjs` runs it against a fake chain.
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import {
  addressTopic,
  decodeAddress,
  decodeMandateCreated,
  decodeWord,
  encodeCall0,
  encodeCallId,
  idLabel,
  SIGNATURES,
  TOPIC_MANDATE_CREATED,
} from "./work.ts";
import type { WorkChain } from "./work-read.ts";

export const MAX_BUDGETS = 32;
export const MAX_AWARDS = 500;

/** `ContributionConsumed(bytes32 indexed claimId, address indexed contributor, uint128 shares)`. */
export const TOPIC_CONTRIBUTION_CONSUMED = `0x${bytesToHex(
  keccak_256(utf8ToBytes("ContributionConsumed(bytes32,address,uint128)")),
)}`;

export interface ContributionAward {
  /** The work budget the claim was filed in. */
  budget: string;
  claimId: string;
  /** The claim's name as it was filed ("write-docs"), or a shortened id. */
  claim: string;
  /** The project inside the budget the claim was taken on by, as named; null when it could not be read. */
  project: string | null;
  contributor: string;
  shares: bigint;
  blockNumber: number | null;
  txHash: string | null;
}

export interface Contributor {
  address: string;
  earned: bigint;
  /** Basis points of all Shares in existence now; null when the total could not be read. */
  bpsOfAll: number | null;
  awards: ContributionAward[];
}

export interface ContributionsSnapshot {
  dao: string;
  /** All the DAO's Shares in existence now; null when it could not be read. */
  totalShares: bigint | null;
  /** Shares awarded for accepted work, in all. */
  earned: bigint;
  /** Shares not awarded for work (the starting Shares, less any given back); null when the total is unknown. */
  notFromWork: bigint | null;
  /** Most earned first. */
  people: Contributor[];
  /** Work budgets read. */
  budgets: number;
  truncated: boolean;
}

interface RawLog {
  address?: string;
  topics?: readonly string[];
  data?: string;
  blockNumber?: string;
  transactionHash?: string;
}

const ZERO_WORD = `0x${"0".repeat(64)}`;
const WORD_RE = /^0x[0-9a-fA-F]{64}$/;

/** One award event, or null for a log that is not one. */
export function decodeContributionConsumed(
  log: RawLog,
  budget: string,
): Omit<ContributionAward, "project"> | null {
  const topics = log.topics ?? [];
  if (
    topics[0]?.toLowerCase() !== TOPIC_CONTRIBUTION_CONSUMED ||
    !WORD_RE.test(topics[1] ?? "") ||
    !WORD_RE.test(topics[2] ?? "") ||
    !log.data ||
    log.data.length < 66
  )
    return null;
  const claimId = (topics[1] as string).toLowerCase();
  const shares = decodeWord(log.data);
  if (shares === 0n) return null;
  return {
    budget: budget.toLowerCase(),
    claimId,
    claim: idLabel(claimId),
    contributor: decodeAddress(topics[2] as string),
    shares,
    blockNumber:
      typeof log.blockNumber === "string"
        ? Number(BigInt(log.blockNumber))
        : null,
    txHash:
      typeof log.transactionHash === "string" ? log.transactionHash : null,
  };
}

const TOTAL_SUPPLY = encodeCall0("totalSupply()");
const SHARES = encodeCall0("shares()");

async function totalShares(chain: WorkChain, dao: string) {
  try {
    const token = decodeAddress(await chain.call(dao, SHARES));
    return decodeWord(await chain.call(token, TOTAL_SUPPLY));
  } catch {
    return null;
  }
}

/** Group awards by person, most earned first (ties by address, so the order is stable). */
export function groupContributions(
  awards: readonly ContributionAward[],
  totalShares: bigint | null,
): Contributor[] {
  const byPerson = new Map<string, ContributionAward[]>();
  for (const award of awards) {
    const key = award.contributor.toLowerCase();
    byPerson.set(key, [...(byPerson.get(key) ?? []), award]);
  }
  return [...byPerson.entries()]
    .map(([address, list]) => {
      const earned = list.reduce((sum, a) => sum + a.shares, 0n);
      return {
        address,
        earned,
        bpsOfAll:
          totalShares && totalShares > 0n
            ? Number((earned * 10_000n) / totalShares)
            : null,
        awards: [...list].sort(
          (a, b) => (b.blockNumber ?? 0) - (a.blockNumber ?? 0),
        ),
      };
    })
    .sort((a, b) =>
      a.earned === b.earned
        ? a.address.localeCompare(b.address)
        : a.earned > b.earned
          ? -1
          : 1,
    );
}

export async function readContributions(
  chain: WorkChain,
  dao: string,
): Promise<ContributionsSnapshot> {
  const policy = decodeAddress(
    await chain.call(dao, encodeCall0(SIGNATURES.policy)),
  );
  const factory = decodeAddress(
    await chain.call(policy, encodeCall0(SIGNATURES.factory)),
  );
  const created = (
    await chain.logs({
      address: factory,
      topics: [TOPIC_MANDATE_CREATED, addressTopic(dao)],
    })
  ).flatMap((log) => {
    const decoded = decodeMandateCreated(log as never);
    // A budget the factory says another DAO made is not this DAO's, whatever the topic filter returned.
    return decoded && decoded.dao.toLowerCase() === dao.toLowerCase()
      ? [decoded.mandate]
      : [];
  });
  const budgets = created.slice(0, MAX_BUDGETS);
  let truncated = created.length > MAX_BUDGETS;

  const perBudget = await Promise.all(
    budgets.map(async (budget) =>
      (
        await chain.logs({
          address: budget,
          topics: [TOPIC_CONTRIBUTION_CONSUMED],
        })
      ).flatMap((log) => {
        const raw = log as RawLog;
        // Only the budget's own events: a node that ignores the address filter must not add someone else's awards.
        if (raw.address && raw.address.toLowerCase() !== budget.toLowerCase())
          return [];
        const decoded = decodeContributionConsumed(raw, budget);
        return decoded ? [decoded] : [];
      }),
    ),
  );
  let found = perBudget.flat();
  if (found.length > MAX_AWARDS) {
    truncated = true;
    found = found.slice(0, MAX_AWARDS);
  }

  // The project each claim was taken on by, read once per claim from the budget that holds it.
  const awards = await Promise.all(
    found.map(async (award) => {
      let project: string | null = null;
      try {
        const word = await chain.call(
          award.budget,
          encodeCallId(SIGNATURES.claimProject, award.claimId),
        );
        const id = `0x${word.replace(/^0x/, "").slice(0, 64)}`;
        if (WORD_RE.test(id) && id !== ZERO_WORD) project = idLabel(id);
      } catch {
        project = null;
      }
      return { ...award, project };
    }),
  );

  const total = await totalShares(chain, dao);
  const earned = awards.reduce((sum, a) => sum + a.shares, 0n);
  return {
    dao: dao.toLowerCase(),
    totalShares: total,
    earned,
    notFromWork: total === null ? null : total > earned ? total - earned : 0n,
    people: groupContributions(awards, total),
    budgets: budgets.length,
    truncated,
  };
}

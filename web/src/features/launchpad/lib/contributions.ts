/**
 * Who earned a DAO's Shares, how many, and for which accepted work, read from the chain.
 *
 * An award counts against the work budget it came from, and the budget says so in its own event:
 * `ContributionConsumed(claimId, contributor, shares)`, emitted only for a claim the reviewers approved, whose challenge
 * window passed, and that was never awarded before. Every one of those events, from every work budget the DAO made, is
 * a line here; the claim's work area is read from the budget that holds it.
 *
 * The event alone does not prove the Shares arrived: the DAO can record a claim as used by a vote that calls the budget
 * directly, with no award. So each award is checked against the Shares token itself: the same transaction must move at
 * least that many Shares to the person, minted or out of the DAO's own reserve (`awardContribution` does one or both).
 * An award whose Shares were not found reads as recorded, not received, and is not counted as earned; when the token's
 * history could not be read, none is confirmed.
 *
 * The Shares that were not awarded for work (a contributor project's starting Shares; in a raise, the team's and the
 * sale's) are the token's mints outside award transactions: what was issued, which leaving later cannot change. What
 * each person holds is read separately, now, because past awards and present holdings differ once anyone leaves.
 *
 * Bounded (Review-Proven Rule 4): at most `MAX_BUDGETS` work budgets and `MAX_AWARDS` awards, two reads of the token's
 * history, and one balance per person shown; past the limits the snapshot says it is cut short.
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
const MAX_AWARDS = 500;
/** Share moves read to confirm awards (mints, and moves out of the DAO's reserve), each. */
const MAX_MOVES = 2_000;

/** `ContributionConsumed(bytes32 indexed claimId, address indexed contributor, uint128 shares)`. */
export const TOPIC_CONTRIBUTION_CONSUMED = `0x${bytesToHex(
  keccak_256(utf8ToBytes("ContributionConsumed(bytes32,address,uint128)")),
)}`;

/** `Transfer(address indexed from, address indexed to, uint256 value)`, as the Shares token emits it. */
export const TOPIC_TRANSFER = `0x${bytesToHex(
  keccak_256(utf8ToBytes("Transfer(address,address,uint256)")),
)}`;

/**
 * Whether an award's Shares reached the person: `received` when its transaction moved them there, `missing` when it
 * did not, `unknown` when the token's history could not be read.
 */
type Receipt = "received" | "missing" | "unknown";

export interface ContributionAward {
  /** The work budget the claim was filed in. */
  budget: string;
  claimId: string;
  /** The claim's name as it was filed ("write-docs"), or a shortened id. */
  claim: string;
  /** The work area inside the budget the claim was accepted into, as named; null when it could not be read. */
  project: string | null;
  contributor: string;
  shares: bigint;
  blockNumber: number | null;
  txHash: string | null;
  receipt: Receipt;
}

interface Contributor {
  address: string;
  /** Shares awarded to them whose arrival was confirmed. */
  earned: bigint;
  /** Shares recorded as awarded to them whose arrival was not confirmed (missing, or unknown). */
  unconfirmed: bigint;
  /** What they hold now; null when it could not be read. */
  heldNow: bigint | null;
  /** What they hold now, in basis points of all Shares now; null when either could not be read. */
  bpsNow: number | null;
  awards: ContributionAward[];
}

export interface ContributionsSnapshot {
  dao: string;
  /** All the DAO's Shares in existence now; null when it could not be read. */
  totalShares: bigint | null;
  /** Shares awarded for accepted work whose arrival was confirmed, in all. */
  earned: bigint;
  /** Shares recorded as awarded whose arrival was not confirmed, in all. */
  unconfirmed: bigint;
  /** The token's history could not be read, so no award could be confirmed. */
  receiptsUnread: boolean;
  /** Shares issued other than by an award (the starting Shares); null when the token's history could not be read. */
  startingShares: bigint | null;
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
): Omit<ContributionAward, "project" | "receipt"> | null {
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
const BALANCE_OF = "0x70a08231";

/** One Shares move from a `Transfer` log of `token`, or null for a log that is not one. */
function decodeShareMove(
  log: RawLog,
  token: string,
): { from: string; to: string; amount: bigint; txHash: string } | null {
  const topics = log.topics ?? [];
  if (
    (log.address && log.address.toLowerCase() !== token.toLowerCase()) ||
    topics[0]?.toLowerCase() !== TOPIC_TRANSFER ||
    !WORD_RE.test(topics[1] ?? "") ||
    !WORD_RE.test(topics[2] ?? "") ||
    !log.data ||
    log.data.length < 66 ||
    typeof log.transactionHash !== "string"
  )
    return null;
  return {
    from: decodeAddress(topics[1] as string),
    to: decodeAddress(topics[2] as string),
    amount: decodeWord(log.data),
    txHash: log.transactionHash.toLowerCase(),
  };
}

const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const moveKey = (txHash: string, to: string) =>
  `${txHash.toLowerCase()}:${to.toLowerCase()}`;

/**
 * Which awards' Shares reached the person, and the Shares issued outside awards, from the token's mints and its moves
 * out of the DAO. Awards in one transaction to one person are checked together (a vote can carry several).
 */
function confirmAwards(
  awards: readonly Omit<ContributionAward, "receipt">[],
  moves: { from: string; to: string; amount: bigint; txHash: string }[] | null,
  dao: string,
): { awards: ContributionAward[]; startingShares: bigint | null } {
  if (moves === null)
    return {
      awards: awards.map((a) => ({ ...a, receipt: "unknown" })),
      startingShares: null,
    };
  const arrived = new Map<string, bigint>();
  for (const move of moves) {
    const from = move.from.toLowerCase();
    if (from !== ZERO_ADDRESS && from !== dao.toLowerCase()) continue;
    const key = moveKey(move.txHash, move.to);
    arrived.set(key, (arrived.get(key) ?? 0n) + move.amount);
  }
  const owed = new Map<string, bigint>();
  for (const award of awards) {
    if (!award.txHash) continue;
    const key = moveKey(award.txHash, award.contributor);
    owed.set(key, (owed.get(key) ?? 0n) + award.shares);
  }
  const awardTxs = new Set(
    awards.flatMap((a) => (a.txHash ? [a.txHash.toLowerCase()] : [])),
  );
  const startingShares = moves
    .filter(
      (m) => m.from.toLowerCase() === ZERO_ADDRESS && !awardTxs.has(m.txHash),
    )
    .reduce((sum, m) => sum + m.amount, 0n);
  return {
    awards: awards.map((award) => {
      if (!award.txHash) return { ...award, receipt: "missing" as const };
      const key = moveKey(award.txHash, award.contributor);
      return {
        ...award,
        receipt:
          (arrived.get(key) ?? 0n) >= (owed.get(key) ?? 0n) &&
          (arrived.get(key) ?? 0n) > 0n
            ? ("received" as const)
            : ("missing" as const),
      };
    }),
    startingShares,
  };
}

/** Group awards by person, most earned first (ties by address, so the order is stable). */
function groupContributions(
  awards: readonly ContributionAward[],
  holdings: ReadonlyMap<string, bigint | null> = new Map(),
  totalShares: bigint | null = null,
): Contributor[] {
  const byPerson = new Map<string, ContributionAward[]>();
  for (const award of awards) {
    const key = award.contributor.toLowerCase();
    byPerson.set(key, [...(byPerson.get(key) ?? []), award]);
  }
  return [...byPerson.entries()]
    .map(([address, list]) => {
      const sum = (pick: (a: ContributionAward) => boolean) =>
        list.filter(pick).reduce((total, a) => total + a.shares, 0n);
      const heldNow = holdings.get(address) ?? null;
      return {
        address,
        earned: sum((a) => a.receipt === "received"),
        unconfirmed: sum((a) => a.receipt !== "received"),
        heldNow,
        bpsNow:
          heldNow !== null && totalShares && totalShares > 0n
            ? Number((heldNow * 10_000n) / totalShares)
            : null,
        awards: [...list].sort(
          (a, b) => (b.blockNumber ?? 0) - (a.blockNumber ?? 0),
        ),
      };
    })
    .sort((a, b) =>
      a.earned !== b.earned
        ? a.earned > b.earned
          ? -1
          : 1
        : a.unconfirmed !== b.unconfirmed
          ? a.unconfirmed > b.unconfirmed
            ? -1
            : 1
          : a.address.localeCompare(b.address),
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

  // The token: its total now, its mints and moves out of the DAO (to confirm the awards), and each person's balance now.
  let token: string | null = null;
  try {
    token = decodeAddress(await chain.call(dao, SHARES));
  } catch {
    token = null;
  }
  const read = async <T>(run: (t: string) => Promise<T>): Promise<T | null> => {
    if (token === null) return null;
    try {
      return await run(token);
    } catch {
      return null;
    }
  };
  const [total, moves] = await Promise.all([
    read(async (t) => decodeWord(await chain.call(t, TOTAL_SUPPLY))),
    read(async (t) => {
      const [minted, fromDao] = await Promise.all([
        chain.logs({ address: t, topics: [TOPIC_TRANSFER, ZERO_WORD] }),
        chain.logs({ address: t, topics: [TOPIC_TRANSFER, addressTopic(dao)] }),
      ]);
      if (minted.length > MAX_MOVES || fromDao.length > MAX_MOVES)
        truncated = true;
      return [
        ...minted.slice(0, MAX_MOVES),
        ...fromDao.slice(0, MAX_MOVES),
      ].flatMap((log) => {
        const move = decodeShareMove(log as RawLog, t);
        return move ? [move] : [];
      });
    }),
  ]);
  const confirmed = confirmAwards(awards, moves, dao);
  const people = [
    ...new Set(confirmed.awards.map((a) => a.contributor.toLowerCase())),
  ];
  const holdings = new Map(
    await Promise.all(
      people.map(
        async (person) =>
          [
            person,
            await read(async (t) =>
              decodeWord(
                await chain.call(
                  t,
                  `${BALANCE_OF}${person.slice(2).padStart(64, "0")}`,
                ),
              ),
            ),
          ] as const,
      ),
    ),
  );
  const sum = (pick: (a: ContributionAward) => boolean) =>
    confirmed.awards.filter(pick).reduce((t, a) => t + a.shares, 0n);
  return {
    dao: dao.toLowerCase(),
    totalShares: total,
    earned: sum((a) => a.receipt === "received"),
    unconfirmed: sum((a) => a.receipt !== "received"),
    receiptsUnread: moves === null,
    startingShares: confirmed.startingShares,
    people: groupContributions(confirmed.awards, holdings, total),
    budgets: budgets.length,
    truncated,
  };
}

/**
 * Who holds a DAO's Shares, and for how long.
 *
 * The balances come from the Shares' own transfer history, added up, and are checked against the Shares' total supply:
 * if the two do not agree the list says it may be incomplete instead of presenting a partial list as the whole.
 * For the biggest holders it then asks the DAO's voting policy how long each has held (`holdingAge`: the weighted
 * average moment the Shares were acquired; receiving blends it in, sending changes nothing, and Shares passed to another
 * wallet do not take their time with them) and how much of the holding is still locked behind milestones.
 *
 * A DAO whose policy keeps no holding time (one made before the ledger existed) is listed without times, not as a
 * failure. Any other failed read throws: "could not read" is never presented as "nobody holds anything"
 * (Review-Proven Rule 1). The chain is injected, so `holders-read.test.mjs` runs the real reader against a fake one.
 * Alias-free for `node --test`.
 */

import { encodeFunctionData } from "@creaton/core/launchpad/evmAbi.ts";
import {
  LOCK_SIGNATURES,
  readMilestoneLock,
} from "@creaton/core/launchpad/milestoneLock.ts";
import {
  decodeAddress,
  decodeWord,
  encodeCall0,
  SIGNATURES,
  topicOf,
} from "@creaton/core/launchpad/work.ts";
import type { WorkChain } from "@creaton/core/launchpad/workRead.ts";

const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const TOPIC_TRANSFER = topicOf("Transfer(address,address,uint256)");
const HOLDING_AGE = "holdingAge(address)";

/** The most transfers added up. A DAO with more is not listed (a partial history would give wrong balances). */
export const MAX_TRANSFERS = 20_000;
/** The largest holders listed. */
export const SHOWN_HOLDERS = 10;

interface Holder {
  /** Lower-case address. */
  holder: string;
  /** Shares held, in base units. */
  balance: bigint;
  /** Of those, the Shares still locked behind milestones. */
  locked: bigint;
  /** Seconds the holding has lasted, or null when the DAO does not keep it. */
  age: number | null;
}

export interface HoldersRead {
  /** The largest holders, biggest first. */
  holders: Holder[];
  /** How many wallets hold any Shares. */
  found: number;
  /** All the Shares there are, in base units. */
  supply: bigint;
  /** Whether the transfer history added up to the whole supply. When false the list may be missing holders. */
  accounted: boolean;
  /** Whether holding times could be read for this DAO. */
  tracked: boolean;
  /** The history had more transfers than are added up, so nothing is listed. */
  tooMany: boolean;
}

const isRevert = (error: unknown): boolean =>
  error instanceof Error && /revert/i.test(error.message);

const addressOf = (topic: unknown): string | null =>
  typeof topic === "string" && /^0x[0-9a-fA-F]{64}$/.test(topic)
    ? `0x${topic.slice(-40)}`.toLowerCase()
    : null;

interface Transfer {
  from: string | null;
  to: string | null;
  value: bigint;
}

function parseTransfer(raw: unknown): Transfer | null {
  if (raw === null || typeof raw !== "object") return null;
  const log = raw as { topics?: unknown; data?: unknown };
  if (!Array.isArray(log.topics) || typeof log.data !== "string") return null;
  if (log.topics.length < 3) return null;
  try {
    return {
      from: addressOf(log.topics[1]),
      to: addressOf(log.topics[2]),
      value: BigInt(log.data === "0x" ? "0x0" : log.data),
    };
  } catch {
    return null;
  }
}

/** Each wallet's balance from a transfer history. Mints come from the zero address and burns go to it. */
export function balancesFromTransfers(
  transfers: readonly Transfer[],
): Map<string, bigint> {
  const balances = new Map<string, bigint>();
  const add = (who: string | null, delta: bigint) => {
    if (who === null || who === ZERO_ADDRESS) return;
    balances.set(who, (balances.get(who) ?? 0n) + delta);
  };
  for (const t of transfers) {
    add(t.from, -t.value);
    add(t.to, t.value);
  }
  for (const [who, balance] of balances) {
    if (balance <= 0n) balances.delete(who);
  }
  return balances;
}

const none = (supply: bigint, tooMany = false): HoldersRead => ({
  holders: [],
  found: 0,
  supply,
  accounted: !tooMany,
  tracked: false,
  tooMany,
});

/** The DAO's largest Shares holders, with how long they have held and what is still locked. */
export async function readHolders(
  chain: WorkChain,
  dao: string,
): Promise<HoldersRead> {
  const shares = decodeAddress(
    await chain.call(dao, encodeCall0(LOCK_SIGNATURES.daoShares)),
  );
  if (shares === ZERO_ADDRESS) return none(0n);
  const supply = decodeWord(
    await chain.call(shares, encodeCall0("totalSupply()")),
  );

  const raw = await chain.logs({ address: shares, topics: [TOPIC_TRANSFER] });
  if (raw.length > MAX_TRANSFERS) return none(supply, true);
  const transfers = raw.flatMap((log) => {
    const t = parseTransfer(log);
    return t ? [t] : [];
  });
  const balances = balancesFromTransfers(transfers);
  const accounted =
    [...balances.values()].reduce((sum, b) => sum + b, 0n) === supply;

  const biggest = [...balances.entries()]
    .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : a[0] < b[0] ? -1 : 1))
    .slice(0, SHOWN_HOLDERS);

  // The voting policy that keeps holding times; a DAO without one is listed without times.
  let policy: string | null = null;
  try {
    const answer = decodeAddress(
      await chain.call(dao, encodeCall0(SIGNATURES.policy)),
    );
    policy = answer === ZERO_ADDRESS ? null : answer;
  } catch (error) {
    if (!isRevert(error)) throw error;
  }

  let tracked = false;
  const holders: Holder[] = [];
  for (const [holder, fromHistory] of biggest) {
    let balance = fromHistory;
    let age: number | null = null;
    if (policy) {
      try {
        const hex = await chain.call(
          policy,
          encodeFunctionData(HOLDING_AGE, ["address"], [holder]),
        );
        balance = decodeWord(hex);
        age = Number(decodeWord(`0x${hex.replace(/^0x/, "").slice(64)}`));
        tracked = true;
      } catch (error) {
        // A policy made before the ledger answers with a revert: the DAO simply does not keep holding times.
        if (!isRevert(error)) throw error;
        policy = null;
      }
    }
    const lock = await readMilestoneLock(chain, dao, holder);
    holders.push({ holder, balance, locked: lock?.locked ?? 0n, age });
  }
  holders.sort((a, b) =>
    b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0,
  );
  return {
    holders,
    found: balances.size,
    supply,
    accounted,
    tracked,
    tooMany: false,
  };
}

/** A holding as a share of all Shares, in percent with one decimal ("12.5"), or null when the supply is not known. */
export function percentOfSupply(
  balance: bigint,
  supply: bigint,
): string | null {
  if (supply <= 0n) return null;
  const tenths = (balance * 1000n) / supply;
  return `${tenths / 10n}.${tenths % 10n}`;
}

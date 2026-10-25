/**
 * Reads what the runway card needs (N4) from the chain: the treasury's balance, what its work budgets still hold or have
 * reserved for submissions, and every payment that counts as spending, with when it was made. Bounded like every
 * other reader: a history longer than the bound is reported as incomplete, never silently cut.
 *
 * The chain is injected, so `runway-read.test.mjs` runs the real reader against a fake one.
 */

import { encodeFunctionData } from "@creaton/core/launchpad/evmAbi.ts";
import {
  claimKey,
  type RecordChain,
  type RecordEvents,
} from "./record-read.ts";
import { classifyOutflows, type Outflow, type Spend } from "./runway.ts";
import { TOPIC_TRANSFER } from "./contributions.ts";
import { encodeBalanceOf } from "./work-bounty.ts";
import {
  addressTopic,
  decodeAddress,
  decodeWord,
  encodeCall0,
} from "./work.ts";
import type { WorkSnapshot } from "./work-read.ts";

/** At most this many outflows and exits of the treasury are read; more makes the figures incomplete. */
export const MAX_RUNWAY_LOGS = 500;
const ZERO_WORD = `0x${"0".repeat(64)}`;

export interface RunwayInputs {
  free: bigint | null;
  setAside: bigint | null;
  spends: Spend[];
  incomplete: boolean;
}

interface Log {
  topics: string[];
  data: string;
  block: number;
  tx: string | null;
}

function parse(raw: unknown): Log | null {
  if (raw === null || typeof raw !== "object") return null;
  const log = raw as {
    topics?: unknown;
    data?: unknown;
    blockNumber?: unknown;
    transactionHash?: unknown;
  };
  if (!Array.isArray(log.topics) || typeof log.data !== "string") return null;
  if (!log.topics.every((t) => typeof t === "string")) return null;
  let block = 0;
  try {
    block = Number(BigInt(String(log.blockNumber ?? "0x0")));
  } catch {
    return null;
  }
  const tx =
    typeof log.transactionHash === "string" &&
    /^0x[0-9a-fA-F]{64}$/.test(log.transactionHash)
      ? log.transactionHash.toLowerCase()
      : null;
  return { topics: log.topics as string[], data: log.data, block, tx };
}

async function balance(
  chain: RecordChain,
  token: string,
  holder: string,
): Promise<bigint | null> {
  try {
    return decodeWord(await chain.call(token, encodeBalanceOf(holder)));
  } catch {
    return null;
  }
}

export async function readRunwayInputs(
  chain: RecordChain,
  input: {
    dao: string;
    currency: string;
    shares: string;
    work: WorkSnapshot;
    /** When each submission was paid (the track record's read); undefined while it is read. */
    record: RecordEvents | undefined;
  },
): Promise<RunwayInputs> {
  const { dao, currency, shares, work, record } = input;
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  // Only budgets in the DAO's own currency are added up; one in another currency is left out of every figure.
  const budgets = work.mandates.filter((m) =>
    same(m.created.currency, currency),
  );
  let incomplete = work.truncated || record === undefined;

  const lootAddress = chain
    .call(dao, encodeCall0("loot()"))
    .then(decodeAddress)
    .catch(() => null);
  const [free, budgetHeld, outLogs, shareBurns, loot] = await Promise.all([
    balance(chain, currency, dao),
    Promise.all(
      budgets.map(async (m) => {
        const held = await balance(chain, currency, m.address);
        const reserved = await Promise.all(
          m.claims
            .filter(
              (c) =>
                c.record.status === "Open" || c.record.status === "Approved",
            )
            .map(async (c) =>
              decodeWord(
                await chain.call(
                  m.claimsAddress,
                  encodeFunctionData("funded(bytes32)", ["bytes32"], [c.id]),
                ),
              ),
            ),
        );
        return held === null
          ? null
          : held + reserved.reduce((a, b) => a + b, 0n);
      }),
    ).catch(() => null),
    chain.logs({
      address: currency,
      topics: [TOPIC_TRANSFER, addressTopic(dao)],
    }),
    chain.logs({ address: shares, topics: [TOPIC_TRANSFER, null, ZERO_WORD] }),
    lootAddress,
  ]);
  const lootBurns =
    loot && !/^0x0+$/.test(loot)
      ? await chain.logs({
          address: loot,
          topics: [TOPIC_TRANSFER, null, ZERO_WORD],
        })
      : [];

  const setAside =
    budgetHeld === null || budgetHeld.some((b) => b === null)
      ? null
      : (budgetHeld as bigint[]).reduce((a, b) => a + b, 0n);

  // Leaving burns Shares (or Loot) in the same transaction that pays the leaver: that is what marks an exit.
  const exitTxs = new Set(
    [...shareBurns, ...lootBurns].flatMap((raw) => {
      const log = parse(raw);
      return log?.tx ? [log.tx] : [];
    }),
  );
  const parsedOut = outLogs.flatMap((raw) => {
    const log = parse(raw);
    return log && log.topics.length === 3 ? [log] : [];
  });
  if (parsedOut.length > MAX_RUNWAY_LOGS) incomplete = true;
  const recent = parsedOut.slice(-MAX_RUNWAY_LOGS);
  const times = await chain.blockTimes([
    ...new Set(recent.map((l) => l.block)),
  ]);
  const outflows: Outflow[] = recent.map((l) => ({
    to: decodeAddress(l.topics[2]),
    amount: decodeWord(l.data),
    tx: l.tx,
    at: times.get(l.block) ?? null,
  }));
  const { spent } = classifyOutflows(
    outflows,
    work.mandates.map((m) => m.address),
    exitTxs,
  );

  // What work budgets paid to approved submissions, at the time each was paid out.
  const payouts: Spend[] = budgets.flatMap((m) =>
    m.claims
      .filter((c) => c.record.status === "Paid" && c.record.amount > 0n)
      .map((c) => ({
        amount: c.record.amount,
        at: record?.paidAt.get(claimKey(m.address, c.id)) ?? null,
      })),
  );

  return {
    free,
    setAside,
    spends: [...spent.map((o) => ({ amount: o.amount, at: o.at })), ...payouts],
    incomplete: incomplete || (record?.truncated ?? false),
  };
}

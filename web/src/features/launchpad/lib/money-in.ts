/**
 * Money that came into a DAO's treasury, in its currency, read from the currency's own `Transfer` events (D78).
 *
 * The raise is one payment (from the sale's auction, through its executor); work budgets return what they did not
 * use; the milestone lock pays in half a bond after an upheld objection, or a deposit after a failed one. Everything
 * else was paid in by someone, which is where a team's revenue pledge shows up: the card lists those payments, by whom
 * and when, and never calls them revenue, because the chain cannot say what a payment was for.
 *
 * Pure and alias-free: `money-in.test.mjs` drives it under `node --test`.
 */

/** `keccak256("Transfer(address,address,uint256)")`. */
export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** `fundsRecipient()` on the sale's auction: the executor that passes the raise to the DAO. */
const SELECTOR_FUNDS_RECIPIENT = "0x3b6fd2cf";

export interface IncomingTransfer {
  from: string;
  amount: bigint;
  tx: string;
  block: number;
  /** Unix seconds of its block once looked up; null when the block's time could not be read. */
  at?: number | null;
}

export interface MoneyIn {
  raise: bigint;
  fromBudgets: bigint;
  fromLocks: bigint;
  /** Everything else, newest first. */
  paidIn: IncomingTransfer[];
  paidInTotal: bigint;
}

const topicAddress = (topic: string) => `0x${topic.slice(-40)}`.toLowerCase();

/** The currency's `Transfer` logs that pay the DAO, as transfers. */
export function transfersInFromLogs(
  logs: readonly {
    topics: readonly string[];
    data: string;
    blockNumber: string;
    transactionHash: string;
  }[],
  dao: string,
): IncomingTransfer[] {
  const to = dao.toLowerCase();
  return logs.flatMap((log) => {
    if (log.topics.length < 3 || log.topics[0].toLowerCase() !== TRANSFER_TOPIC)
      return [];
    if (topicAddress(log.topics[2]) !== to) return [];
    try {
      return [
        {
          from: topicAddress(log.topics[1]),
          amount: BigInt(log.data),
          tx: log.transactionHash,
          block: Number(BigInt(log.blockNumber)),
        },
      ];
    } catch {
      return [];
    }
  });
}

export function summariseMoneyIn(input: {
  transfers: readonly IncomingTransfer[];
  /** The auction and its executor. */
  raise: readonly string[];
  /** The DAO's work budgets. */
  budgets: readonly string[];
  /** The milestone lock. */
  locks: readonly string[];
}): MoneyIn {
  const set = (list: readonly string[]) =>
    new Set(list.map((a) => a.toLowerCase()));
  const raise = set(input.raise);
  const budgets = set(input.budgets);
  const locks = set(input.locks);
  const summary: MoneyIn = {
    raise: 0n,
    fromBudgets: 0n,
    fromLocks: 0n,
    paidIn: [],
    paidInTotal: 0n,
  };
  for (const transfer of input.transfers) {
    const from = transfer.from.toLowerCase();
    if (raise.has(from)) summary.raise += transfer.amount;
    else if (budgets.has(from)) summary.fromBudgets += transfer.amount;
    else if (locks.has(from)) summary.fromLocks += transfer.amount;
    else {
      summary.paidIn.push(transfer);
      summary.paidInTotal += transfer.amount;
    }
  }
  summary.paidIn.sort((a, b) => b.block - a.block);
  return summary;
}

export function moneyInHeadline(
  summary: MoneyIn,
  money: (units: bigint) => string,
): string {
  const count = summary.paidIn.length;
  if (count === 0) {
    return "Nothing has been paid into the treasury besides the raise yet.";
  }
  return `Besides the raise, ${money(summary.paidInTotal)} was paid into the treasury in ${count} payment${count === 1 ? "" : "s"}.`;
}

/** What `readMoneyIn` needs of the chain (the record's chain fits). */
export interface MoneyInChain {
  call(to: string, data: string): Promise<string>;
  logs(filter: {
    address: string;
    topics: (string | null)[];
  }): Promise<readonly unknown[]>;
  /** The time, in seconds, of each block that could be fetched; one that could not is left out. */
  blockTimes(blocks: readonly number[]): Promise<ReadonlyMap<number, number>>;
}

const LOCK_GUARD = "0x36bc529d";
const SHARES = "0x03314efa"; // shares()
/** The most distinct blocks whose time is looked up for the payments listed. */
const MAX_DATED = 200;

function addressWord(hex: string): string {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (body.length !== 64 || !/^[0-9a-fA-F]+$/.test(body)) {
    throw new Error("money-in: expected an address word");
  }
  return `0x${body.slice(24).toLowerCase()}`;
}

/**
 * Money that came into the DAO in its currency, sorted by where it came from, with each other payment's date.
 *
 * Every source address is read before anything is sorted, and a read that fails fails the whole answer: an unknown
 * executor or lock would put the raise, or a bond, among the payments made besides it. The page then says it could
 * not tell, rather than show a figure.
 */
export async function readMoneyIn(
  chain: MoneyInChain,
  input: {
    dao: string;
    currency: string;
    auction: string | null;
    shares: string | null;
    budgets: readonly string[];
  },
): Promise<MoneyIn> {
  const { dao, currency, auction, budgets } = input;
  const shares = input.shares ?? addressWord(await chain.call(dao, SHARES));
  const [logs, executor, lock] = await Promise.all([
    chain.logs({
      address: currency,
      topics: [
        TRANSFER_TOPIC,
        null,
        `0x${dao.slice(2).toLowerCase().padStart(64, "0")}`,
      ],
    }),
    auction
      ? chain.call(auction, SELECTOR_FUNDS_RECIPIENT).then(addressWord)
      : Promise.resolve(null),
    chain.call(shares, LOCK_GUARD).then(addressWord),
  ]);
  const summary = summariseMoneyIn({
    transfers: transfersInFromLogs(
      logs as Parameters<typeof transfersInFromLogs>[0],
      dao,
    ),
    raise: [auction, executor].filter((a): a is string => a !== null),
    budgets,
    locks: /^0x0{40}$/.test(lock) ? [] : [lock],
  });
  // The newest payments' dates; one whose block time could not be read says so (null), never a guessed date.
  const blocks = [...new Set(summary.paidIn.map((p) => p.block))].slice(
    0,
    MAX_DATED,
  );
  const times = blocks.length > 0 ? await chain.blockTimes(blocks) : new Map();
  return {
    ...summary,
    paidIn: summary.paidIn.map((p) => ({
      ...p,
      at: times.get(p.block) ?? null,
    })),
  };
}

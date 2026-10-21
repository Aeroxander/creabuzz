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
export const SELECTOR_FUNDS_RECIPIENT = "0x3b6fd2cf";

export interface IncomingTransfer {
  from: string;
  amount: bigint;
  tx: string;
  block: number;
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

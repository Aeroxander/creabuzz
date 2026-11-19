/**
 * Looking for a task's payment on the chain: a draw from the allowance box to the worker's wallet of exactly what the task
 * pays, made after the work was accepted. It is how a payment that went out without its record (a Pair's second signer
 * confirmed it, the page was closed, another device paid it) is found and linked to its task, and it stops a second payment
 * for work that was already paid for. It only reads; what it finds is offered to a person, never saved on its own.
 */
import { decodeParameters } from "@creaton/core/launchpad/evmAbi.ts";
import { addressTopic, topicOf } from "@creaton/core/launchpad/work.ts";
import type { ChainLog, MoneyWallet } from "../money/wallet";
import { readLogsBack } from "../money/wallet";

const DRAWN_TOPIC = topicOf("AllowanceDrawn(address,address,uint256,uint256)");
const TX = /^0x[0-9a-fA-F]{64}$/;
/** How far back to look, in blocks: three pieces of ten thousand (bounded, and said when it falls short). */
const CHUNK = 10_000;
const PIECES = 3;
/** A block's time may sit this far before the acceptance's own clock and still count. */
const SKEW_SECS = 3_600;

/** The search could not rule out an earlier payment: it did not reach back to the acceptance, or the time of its start is unknown. */
export class PaymentSearchShort extends Error {
  constructor() {
    super(
      "The search for an earlier payment did not reach back to the day the work was accepted.",
    );
    this.name = "PaymentSearchShort";
  }
}

export interface FoundPayment {
  txHash: string;
  /** The block's time in seconds, when the network could say it. */
  at: number | null;
}

/** The amount of an `AllowanceDrawn` log, or null when the log is not one this reads. */
function amountOf(log: ChainLog): bigint | null {
  try {
    const [amount] = decodeParameters(["uint256", "uint256"], log.data);
    return typeof amount === "bigint" ? amount : null;
  } catch {
    return null;
  }
}

/**
 * The newest draw from `treasury` to `payee` of exactly `raw` dollars (raw units) made at or after `since` (seconds), or null.
 * `taken` are payments already recorded for other tasks: they are never offered again. A network that cannot say a block's
 * time is trusted on amount and payee alone for what it finds. It throws (never "nothing found") when the logs cannot be
 * read, and `PaymentSearchShort` when nothing was found and the window starts after the acceptance (or its start time is
 * unknown): an earlier payment could lie before it, so the caller must not treat that as "not paid yet".
 */
export async function findPayment(
  wallet: Pick<MoneyWallet, "getLogs" | "blockNumber" | "blockTime">,
  treasury: string,
  payee: string,
  raw: bigint,
  since: number,
  taken: ReadonlySet<string> = new Set(),
): Promise<FoundPayment | null> {
  const head = await wallet.blockNumber();
  const start = Math.max(0, head - CHUNK * PIECES + 1);
  const found = await readLogsBack(
    wallet,
    {
      address: treasury,
      topics: [DRAWN_TOPIC, null, addressTopic(payee)],
    },
    {
      from: start,
      to: head,
      chunk: CHUNK,
      pieces: PIECES,
    },
  );
  const hits = found.logs.filter(
    (log) =>
      amountOf(log) === raw &&
      typeof log.transactionHash === "string" &&
      TX.test(log.transactionHash) &&
      !taken.has(log.transactionHash.toLowerCase()),
  );
  // Newest first: the payment nearest the acceptance is the likeliest one.
  for (const log of hits.reverse()) {
    let at: number | null = null;
    if (wallet.blockTime) {
      try {
        at = await wallet.blockTime(Number(BigInt(log.blockNumber)));
      } catch {
        at = null;
      }
    }
    if (at !== null && at + SKEW_SECS < since) continue;
    return { txHash: (log.transactionHash as string).toLowerCase(), at };
  }
  if (!found.complete || (start > 0 && !(await reaches(wallet, start, since))))
    throw new PaymentSearchShort();
  return null;
}

/** Whether the block the search starts at is no later than the acceptance (a start whose time is unknown does not count). */
async function reaches(
  wallet: Pick<MoneyWallet, "blockTime">,
  start: number,
  since: number,
): Promise<boolean> {
  if (!wallet.blockTime) return false;
  try {
    return (await wallet.blockTime(start)) <= since + SKEW_SECS;
  } catch {
    return false;
  }
}

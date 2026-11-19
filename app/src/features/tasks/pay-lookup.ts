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
 * time is trusted on amount and payee alone.
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
  const found = await readLogsBack(
    wallet,
    {
      address: treasury,
      topics: [DRAWN_TOPIC, null, addressTopic(payee)],
    },
    {
      from: Math.max(0, head - CHUNK * PIECES + 1),
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
  return null;
}

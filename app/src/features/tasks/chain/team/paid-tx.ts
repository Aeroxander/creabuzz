/**
 * The transaction that paid a task, read from the network by the task's number (plan section 5.5): the log the book writes
 * when it ends a task, of that serial. The team's record names this transaction, so it is never taken from what a sheet
 * sent: after a Pair's proposal, a reload or a call replaced in the wallet, the hash a sheet knows is not the payment, and a
 * search by amount cannot find a part payment.
 */
import { signatureOf } from "@creaton/core/pot/abi-codec.ts";
import { TASK_BOOK_ABI } from "@creaton/core/pot/abis.generated.ts";
import { topicOf } from "@creaton/core/launchpad/work.ts";
import { type MoneyWallet, readLogsBack } from "../../../money/wallet";

const RESOLVED = (() => {
  const item = TASK_BOOK_ABI.find(
    (i) => i.type === "event" && i.name === "TaskResolved",
  );
  if (!item) throw new Error("The task book's ABI has no TaskResolved event.");
  return topicOf(signatureOf(item));
})();

/** How far back one look goes: pieces of this many blocks, at most `PIECES` of them (a payment is a recent thing). */
const CHUNK = 10_000;
const PIECES = 6;
const TX = /^0x[0-9a-f]{64}$/;

/**
 * The transaction that ended task `serial` of `book`, or null when none is found in the stretch looked at (the caller then
 * says so and the press can be tried again: nothing is written on a guess). `bookBlock` is where the book began, so a look
 * never goes before it. Throws when the network cannot be asked.
 */
export async function readPaidTx(
  wallet: Pick<MoneyWallet, "blockNumber" | "getLogs">,
  book: string,
  serial: bigint,
  bookBlock: number,
): Promise<string | null> {
  const head = await wallet.blockNumber();
  const found = await readLogsBack(
    wallet,
    {
      address: book,
      topics: [RESOLVED, `0x${serial.toString(16).padStart(64, "0")}`],
    },
    {
      from: Math.max(0, bookBlock, head - CHUNK * PIECES),
      to: head,
      chunk: CHUNK,
      pieces: PIECES,
    },
  );
  const wanted = `0x${serial.toString(16).padStart(64, "0")}`;
  const own = found.logs.filter(
    (log) =>
      log.address.toLowerCase() === book.toLowerCase() &&
      log.topics[0]?.toLowerCase() === RESOLVED &&
      log.topics[1]?.toLowerCase() === wanted &&
      TX.test((log.transactionHash ?? "").toLowerCase()),
  );
  // A task ends once; the newest is the one if a node ever answered twice.
  const last = own[own.length - 1];
  return last?.transactionHash?.toLowerCase() ?? null;
}

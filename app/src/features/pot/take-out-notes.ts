/**
 * After a Take out lands: which tasks it left money owed on (the book's claims it wrote), read from that transaction's own
 * logs and kept in this browser's history so the "Money you can claim" list finds them without a look back (plan section
 * 5.10). Best effort in every way: it never gates, delays or fails the Take out, a failed read loses nothing (the look-back
 * finds the same claims), and what it finds is read from the network again before anything is shown.
 */
import { signatureOf } from "@creaton/core/pot/abi-codec.ts";
import { TASK_BOOK_ABI } from "@creaton/core/pot/abis.generated.ts";
import { topicOf } from "@creaton/core/launchpad/work.ts";
import { readBookOf } from "@creaton/core/pot/pot-reads.ts";
import { type MoneyWallet, readLogsBack } from "../money/wallet";
import { rememberNotes } from "./own-history";
import type { Ready } from "./use-pot";

const MINTED = (() => {
  const item = TASK_BOOK_ABI.find(
    (i) => i.type === "event" && i.name === "NoteMinted",
  );
  if (!item) throw new Error("The task book's ABI has no NoteMinted event.");
  return topicOf(signatureOf(item));
})();

/** A step that just landed is among the newest blocks: look back this far, in pieces the node will answer. */
const RECENT_BLOCKS = 500;
const TX = /^0x[0-9a-f]{64}$/;

/** The serials of the tasks the transaction `txHash` wrote claims on for `holder`, in the book `book`. Throws when the network cannot be asked. */
async function mintedSerials(
  wallet: Pick<MoneyWallet, "blockNumber" | "getLogs">,
  book: string,
  holder: string,
  txHash: string,
): Promise<bigint[]> {
  const head = await wallet.blockNumber();
  const holderTopic = `0x${holder.toLowerCase().slice(2).padStart(64, "0")}`;
  const found = await readLogsBack(
    wallet,
    {
      address: book,
      topics: [MINTED, null, holderTopic],
    },
    {
      from: Math.max(0, head - RECENT_BLOCKS),
      to: head,
      chunk: RECENT_BLOCKS,
      pieces: 1,
    },
  );
  const serials: bigint[] = [];
  for (const log of found.logs) {
    if (
      log.address.toLowerCase() !== book.toLowerCase() ||
      log.topics[0]?.toLowerCase() !== MINTED ||
      log.topics.length !== 3 ||
      log.topics[2]?.toLowerCase() !== holderTopic ||
      (log.transactionHash ?? "").toLowerCase() !== txHash.toLowerCase() ||
      !TX.test(txHash.toLowerCase())
    )
      continue;
    serials.push(BigInt(log.topics[1] ?? "0x0"));
  }
  return serials;
}

/** Reads the claims a landed Take out wrote and keeps them in the step's history. Never throws and is never waited on. */
export async function trackNotes(
  ready: Ready,
  treasury: string,
  txHash: string,
): Promise<void> {
  try {
    const book = await readBookOf(ready.read, treasury);
    if (book === null) return;
    const serials = await mintedSerials(
      ready.wallet,
      book,
      ready.address,
      txHash,
    );
    rememberNotes(ready.address, txHash, serials);
  } catch {
    // Nothing is lost: the look-back finds the same claims.
  }
}

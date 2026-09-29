/**
 * The one place a peer's message becomes a change to the live document.
 *
 * `wiki-sync.ts` routes every Trystero message through `receiveIntoDoc`: it is
 * applied to the Yjs document only if it passes the whole accept path
 * (`live-auth.ts`). Nothing else in the wiki writes a peer's bytes into a doc.
 *
 * Deliberately free of `@/` imports so `node --test` can exercise it.
 */

import type * as Y from "yjs";

import type { AcceptRejection, LiveReceiver } from "./live-auth.ts";
import type { PeerBook } from "./live-peers.ts";
import { applyPeerUpdate } from "./sync-loop.ts";

export type ReceiveResult =
  | {
      accepted: true;
      /** The update taught the document something new. */
      advanced: boolean;
      /** First accepted message from this peer: it is now verified. */
      newlyVerified: boolean;
      signer: string;
    }
  | { accepted: false; reason: AcceptRejection | "bad-update" | "cancelled" };

export async function receiveIntoDoc(input: {
  doc: Y.Doc;
  receiver: LiveReceiver;
  book: PeerBook;
  data: unknown;
  peerId: string;
  /** Checked after the async accept: the document may be gone by then. */
  isCancelled?: () => boolean;
}): Promise<ReceiveResult> {
  const result = await input.receiver.accept(input.data, input.peerId);
  if (!result.ok) return { accepted: false, reason: result.reason };
  if (input.isCancelled?.()) {
    return { accepted: false, reason: "cancelled" };
  }
  const newlyVerified = input.book.markVerified(input.peerId, result.signer);
  let advanced = false;
  try {
    advanced = applyPeerUpdate(input.doc, result.update);
  } catch {
    // A member signed bytes that are not a valid Yjs update.
    return { accepted: false, reason: "bad-update" };
  }
  return { accepted: true, advanced, newlyVerified, signer: result.signer };
}

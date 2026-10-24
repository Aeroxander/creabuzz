/**
 * A transaction, linked to the chain's explorer when it has a known one and shown as its raw hash with a plain "no
 * explorer" note when it does not, never a dead link. Every payment the pages list carries one, so anyone can check it.
 */

import { truncatePubkey } from "@/shared/lib/pubkey";

import { explorerTxUrl } from "../lib/fund-flow";

export function TxLink({ chainId, tx }: { chainId: number; tx: string }) {
  const url = explorerTxUrl(chainId, tx);
  return url ? (
    <a
      className="break-all text-sky-700 underline dark:text-sky-300"
      data-testid="tx-link"
      href={url}
      rel="noreferrer"
      target="_blank"
    >
      {truncatePubkey(tx)}
    </a>
  ) : (
    <span
      className="break-all text-black/60 dark:text-white/60"
      data-testid="tx-link"
      title="This network has no public page for transactions, so only its id is shown."
    >
      {truncatePubkey(tx)}
    </span>
  );
}

/** A payment's day, or that the chain gave none (a dated history must not guess). */
export function paidOn(seconds: number | null | undefined): string {
  return seconds
    ? new Date(seconds * 1000).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : "date not read";
}

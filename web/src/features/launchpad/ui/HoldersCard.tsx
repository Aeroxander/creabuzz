/**
 * Who holds a DAO's Shares: the largest holders, what share of all Shares each has, how long each has held, and how much
 * of a holding is still locked behind milestones.
 *
 * Read from the network like the rest of the track record. A holder is a wallet; a name appears only where exactly one
 * person on this server has bound that wallet, and always beside the start and end of the address. When the history
 * does not add up to the whole supply the card says the list may be incomplete, and a read that fails says so instead
 * of showing an empty list.
 */

import { Card } from "@/shared/ui/card";

import { formatAtomic } from "../lib/amounts";
import { type HoldersRead, percentOfSupply } from "../lib/holders-read";
import { countOf } from "@/shared/lib/count-of";

const shares = (atomic: bigint): string =>
  formatAtomic(atomic, 18, { maxFractionDigits: 0 });

const DAY = 86_400;

/** How long, in the words a person says it: "less than a day", "12 days", "5 months", "2 years". */
function heldFor(seconds: number): string {
  const days = Math.floor(seconds / DAY);
  if (days < 1) return "less than a day";
  if (days < 2) return "1 day";
  if (days < 60) return `${days} days`;
  const months = Math.floor(days / 30);
  if (months < 24) return `${months} months`;
  return `${Math.floor(days / 365)} years`;
}

export function HoldersCard({
  read,
  loading,
  failed,
  dao,
  labelOf,
  contracts,
}: {
  read: HoldersRead | undefined;
  loading: boolean;
  failed: boolean;
  dao: string;
  labelOf: (address: string) => string;
  /** Names for the DAO's own contracts that hold Shares (reviewers' bonds, work budgets), by lowercase address. */
  contracts?: ReadonlyMap<string, string>;
}) {
  return (
    <Card className="p-4" data-testid="record-holders">
      <h3 className="text-sm font-semibold">Who holds the Shares</h3>
      {loading ? (
        <p className="mt-1 text-sm text-muted-foreground">Reading…</p>
      ) : failed || !read ? (
        <p className="mt-1 text-sm text-muted-foreground">
          Couldn't read who holds the Shares. Try again in a moment.
        </p>
      ) : read.tooMany ? (
        <p className="mt-1 text-sm text-muted-foreground">
          There have been too many moves of these Shares to add up here.
        </p>
      ) : read.holders.length === 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">
          Nobody holds any Shares yet.
        </p>
      ) : (
        <>
          <p className="mt-1 text-sm text-muted-foreground">
            {read.holders.length === read.found
              ? `${countOf(read.found, "wallet")} ${read.found === 1 ? "holds" : "hold"} Shares.`
              : `The largest ${read.holders.length} of ${read.found} wallets that hold Shares.`}{" "}
            {read.tracked
              ? "Time held is the average moment the Shares were acquired: buying more brings it down, and Shares passed to another wallet do not take their time with them."
              : "This DAO was made before holding times were kept, so only what each wallet holds is shown."}
          </p>
          <ul className="mt-3 divide-y divide-border/60">
            {read.holders.map((holder) => {
              const percent = percentOfSupply(holder.balance, read.supply);
              const isDao = holder.holder === dao.toLowerCase();
              return (
                <li
                  className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 text-sm"
                  data-testid="record-holder"
                  key={holder.holder}
                >
                  <span className="min-w-0 font-medium">
                    {isDao
                      ? "The DAO itself"
                      : (contracts?.get(holder.holder) ??
                        labelOf(holder.holder))}
                  </span>
                  <span className="text-right tabular-nums">
                    <span data-testid="record-holder-share">
                      {percent === null ? "" : `${percent}% · `}
                      {shares(holder.balance)} Shares
                    </span>
                    {holder.age !== null ? (
                      <span
                        className="block text-xs text-muted-foreground"
                        data-testid="record-holder-age"
                      >
                        held for {heldFor(holder.age)}
                      </span>
                    ) : null}
                    {holder.locked > 0n ? (
                      <span
                        className="block text-xs text-muted-foreground"
                        data-testid="record-holder-locked"
                      >
                        {shares(holder.locked)} held back until milestones are
                        reached
                      </span>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
          {!read.accounted ? (
            <p
              className="mt-2 text-xs text-amber-700 dark:text-amber-400"
              data-testid="record-holders-incomplete"
            >
              The history of moves did not add up to all the Shares, so this
              list may be missing some holders.
            </p>
          ) : null}
        </>
      )}
    </Card>
  );
}

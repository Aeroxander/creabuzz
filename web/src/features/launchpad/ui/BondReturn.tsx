/**
 * A reviewer taking their bond back, from the page.
 *
 * Posting a bond was a button; getting it back was not, so a reviewer who was done had no way to leave with their money
 * short of calling the contract by hand. Two steps, as the contract has them: ask for it (it stops counting toward
 * judging at once and stays at risk for 14 days), then take it once the days have passed.
 */

import { Button } from "@/shared/ui/button";

import {
  encodeRequestUnbond,
  encodeWithdraw,
} from "@creaton/core/launchpad/work.ts";
import type { MandateView } from "@creaton/core/launchpad/workRead.ts";

const day = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

export function BondReturn({
  mandate,
  chainTime,
  money,
  blocked,
  onSend,
  onRetry,
}: {
  mandate: MandateView;
  /** The chain's own clock, not the browser's. */
  chainTime: number;
  /** An amount of the bond, in its own token. */
  money: (units: bigint) => string;
  /** A transaction is already in flight or the wallet is not ready. */
  blocked: boolean;
  onSend: (key: string, to: string, data: string) => Promise<boolean>;
  /** Read the bond again. */
  onRetry: () => void;
}) {
  const { walletStake, walletUnbond } = mandate;
  // The bond's terms (its token, its least amount) can fail to read while a bond is waiting to come back: the return
  // surface must not depend on them. Only a budget confirmed to ask no bond has nothing to return.
  const termsUnreadable = !mandate.bond && mandate.bondUnreadable;
  if (!mandate.walletIsReviewer || (!mandate.bond && !termsUnreadable))
    return null;
  // A read that failed is not "nothing waiting": after asking for the whole bond the stake is zero and the pending
  // amount is the only sign of the money, so say it could not be read and let them try again.
  if (mandate.walletBondUnreadable) {
    return (
      <div
        className="mt-2 rounded-lg border border-black/10 p-3 text-sm dark:border-white/10"
        data-testid="work-bond-unreadable"
        role="status"
      >
        <p>
          Could not check whether a bond of yours is waiting to come back. It is
          not lost; the network just did not answer.
        </p>
        <Button
          className="mt-2"
          onClick={onRetry}
          size="sm"
          type="button"
          variant="outline"
        >
          Try again
        </Button>
      </div>
    );
  }
  if (walletStake === 0n && walletUnbond === null && !termsUnreadable)
    return null;
  const ready = walletUnbond !== null && chainTime >= walletUnbond.availableAt;
  return (
    <div
      className="mt-2 rounded-lg border border-black/10 p-3 text-sm dark:border-white/10"
      data-testid="work-bond-return"
    >
      {termsUnreadable ? (
        <div data-testid="work-bond-terms-unreadable">
          <p>
            This budget&apos;s bond terms could not be read. Amounts below are
            in the bond token&apos;s smallest units until they can.
          </p>
          <Button
            className="mt-2"
            onClick={onRetry}
            size="sm"
            type="button"
            variant="outline"
          >
            Try again
          </Button>
        </div>
      ) : null}
      {walletStake > 0n && !termsUnreadable ? (
        <>
          <p>
            Your bond here: {money(walletStake)}. You can ask for it back. It
            stops counting at once, so you cannot judge work until you put it
            down again, and it stays at risk for 14 days after you ask.
          </p>
          <Button
            className="mt-2"
            data-testid="work-unbond"
            disabled={blocked}
            onClick={() =>
              void onSend(
                `unbond-${mandate.address}`,
                mandate.verifiersAddress,
                encodeRequestUnbond(walletStake),
              )
            }
            size="sm"
            type="button"
            variant="outline"
          >
            Ask for my bond back
          </Button>
        </>
      ) : null}
      {walletUnbond !== null ? (
        <div className={walletStake > 0n || termsUnreadable ? "mt-3" : ""}>
          <p data-testid="work-unbond-pending">
            {money(walletUnbond.amount)} is on its way back.{" "}
            {ready
              ? "The waiting is over: you can take it now."
              : `It stays at risk until ${day(walletUnbond.availableAt)}.`}
          </p>
          {ready ? (
            <Button
              className="mt-2"
              data-testid="work-withdraw-bond"
              disabled={blocked}
              onClick={() =>
                void onSend(
                  `withdraw-${mandate.address}`,
                  mandate.verifiersAddress,
                  encodeWithdraw(),
                )
              }
              size="sm"
              type="button"
            >
              Take my bond back
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

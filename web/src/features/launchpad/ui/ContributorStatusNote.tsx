/**
 * What a contributor project is, said in its header (the contributor plan's C3): no token sale at setup, new Shares
 * only from awards, and whether its Shares can be traded right now, read from the Shares themselves (D77). Unknown is
 * said as unknown, never as locked.
 */

import { tradingState } from "../lib/trading-actions";
import { useShareRules } from "../use-share-rules";

const when = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

export function ContributorStatusNote({
  shares,
  dao,
}: {
  /** The project's Shares token; null when the record names none. */
  shares: string | null;
  dao: string | null;
}) {
  const read = useShareRules(shares, dao);
  // The header has no chain clock: an announced opening is said by its date, which the chain alone decides on.
  const state = tradingState(
    read.data?.rules ?? null,
    Math.floor(Date.now() / 1000),
  );
  const transfers = read.isError
    ? "Whether its Shares can be traded could not be read just now."
    : read.data?.predates
      ? "Its Shares were made before trading came with a 30-day notice."
      : state.phase === "open"
        ? "Trading is open: Shares can be sent between wallets."
        : state.phase === "locked"
          ? "Shares are locked: they cannot be sent between wallets."
          : state.phase === "announced" && state.opensAt
            ? `Opening trading was announced; a second vote can open it from ${when(state.opensAt)}.`
            : state.phase === "ready"
              ? "Opening trading was announced and its notice has passed; a vote can open it."
              : null;
  return (
    <div className="max-w-60 text-right text-xs text-muted-foreground">
      <p data-testid="contributor-note">
        No token sale at setup. New Shares come only from awards for reviewed
        work.
      </p>
      {transfers ? (
        <p className="mt-0.5" data-testid="contributor-transfers">
          {transfers}
        </p>
      ) : null}
    </div>
  );
}

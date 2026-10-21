/**
 * The year's allowance of new Shares (D76), in one sentence, read from the DAO's own Shares: how many an award can still
 * create this year and until when, or that this project's Shares come only from awards. Says nothing for Shares made
 * before the rule, and nothing while the read is under way.
 */

import { allowanceText } from "../lib/share-rules";
import { issuanceAllowance } from "../lib/trading-actions";
import { useShareRules } from "../use-share-rules";

const date = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

/** The allowance for awards, from the Shares' rules; null until it is known. */
export function useAllowance(shares: string | null, dao: string, now: number) {
  const read = useShareRules(shares, dao);
  if (!read.data) return null;
  return issuanceAllowance(read.data.rules, now, read.data.exitBase);
}

export function AllowanceNote({
  shares,
  dao,
  now,
}: {
  shares: string | null;
  dao: string;
  /** The chain's clock, in seconds. */
  now: number;
}) {
  const text = allowanceText(useAllowance(shares, dao, now), date);
  if (!text) return null;
  return (
    <p className="mt-2 text-sm" data-testid="work-allowance">
      {text}
    </p>
  );
}

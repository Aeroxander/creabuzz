import type { ChipTone } from "@/shared/ui/chip";

import type { ClaimStatus } from "@creaton/core/launchpad/work.ts";
import { paidOn, TxLink } from "./TxLink";

/**
 * When a claim was taken and in which transaction, or why that is not shown. A claim that asked for no money moved
 * none, so it says it was finished, never paid.
 */
export function PaidLine({
  sharesOnly,
  money,
  at,
  tx,
  chainId,
  unread,
  reading,
}: {
  /** A contributor project, where no claim can ask for money: saying so on each would be noise. */
  sharesOnly: boolean;
  money: boolean;
  at: number | undefined;
  tx: string | undefined;
  chainId: number;
  unread: boolean;
  reading: boolean;
}) {
  const what = money ? "paid" : "finished";
  return (
    <p
      className="mt-1 text-xs text-muted-foreground"
      data-testid="work-claim-paid"
    >
      {unread ? (
        `When it was ${what} could not be read just now.`
      ) : reading ? (
        `Reading when it was ${what}…`
      ) : tx ? (
        <>
          {money ? "Paid" : "Finished"} {paidOn(at)}
          <TxLink chainId={chainId} label="Record" lead=" · " tx={tx} />
          {money || sharesOnly ? null : " · No money was asked for."}
        </>
      ) : money ? (
        "Paid; its payout transaction was not found in the history this page reads."
      ) : (
        "Finished; its transaction was not found in the history this page reads."
      )}
    </p>
  );
}

/** A submission's status as a chip colour: settled well, stopped, run out, or still moving. */
const STATUS_TONES: Record<ClaimStatus, ChipTone> = {
  Open: "info",
  Approved: "success",
  Paid: "success",
  Rejected: "danger",
  Frozen: "danger",
  Recovered: "danger",
  Expired: "neutral",
  Retired: "neutral",
};
export const statusTone = (status: ClaimStatus) => STATUS_TONES[status];

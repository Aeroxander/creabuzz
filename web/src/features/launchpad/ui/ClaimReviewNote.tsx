import { causeLabel } from "../lib/review-reasons";
import type { ClaimReview } from "../use-review-reasons";
import { Linked } from "./EvidenceBlock";

/**
 * Who reviewed a submission and how, by name, and why each reviewer who turned it down did so, in their own words. Said
 * only as far as it is known: the answers come from the chain, and a reason is shown only when it is tied to one of
 * those turn-downs (`lib/review-reasons.ts`).
 */
export function ClaimReviewNote({
  review,
  labelOf,
}: {
  review: ClaimReview;
  labelOf: (address: string) => string;
}) {
  const verdicts = review.verdicts ?? [];
  if (verdicts.length === 0 && review.reasons.length === 0) return null;
  const approved = verdicts.filter((v) => v.approve).map((v) => v.reviewer);
  const turnedDown = verdicts.filter((v) => !v.approve).map((v) => v.reviewer);
  const names = (list: string[]) => list.map(labelOf).join(", ");
  return (
    <div className="mt-2 text-xs" data-testid="work-claim-review">
      {verdicts.length > 0 ? (
        <p className="text-muted-foreground" data-testid="work-claim-reviewers">
          {approved.length > 0 ? `Approved by ${names(approved)}` : null}
          {approved.length > 0 && turnedDown.length > 0 ? " · " : null}
          {turnedDown.length > 0 ? `Turned down by ${names(turnedDown)}` : null}
        </p>
      ) : null}
      {review.reasons.length > 0 ? (
        <ul className="mt-1 flex flex-col gap-1">
          {review.reasons.map((reason) => (
            <li
              className="rounded-md bg-black/5 p-2 text-sm dark:bg-white/5"
              data-testid="work-claim-reason"
              key={reason.eventId}
            >
              <span className="block text-xs font-medium text-muted-foreground">
                Why {labelOf(reason.reviewer)} turned it down
              </span>
              {reason.cause ? (
                <span
                  className="mt-0.5 block font-medium"
                  data-testid="work-claim-reason-cause"
                >
                  {causeLabel(reason.cause)}
                </span>
              ) : null}
              {reason.reason ? (
                <span className="mt-0.5 block whitespace-pre-wrap">
                  <Linked text={reason.reason} />
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

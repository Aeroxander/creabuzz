import type { ChallengeIntent } from "../lib/challenge";
import { managersFor } from "../lib/dao-overview";
import type { MandateView } from "@creaton/core/launchpad/workRead.ts";
import type { claimStep } from "@creaton/core/launchpad/work.ts";

/** A chain timestamp as the day a person reads ("Nov 2, 2026"). */
export const shortDate = (seconds: number): string =>
  new Date(seconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

/**
 * The two quiet notes under a claim's buttons: what a doubt vote would do, and
 * — for work with no agreed reward — that any award is a discretionary vote.
 * Both say who acts and what changes; neither offers anything on one's own
 * work or to someone who cannot open the vote.
 */
export function ChallengeHelp({
  challengeKind,
  sharesOnly,
  mine,
  offerVote,
  pastChallengeWindow,
  mandate,
  claimId,
  onChallenge,
}: {
  challengeKind: ChallengeIntent["kind"] | null;
  /** The project awards Shares only (no money at stake). */
  sharesOnly: boolean;
  /** The connected wallet filed this claim. */
  mine: boolean;
  /** The connected wallet could open a vote (never a visitor). */
  offerVote: boolean;
  pastChallengeWindow: boolean;
  mandate: string;
  claimId: string;
  onChallenge?: (intent: ChallengeIntent) => void;
}) {
  if (
    !onChallenge ||
    !challengeKind ||
    pastChallengeWindow ||
    mine ||
    !offerVote
  )
    return null;
  return (
    <p
      className="mt-2 text-xs text-muted-foreground"
      data-testid="work-challenge-help"
    >
      {challengeKind === "freeze"
        ? sharesOnly
          ? "Doubt it? Shareholders can freeze it: while it is frozen, no Shares can be awarded for it."
          : "Doubt it? Shareholders can freeze it: nothing is paid while it is frozen."
        : sharesOnly
          ? "A vote can reject it for good: nothing is awarded for it."
          : "A vote can reject it for good: the money goes back to the budget and the deposit to the contributor."}{" "}
      <button
        className="underline"
        data-testid="work-challenge"
        onClick={() =>
          onChallenge({
            kind: challengeKind,
            mandate,
            claimId,
          })
        }
        type="button"
      >
        {challengeKind === "freeze"
          ? "Put a freeze to a vote"
          : "Put a rejection to a vote"}
      </button>
    </p>
  );
}

/**
 * The award line under a paid claim: discretionary work links to the vote,
 * agreed work says its exact quantity settles from its own record instead. A
 * check that could not be made says so rather than guessing either way.
 */
export function AwardHelp({
  awardCheck,
  awardBlocked,
  onOpenDecisions,
}: {
  /** True: the chain bound this claim to an agreement. Null: not confirmed. */
  awardCheck: boolean | null;
  awardBlocked: boolean;
  onOpenDecisions?: () => void;
}) {
  if (awardBlocked) {
    return (
      <p
        className="mt-2 text-xs text-muted-foreground"
        data-testid="work-award-agreed"
      >
        {awardCheck === true
          ? "This work was agreed in advance, so its exact number of Shares comes from the agreement, not from a vote."
          : "Couldn't check whether this work was agreed in advance, so no award vote is offered here. Refresh the page to check again."}
      </p>
    );
  }
  return (
    <p
      className="mt-2 text-xs text-muted-foreground"
      data-testid="work-award-help"
    >
      This work has no agreed reward. Awarding Shares for it is a judgment call
      that the project votes on.{" "}
      {onOpenDecisions ? (
        <button
          className="underline"
          data-testid="work-award-open"
          onClick={onOpenDecisions}
          type="button"
        >
          Open it on the Decisions tab
        </button>
      ) : null}
    </p>
  );
}

/**
 * What a submission waits for, naming the person when one manager can accept
 * it ("Waiting for Frida Lund to accept it for review."), else the step as it
 * is.
 */
export function waitingFor(
  step: ReturnType<typeof claimStep>,
  claim: MandateView["claims"][number],
  mandate: MandateView,
  now: number,
  labelOf: (address: string) => string,
): string {
  if (step.kind !== "bind" || step.who !== "manager") return step.text;
  const managers = managersFor(claim, mandate, now);
  // A wallet nobody has put a name to would only be an address: the general words say more then.
  const name = managers.length === 1 ? labelOf(managers[0]) : null;
  return name && !name.startsWith("0x")
    ? `Waiting for ${name} to accept it for review.`
    : step.text;
}

/** The quiet line under the work list: where new budgets, work areas and awards are decided. */
export function DecisionHelp({
  onOpenDecisions,
}: {
  onOpenDecisions?: () => void;
}) {
  return (
    <p className="mt-2 text-xs text-muted-foreground" data-testid="work-help">
      New work budgets, work areas and discretionary awards are put to a vote
      {onOpenDecisions ? (
        <>
          {" "}
          on the{" "}
          <button
            className="underline"
            data-testid="work-open-decisions"
            onClick={onOpenDecisions}
            type="button"
          >
            Decisions tab
          </button>
        </>
      ) : null}
      .
    </p>
  );
}

/**
 * A submission an unbound agreement already promises: its own beneficiary binds
 * it from the agreement, with the agreed check, so the work area's manager is
 * not offered the legacy bind.
 */
export function AgreedBindNote({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <p className="text-xs text-muted-foreground" data-testid="work-agreed-bind">
      This submission belongs to an agreed reward. The person named in the
      agreement above links it to that agreement.
    </p>
  );
}

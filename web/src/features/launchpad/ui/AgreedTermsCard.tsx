import { useState } from "react";

import { Button } from "@/shared/ui/button";
import { Chip } from "@/shared/ui/chip";

import { agreementStateOf } from "@creaton/core/launchpad/agreements.ts";
import type { MandateView } from "@creaton/core/launchpad/workRead.ts";
import type { SenderCall } from "@/features/identity/lib/sponsoredSender";
import { existingUserPubkey } from "@/shared/lib/identity";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { pendingPublishDraft } from "../lib/agreed-submission";
import {
  acceptancePlan,
  agreedQuantityWords,
  agreementStateWords,
  periodWords,
  releaseCall,
  reviewerPolicyWords,
  settlementCall,
  wordsMatchHash,
} from "../lib/agreed-terms";
import {
  approvedQuorumStands,
  awardPayees,
  deliverableMatches,
  laneStep,
  mayReview,
  settlementFigures,
  type AgreementDescriptor,
} from "../lib/agreed-lane";
import { workTitle } from "../lib/work-titles";
import type { Launch } from "../models";
import type { AgreementItem, AgreementsLane } from "../use-agreements";
import { AgreedCorrectionsForm } from "./AgreedCorrectionsForm";
import { AgreedSubmissionForm } from "./AgreedSubmissionForm";

const date = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

const sameAddress = (a: string | null, b: string) =>
  a !== null && a.toLowerCase() === b.toLowerCase();

/**
 * One agreed contribution's immutable terms, in plain words, with the one step
 * that is open now: accept (the beneficiary's financial moment), submit,
 * correct, wait out the challenge window, settle at the record's exact
 * figures, or release. Nothing here lets a caller name an amount.
 */
export function AgreedTermsCard({
  launch,
  dao,
  mandate,
  lane,
  item,
  wallet,
  gate,
  busy,
  titles,
  labelOf,
  onSendBatch,
  onRefresh,
}: {
  launch: Launch;
  dao: string;
  mandate: MandateView;
  lane: AgreementsLane;
  item: AgreementItem;
  wallet: string | null;
  gate: string | null;
  busy: string | null;
  titles: ReadonlyMap<string, string>;
  labelOf: (address: string) => string;
  onSendBatch: (key: string, calls: SenderCall[]) => Promise<boolean>;
  onRefresh: () => void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const row = item.row;
  if (row.kind !== "present") {
    return (
      <li
        className="rounded-xl border border-border/60 p-3 text-sm"
        data-testid="agreed-agreement-unreadable"
      >
        <p className="font-medium">An agreement could not be read</p>
        <p className="mt-1 text-muted-foreground">
          Its record came back in a form this page can't show, so nothing is
          shown about it.
        </p>
        <Button
          className="mt-2"
          onClick={onRefresh}
          size="sm"
          type="button"
          variant="outline"
        >
          Try again
        </Button>
      </li>
    );
  }
  const terms = row.terms;
  const descriptor: AgreementDescriptor | null = item.descriptor;
  const project =
    mandate.projects.find(
      (p) => p.id.toLowerCase() === terms.projectId.toLowerCase(),
    ) ?? null;
  const areaTitle = workTitle(terms.projectId, titles);
  const isManager = sameAddress(wallet, project?.record.manager ?? "");
  const isBeneficiary = sameAddress(wallet, terms.beneficiary);
  const state = agreementStateOf(terms);
  const step = laneStep(row, item.claim, {
    now: lane.chainTime,
    quorum: mandate.quorum,
    challengeWindow: mandate.challengeWindow,
    correctionsRequested: item.correctionsRequested,
    viewer: {
      manager: isManager,
      beneficiary: isBeneficiary,
      reviewer: mandate.walletIsReviewer,
    },
  });
  const deliverable =
    descriptor && deliverableMatches(terms, descriptor.deliverable)
      ? descriptor.deliverable
      : null;
  const criteriaWords =
    descriptor?.criteriaWords &&
    wordsMatchHash(descriptor.criteriaWords, terms.criteriaHash)
      ? descriptor.criteriaWords
      : null;
  // A record the chain would never write (zero shares) is shown as unread
  // rather than crashing the page on a quantity nobody can print.
  const quantityWords = (units: bigint): string => {
    try {
      return agreedQuantityWords(units);
    } catch {
      return "not recorded";
    }
  };
  // A split nobody could read means the recipients are unknown: the figures
  // are not guessed, and settlement is not offered on a promise nobody can see.
  const splitUnreadable = row.split.kind === "unreadable";
  const figures = (() => {
    if (splitUnreadable) return [];
    try {
      return settlementFigures(row);
    } catch {
      return [];
    }
  })();
  const payees = awardPayees(row)?.addresses ?? [];
  const blocked = busy !== null || gate !== null;
  const claimHref = terms.claimId
    ? `#claim-${mandate.address.toLowerCase()}-${terms.claimId.toLowerCase()}`
    : null;
  const correctionsWords = terms.claimId
    ? (lane.correctionsWords ?? []).find(
        (words) => words.claimId.toLowerCase() === terms.claimId?.toLowerCase(),
      )
    : null;
  // A send that landed but whose evidence did not publish is finished here,
  // even after a reload and even once the record says the attempt is in review.
  const pendingPublish =
    isBeneficiary && wallet !== null
      ? pendingPublishDraft(
          {
            server: relayWsUrl(),
            account: existingUserPubkey() ?? "",
            wallet,
            chainId: launch.record.chainId ?? "",
            mandate: mandate.address,
            agreementId: terms.id,
          },
          undefined,
        )
      : null;
  const showForm =
    (step?.kind === "submit" || step?.kind === "corrections") && isBeneficiary;

  const accept = async () => {
    setProblem(null);
    const plan = acceptancePlan({
      terms,
      mandate: mandate.address,
      split: row.split,
      manager: project?.record.manager ?? null,
      wallet,
    });
    if (plan.kind === "problem") {
      setProblem(plan.problem);
      return;
    }
    await onSendBatch(`accept-agreement-${terms.id.toLowerCase()}`, [
      plan.call,
    ]);
  };

  const settle = async () => {
    setProblem(null);
    await onSendBatch(`settle-agreement-${terms.id.toLowerCase()}`, [
      settlementCall({
        dao,
        mandate: mandate.address,
        agreementId: terms.id,
      }),
    ]);
  };

  const release = async () => {
    setProblem(null);
    await onSendBatch(`release-agreement-${terms.id.toLowerCase()}`, [
      releaseCall({ mandate: mandate.address, agreementId: terms.id }),
    ]);
  };

  const canCorrect =
    wallet !== null &&
    item.claim !== null &&
    item.claim.record.status === "Open" &&
    lane.chainTime < terms.revisionDeadline &&
    !approvedQuorumStands(item.claim) &&
    mayReview(row, wallet) &&
    mandate.walletIsReviewer;

  return (
    <li
      className="rounded-xl border border-border/60 p-3 text-sm"
      data-testid="agreed-agreement"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium">
            {deliverable ?? "Agreed work (its description is not recorded yet)"}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            In {areaTitle} ·{" "}
            <span data-testid="agreed-state">{agreementStateWords(state)}</span>
          </p>
        </div>
        <Chip tone={state === "settled" ? "success" : "info"}>
          {quantityWords(terms.shares)} Shares
        </Chip>
      </div>

      <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
        <div>
          <dt className="font-medium text-muted-foreground">
            The exact number of Shares
          </dt>
          <dd className="mt-0.5">
            <span className="font-semibold tabular-nums">
              {quantityWords(terms.shares)}
            </span>{" "}
            Shares. This is an exact amount of Shares, not a cash value and not
            a percentage of the project. What Shares are worth later is not
            promised.
          </dd>
        </div>
        <div>
          <dt className="font-medium text-muted-foreground">Who receives it</dt>
          <dd className="mt-0.5">
            {splitUnreadable ? (
              <p>
                The split in these terms could not be read, so who receives the
                Shares is not shown here. Refresh in a minute.
              </p>
            ) : null}
            <ul className="grid gap-1">
              {figures.map((figure, index) => (
                <li key={figure.address}>
                  {labelOf(figure.address)}
                  {index === 0 ? " (the person named)" : ""}:{" "}
                  <span className="font-semibold tabular-nums">
                    {quantityWords(figure.quantity)}
                  </span>{" "}
                  Shares
                  {row.split.kind === "declared"
                    ? ` · ${row.split.percentages[index] / 100}%`
                    : ""}
                </li>
              ))}
            </ul>
            {splitUnreadable ? null : (
              <p className="mt-1 text-muted-foreground">
                The parts add up to the exact number of Shares. Any rounding
                leftover goes to the person named. These recipients are fixed
                once both sides approve, and cannot be added to later.
              </p>
            )}
          </dd>
        </div>
        <div>
          <dt className="font-medium text-muted-foreground">
            The work is due by
          </dt>
          <dd className="mt-0.5">
            {date(terms.workDeadline)}. A first submission after that cannot be
            linked to this agreement, and anyone may release the Shares set
            aside.
          </dd>
        </div>
        <div>
          <dt className="font-medium text-muted-foreground">Review</dt>
          <dd className="mt-0.5">
            Each attempt is reviewed within {periodWords(terms.reviewPeriod)} of
            being submitted; an unanswered review lapses and does not approve
            anything. Corrections may replace an attempt until{" "}
            {date(terms.revisionDeadline)}.
            {item.claim && item.claim.record.expiresAt > 0
              ? ` This attempt's review ends ${date(item.claim.record.expiresAt)}.`
              : ""}
          </dd>
        </div>
        <div>
          <dt className="font-medium text-muted-foreground">The reviewers</dt>
          <dd className="mt-0.5">
            {reviewerPolicyWords({
              quorum: mandate.quorum,
              panel: mandate.reviewers.length,
              unreadable: mandate.reviewersUnreadable,
            })}{" "}
            These are the accounts this work budget lists, not a statement about
            who is behind them.
          </dd>
        </div>
        <div>
          <dt className="font-medium text-muted-foreground">
            What it is judged against
          </dt>
          <dd className="mt-0.5 whitespace-pre-wrap">
            {criteriaWords ??
              "The exact words are not published here yet, so this page cannot show them. Ask the work area's manager to publish them."}
          </dd>
        </div>
      </dl>

      {descriptor && !deliverable ? (
        <p className="mt-2 text-xs text-amber-800 dark:text-amber-200">
          A description was published for this offer, but it does not match the
          offer, so it is not shown as its terms.
        </p>
      ) : null}

      {step ? (
        <div className="mt-3 rounded-lg bg-secondary/60 p-2.5">
          <p className="text-xs font-medium text-muted-foreground">
            What happens next
          </p>
          <p className="mt-0.5" data-testid="agreed-next">
            {step.note}
          </p>
          {step.due !== null && step.dueLine ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {step.dueLine} {date(step.due)}.
            </p>
          ) : null}
          {step.kind === "settle-claim" ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              Enough reviewers approved it. Finishing the review on the
              submission starts the objection window. Nothing is paid before it
              ends.
            </p>
          ) : null}
          {item.claim &&
          mandate.quorum > 0 &&
          item.claim.objections >= mandate.quorum ? (
            <p className="mt-0.5 text-xs text-amber-800 dark:text-amber-200">
              Enough reviewers turned this attempt down, so nothing is paid for
              it. After its review ends, anyone may close it as lapsed, which
              releases the Shares set aside.
              {item.claim.record.expiresAt > 0
                ? ` Its review ends ${date(item.claim.record.expiresAt)}.`
                : ""}
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {step.kind === "accept" && isBeneficiary ? (
              <Button
                data-testid="agreed-accept"
                disabled={blocked}
                onClick={() => void accept()}
                size="sm"
                type="button"
              >
                Accept these terms
              </Button>
            ) : null}
            {step.kind === "accept" && !isBeneficiary ? (
              <p className="text-xs text-muted-foreground">
                {labelOf(terms.beneficiary)} accepts it from the account it
                names. The Shares are set aside when it is accepted.
              </p>
            ) : null}
            {step.kind === "settle-agreement" && splitUnreadable ? (
              <p className="text-xs text-amber-800 dark:text-amber-200">
                The exact figures cannot be shown because this agreement&apos;s
                split could not be read, so settlement is not offered here.
                Refresh in a minute.
              </p>
            ) : null}
            {step.kind === "settle-agreement" && !splitUnreadable ? (
              <div className="grid gap-2">
                <p className="text-xs text-muted-foreground">
                  Settling pays exactly these amounts from the record, with no
                  new vote:
                </p>
                <ul className="grid gap-0.5 text-xs">
                  {figures.map((figure) => (
                    <li key={figure.address}>
                      {labelOf(figure.address)}:{" "}
                      <span className="font-semibold tabular-nums">
                        {quantityWords(figure.quantity)}
                      </span>{" "}
                      Shares
                    </li>
                  ))}
                </ul>
                <Button
                  className="w-fit"
                  data-testid="agreed-settle"
                  disabled={blocked}
                  onClick={() => void settle()}
                  size="sm"
                  type="button"
                >
                  Settle at these exact amounts
                </Button>
              </div>
            ) : null}
            {step.kind === "release" ? (
              <Button
                data-testid="agreed-release"
                disabled={blocked}
                onClick={() => void release()}
                size="sm"
                type="button"
                variant="outline"
              >
                Release the Shares set aside
              </Button>
            ) : null}
            {claimHref ? (
              <a
                className="text-xs text-primary-ink underline-offset-4 hover:underline"
                href={claimHref}
              >
                Read the submitted evidence
              </a>
            ) : null}
          </div>
        </div>
      ) : null}

      {correctionsWords && item.correctionsRequested === true ? (
        <p
          className="mt-2 rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100"
          data-testid="agreed-corrections-words"
        >
          A reviewer asked for changes, which is not a vote against the work:{" "}
          {correctionsWords.reason}
        </p>
      ) : null}

      {pendingPublish || showForm ? (
        criteriaWords || pendingPublish ? (
          <AgreedSubmissionForm
            blocked={blocked}
            claims={mandate.claimsAddress}
            corrected={step?.kind === "corrections"}
            criteriaWords={criteriaWords ?? undefined}
            deliverableLabel={deliverable ?? areaTitle}
            gate={gate}
            launch={launch}
            mandate={mandate.address}
            onCloser={onRefresh}
            onSendBatch={onSendBatch}
            row={row}
            wallet={wallet ?? ""}
          />
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            The exact words this work is judged against are not published here,
            so it cannot be submitted from this page. Ask the work area's
            manager to publish them.
          </p>
        )
      ) : null}

      {canCorrect && item.claim ? (
        <AgreedCorrectionsForm
          agreementId={terms.id}
          claimId={item.claim.id}
          launch={launch}
          mandate={mandate.address}
          onSent={onRefresh}
          verifiers={mandate.verifiersAddress}
          onSendBatch={onSendBatch}
        />
      ) : null}

      {mandate.walletIsReviewer &&
      payees.some((payee) => sameAddress(wallet, payee)) ? (
        <p className="mt-2 text-xs text-muted-foreground">
          You are one of the people this agreement pays, so you cannot judge its
          work; the contract refuses that verdict.
        </p>
      ) : null}

      {problem ? (
        <p
          className="mt-2 text-sm text-red-700 dark:text-red-300"
          data-testid="agreed-problem"
          role="alert"
        >
          {problem}
        </p>
      ) : null}
    </li>
  );
}

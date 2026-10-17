/**
 * One milestone of a lock where holders can object: the words it is judged by, where it stands, the evidence the team
 * published, the vote if there is one, and the one or two things the connected person can do about it. The buttons are
 * exactly the list `challengeActions` gives; the contract refuses anything else.
 */

import { useEffect, useState } from "react";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import {
  CHALLENGE_STAGE_LABEL,
  CHALLENGE_STEPS,
  type ChallengeAction,
  challengeDone,
  challengeHeadline,
  span,
} from "../lib/challenge-copy";
import {
  challengeDraftKey,
  loadChallengeDraft,
  saveChallengeDraft,
} from "../lib/challenge-draft";
import { challengeEvidenceView } from "../lib/challenge-evidence";
import { evidenceProblem } from "../lib/evidence";
import type { EvidenceStanding } from "../lib/evidence";
import {
  type ChallengeLockView,
  type ChallengeMilestone,
  objectionCarries,
} from "../lib/milestone-challenge";
import { Linked } from "./EvidenceBlock";

export interface ChallengeCardHandlers {
  publish: (index: number, evidence: string) => Promise<boolean>;
  object: (index: number) => Promise<boolean>;
  vote: (index: number, reject: boolean) => Promise<boolean>;
  finish: (index: number) => Promise<boolean>;
  resolve: (index: number) => Promise<boolean>;
  releaseBond: (index: number) => Promise<boolean>;
}

export function ChallengeMilestoneCard({
  m,
  view,
  words,
  tokens,
  standing,
  evidenceError,
  evidenceIncomplete,
  onRetryEvidence,
  publishNote,
  actions,
  weight,
  wallet,
  labelOf,
  shares,
  money,
  handlers,
  blocked,
  working,
}: {
  m: ChallengeMilestone;
  view: ChallengeLockView;
  /** The exact words of the milestone from the launch record, when they match the lock. */
  words: string | undefined;
  /** What it holds back, in words ("About 80,000,000 tokens", "30% of the team's tokens"). */
  tokens: string;
  standing: EvidenceStanding;
  /** Looking for the published text failed: say so, instead of claiming nothing was published. */
  evidenceError: boolean;
  /** There are more updates than were read: "nothing found" may only mean "nothing in the newest ones". */
  evidenceIncomplete: boolean;
  onRetryEvidence: () => void;
  /** Why the team cannot publish yet (the sale is not over, an earlier milestone has not unlocked), or null. */
  publishNote: string | null;
  actions: ChallengeAction[];
  /** What the connected wallet's vote would count for. */
  weight: bigint;
  wallet: string | null;
  labelOf: (address: string) => string;
  shares: (units: bigint) => string;
  money: (units: bigint) => string;
  handlers: ChallengeCardHandlers;
  blocked: boolean;
  /** The key of the step in progress, so the right button says it is working. */
  working: string | null;
}) {
  const { terms } = view;
  const now = view.now;
  const objection = m.objection?.open ? m.objection : null;
  const index = m.index;
  const evidenceView = challengeEvidenceView({
    submitted: m.evidence !== null,
    standing,
    error: evidenceError,
    incomplete: evidenceIncomplete,
  });
  const busy = (kind: string) => working === `challenge-${kind}-${index}`;

  return (
    <li data-testid={`challenge-milestone-${index}`}>
      <Card className="p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">
            Milestone {index + 1}: {words ?? "The words are not on the record"}
          </h3>
          <span
            className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium"
            data-testid={`challenge-stage-${index}`}
          >
            {CHALLENGE_STAGE_LABEL[m.stage]}
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{tokens}</p>
        <ol
          aria-label="Progress"
          className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs"
        >
          {CHALLENGE_STEPS.map((step, i) => {
            const done = challengeDone(m.stage);
            return (
              <li
                className={
                  i < done
                    ? "text-emerald-700 dark:text-emerald-300"
                    : i === done
                      ? "font-medium"
                      : "text-muted-foreground"
                }
                key={step}
              >
                {i < done ? "✓ " : `${i + 1}. `}
                {step}
              </li>
            );
          })}
        </ol>
        <p className="mt-2 text-sm" data-testid={`challenge-headline-${index}`}>
          {challengeHeadline(m, terms, now)}
        </p>
        {m.attempts > 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {m.attempts === 1
              ? "One earlier attempt was turned down by the holders."
              : `${m.attempts} earlier attempts were turned down by the holders.`}
          </p>
        ) : null}
        {m.submitter ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Published by {labelOf(m.submitter)}
            {m.bond > 0n ? `, with a bond of ${money(m.bond)}` : ""}.
          </p>
        ) : null}

        {objection ? (
          <div
            className="mt-2 rounded-md bg-black/5 p-2 text-sm dark:bg-white/5"
            data-testid={`challenge-tally-${index}`}
          >
            <p>
              Objection by {labelOf(objection.objector)}.{" "}
              {shares(objection.rejectWeight)} against,{" "}
              {shares(objection.acceptWeight)} in favour. At least{" "}
              {shares(
                (objection.eligible * BigInt(terms.minRejectBps)) / 10_000n,
              )}{" "}
              has to be against it, and more than is in favour.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              As things stand it would{" "}
              {objectionCarries(objection, terms.minRejectBps)
                ? m.phase === "stood"
                  ? "be upheld: the team's remaining locked tokens would be burned."
                  : "be upheld: the milestone would be turned down."
                : "not be upheld: the milestone would stand."}
            </p>
          </div>
        ) : null}

        {evidenceView === "verified" && standing.kind === "verified" ? (
          <details className="mt-2 rounded-md bg-black/5 p-2 text-sm dark:bg-white/5">
            <summary
              className="cursor-pointer text-xs font-medium"
              data-testid={`challenge-evidence-toggle-${index}`}
            >
              Evidence the team published
            </summary>
            <p
              className="mt-1 whitespace-pre-wrap"
              data-testid={`challenge-evidence-${index}`}
            >
              <Linked text={standing.packet.evidence} />
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              This is the text the team committed to on the network: it matches,
              and it is judged against the milestone&apos;s words above.
            </p>
          </details>
        ) : evidenceView === "unreadable" ? (
          <div
            className="mt-2 rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100"
            data-testid={`challenge-evidence-unreadable-${index}`}
            role="status"
          >
            <p>
              Could not look for the evidence just now, so it is not shown. That
              does not mean the team did not publish it.
            </p>
            <Button
              className="mt-2"
              onClick={onRetryEvidence}
              size="sm"
              type="button"
              variant="outline"
            >
              Try again
            </Button>
          </div>
        ) : evidenceView === "mismatch" ? (
          <p
            className="mt-2 rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100"
            data-testid={`challenge-evidence-mismatch-${index}`}
          >
            Something was published for this milestone, but it is not what the
            team submitted to the lock. Do not rely on it.
          </p>
        ) : evidenceView === "incomplete" ? (
          <div
            className="mt-2 rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100"
            data-testid={`challenge-evidence-incomplete-${index}`}
            role="status"
          >
            <p>
              No matching text was found in the updates that were read, but this
              project has more updates than could be read, so it may be in an
              older one.
            </p>
            <Button
              className="mt-2"
              onClick={onRetryEvidence}
              size="sm"
              type="button"
              variant="outline"
            >
              Try again
            </Button>
          </div>
        ) : evidenceView === "missing" ? (
          <p
            className="mt-2 rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100"
            data-testid={`challenge-evidence-missing-${index}`}
          >
            The team has not published text matching what it submitted to the
            lock. Holders cannot judge what they cannot read.
          </p>
        ) : null}

        {publishNote ? (
          <p
            className="mt-2 text-xs text-muted-foreground"
            data-testid={`challenge-publish-note-${index}`}
          >
            {publishNote}
          </p>
        ) : null}

        {actions.includes("publish") ? (
          <PublishForm
            bond={terms.bond}
            key={`${view.lock}:${wallet ?? ""}:${index}`}
            index={index}
            lock={view.lock}
            money={money}
            onPublish={handlers.publish}
            blocked={blocked}
            busy={busy("publish")}
            wallet={wallet}
            window={m.nextWindow}
          />
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {actions.includes("finish") ? (
            <Button
              aria-busy={busy("finish")}
              data-testid={`challenge-finish-${index}`}
              disabled={blocked}
              onClick={() => void handlers.finish(index)}
              size="sm"
              type="button"
            >
              {busy("finish") ? "Working…" : "Finish it and unlock the tokens"}
            </Button>
          ) : null}
          {actions.includes("resolve") ? (
            <Button
              aria-busy={busy("resolve")}
              data-testid={`challenge-resolve-${index}`}
              disabled={blocked}
              onClick={() => void handlers.resolve(index)}
              size="sm"
              type="button"
            >
              {busy("resolve") ? "Working…" : "Settle the vote"}
            </Button>
          ) : null}
          {actions.includes("release-bond") ? (
            <Button
              aria-busy={busy("release")}
              data-testid={`challenge-release-${index}`}
              disabled={blocked}
              onClick={() => void handlers.releaseBond(index)}
              size="sm"
              type="button"
              variant="outline"
            >
              {busy("release") ? "Working…" : "Return the team's bond"}
            </Button>
          ) : null}
        </div>

        {actions.includes("vote") ? (
          <div className="mt-3" data-testid={`challenge-vote-${index}`}>
            <p className="text-sm">
              Your vote counts for {shares(weight)}. The team&apos;s own tokens
              do not count.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                aria-busy={busy("vote")}
                data-testid={`challenge-vote-reject-${index}`}
                disabled={blocked}
                onClick={() => void handlers.vote(index, true)}
                size="sm"
                type="button"
                variant="outline"
              >
                Vote against the milestone
              </Button>
              <Button
                data-testid={`challenge-vote-accept-${index}`}
                disabled={blocked}
                onClick={() => void handlers.vote(index, false)}
                size="sm"
                type="button"
                variant="outline"
              >
                Vote for the milestone
              </Button>
            </div>
          </div>
        ) : null}

        {actions.includes("object") ? (
          <ObjectForm
            blocked={blocked}
            busy={busy("object")}
            deposit={terms.deposit}
            index={index}
            money={money}
            onObject={handlers.object}
            unlocked={m.phase === "stood"}
            weight={weight}
            shares={shares}
          />
        ) : null}
      </Card>
    </li>
  );
}

function PublishForm({
  index,
  lock,
  wallet,
  bond,
  window,
  money,
  blocked,
  busy,
  onPublish,
}: {
  index: number;
  lock: string;
  wallet: string | null;
  bond: bigint;
  window: number;
  money: (units: bigint) => string;
  blocked: boolean;
  busy: boolean;
  onPublish: (index: number, evidence: string) => Promise<boolean>;
}) {
  const key = wallet ? challengeDraftKey(lock, wallet, index) : null;
  const [text, setText] = useState(() => (key ? loadChallengeDraft(key) : ""));
  useEffect(() => {
    if (key) saveChallengeDraft(key, text);
  }, [key, text]);
  const problem = text.trim() === "" ? null : evidenceProblem(text);
  return (
    <div className="mt-3" data-testid={`challenge-publish-${index}`}>
      <label
        className="text-sm font-medium"
        htmlFor={`challenge-text-${index}`}
      >
        Evidence that this milestone was reached
      </label>
      <textarea
        className="mt-1 min-h-24 w-full rounded-md border border-input bg-transparent p-2 text-sm"
        data-testid={`challenge-text-${index}`}
        id={`challenge-text-${index}`}
        onChange={(event) => setText(event.target.value)}
        placeholder="What shipped, with links holders can open."
        value={text}
      />
      {problem ? (
        <p className="mt-1 text-xs text-destructive" role="status">
          {problem}
        </p>
      ) : null}
      <p className="mt-1 text-xs text-muted-foreground">
        Holders then have {span(window)} to object. You post a bond of{" "}
        {money(bond)}; it comes back a month after the milestone unlocks, unless
        holders turn the milestone down.
      </p>
      <Button
        aria-busy={busy}
        className="mt-2"
        data-testid={`challenge-publish-button-${index}`}
        disabled={blocked || text.trim() === "" || problem !== null}
        onClick={() => {
          void onPublish(index, text).then((done) => {
            if (done && key) {
              saveChallengeDraft(key, "");
              setText("");
            }
          });
        }}
        size="sm"
        type="button"
      >
        {busy ? "Publishing…" : "Publish this milestone"}
      </Button>
    </div>
  );
}

function ObjectForm({
  index,
  deposit,
  money,
  unlocked,
  weight,
  shares,
  blocked,
  busy,
  onObject,
}: {
  index: number;
  deposit: bigint;
  money: (units: bigint) => string;
  unlocked: boolean;
  weight: bigint;
  shares: (units: bigint) => string;
  blocked: boolean;
  busy: boolean;
  onObject: (index: number) => Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <div className="mt-3">
        <Button
          data-testid={`challenge-object-${index}`}
          disabled={blocked}
          onClick={() => setConfirming(true)}
          size="sm"
          type="button"
          variant="outline"
        >
          Object to this milestone
        </Button>
      </div>
    );
  }
  return (
    <div
      className="mt-3 rounded-md border border-black/10 p-3 text-sm dark:border-white/10"
      data-testid={`challenge-object-confirm-${index}`}
    >
      <p>
        {unlocked
          ? "This milestone has already unlocked. If holders uphold your objection, the team's remaining locked tokens are burned and its bond is forfeited; what already unlocked stays unlocked."
          : "If holders uphold your objection, the milestone is turned down and the team has to try again with a longer window."}{" "}
        Holders vote, and the team&apos;s own tokens do not count. Your vote
        counts for {shares(weight)}.
      </p>
      <p className="mt-2">
        {deposit > 0n
          ? `You post a deposit of ${money(deposit)}. You get it back, with half of the team's bond, if holders uphold your objection. If they do not, it goes to the DAO.`
          : "It costs nothing to object, but holders may not back you."}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          aria-busy={busy}
          data-testid={`challenge-object-send-${index}`}
          disabled={blocked}
          onClick={() => void onObject(index).then(() => setConfirming(false))}
          size="sm"
          type="button"
        >
          {busy ? "Working…" : "Yes, object"}
        </Button>
        <Button
          onClick={() => setConfirming(false)}
          size="sm"
          type="button"
          variant="ghost"
        >
          Cancel
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Only one objection can be open at a time, and it stays open until the
        vote ends.
      </p>
    </div>
  );
}

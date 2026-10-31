import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import type { DescribeContext } from "@creaton/core/launchpad/daoActions.ts";
import { formatShares } from "../lib/shares-format";
import { describeDecision } from "../lib/decision-describe";
import type {
  Decision,
  DecisionsSnapshot,
} from "@creaton/core/launchpad/decisions.ts";
import { encodeExecuteByVotes, encodeQueue } from "../lib/vote-tx";
import {
  votingRuleWatch,
  votingStatusLabel,
} from "@creaton/core/launchpad/voting-allocation.ts";
import { decisionStage, duration, isLive, when } from "../lib/decision-stage";
import { deadline } from "../lib/challenge-copy";
import { DecisionVote } from "./DecisionVote";
import { CHALLENGED_KINDS } from "@creaton/core/launchpad/challenge.ts";

export { decisionStage };

const shares = formatShares;

const TONE: Record<string, string> = {
  open: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  good: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
  wait: "bg-sky-500/15 text-sky-800 dark:text-sky-300",
  bad: "bg-red-500/15 text-red-800 dark:text-red-300",
  done: "bg-muted text-muted-foreground",
};

/**
 * One decision: what it would do (in words a voter can read), where it stands, who backs it, how to vote on it, and the
 * one step that moves it along. Nothing on it is a record somebody wrote about the decision: it is all read from the
 * chain, including what the decision would do.
 */
export function DecisionCard({
  decision,
  snapshot,
  currencyDecimals,
  describeContext,
  account,
  busy,
  gate,
  onSend,
  renderDiscussion,
  beforeMoneyVote,
  highlighted = false,
  link,
}: {
  decision: Decision;
  snapshot: DecisionsSnapshot;
  currencyDecimals: number | undefined;
  /** What the app knows to be this DAO's own, so a call aimed elsewhere is never described as one of its actions. */
  describeContext: Omit<DescribeContext, "currencyDecimals">;
  account: string | null;
  busy: string | null;
  gate: string | null;
  onSend: (key: string, to: string, data: string) => Promise<boolean>;
  /** The talk about this decision, given what it would do in a few words; shown under it. */
  renderDiscussion?: (headline: string) => ReactNode;
  /** Shown above the vote buttons of an open decision that spends money or Shares: what to read before voting. */
  beforeMoneyVote?: ReactNode;
  /** A link pointed at this decision: it is outlined and scrolled into view. */
  highlighted?: boolean;
  /** This decision's address, for "Copy link". */
  link?: string;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlighted) cardRef.current?.scrollIntoView({ block: "center" });
  }, [highlighted]);
  const stage = decisionStage(decision, snapshot.chainTime);
  const described = decision.action
    ? describeDecision(decision.action, {
        ...describeContext,
        currencyDecimals,
        // A change to the voting settings is judged against the Shares that could vote when it opened.
        votingSupply: decision.rules?.votingSupply,
      })
    : null;
  const rules = decision.rules;
  const watch =
    rules && decision.state === "Active"
      ? votingRuleWatch(
          rules,
          decision.support,
          BigInt(snapshot.chainTime),
          shares,
        )
      : null;
  const open = isLive(decision);
  const key = `step-${decision.id}`;

  const step = async () => {
    if (stage.step === null) return;
    // Starting the wait and running are the same call on the DAO: the first one starts the wait.
    await onSend(
      key,
      snapshot.dao,
      decision.action
        ? encodeExecuteByVotes(decision.action)
        : encodeQueue(decision.id),
    );
  };

  return (
    <Card
      className={`p-4 ${highlighted ? "ring-2 ring-primary" : ""}`}
      data-focused={highlighted ? "true" : undefined}
      data-testid="decision-card"
      ref={cardRef}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${TONE[stage.tone]}`}
          data-testid="decision-status"
        >
          {stage.label}
        </span>
        {described && described.kind !== "unknown" ? null : (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-800 dark:text-amber-300">
            Read it carefully
          </span>
        )}
        {described?.kind === "voting-rules" ? (
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              described.unsafe
                ? "bg-red-500/15 text-red-800 dark:text-red-300"
                : "bg-amber-500/15 text-amber-800 dark:text-amber-300"
            }`}
            data-testid="decision-voting-rules"
          >
            {described.unsafe
              ? "Could stop every later decision"
              : "Changes how votes work"}
          </span>
        ) : null}
        {described?.kind === "payment" ? (
          <span
            className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-800 dark:text-amber-300"
            data-testid="decision-no-review"
            title="This pays straight out of the treasury. No reviewer checks anything before it goes."
          >
            No reviewer
          </span>
        ) : null}
      </div>
      <h3 className="mt-1 text-sm font-semibold" data-testid="decision-title">
        {described?.title ?? "This decision did not say what it would do"}
      </h3>
      {described ? (
        <ul className="mt-1 list-disc pl-5 text-sm text-muted-foreground">
          {described.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-sm text-muted-foreground">
          It was opened without its details, so nobody reading this page can
          tell what backing it would approve. Do not back it unless you know
          what it is.
        </p>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        Proposed by{" "}
        {describeContext.label?.(decision.proposer) ??
          `${decision.proposer.slice(0, 8)}…`}{" "}
        · {when(decision.openedAt)}
      </p>

      {rules ? (
        <p
          className="mt-2 text-xs text-muted-foreground"
          data-testid="decision-rules"
        >
          Passes when at least {shares(rules.quorum)} Shares take part (for,
          against or neutral) and {Number(rules.approvalBps) / 100}% of them
          back it, for {duration(rules.hold)} in a row. It then waits{" "}
          {duration(rules.delay)} before it can take effect. Voting closes{" "}
          {deadline(Number(rules.expiresAt))}.
        </p>
      ) : null}

      <p className="mt-2 text-sm" data-testid="decision-support">
        Backing {shares(decision.support.yes)} · Against{" "}
        {shares(decision.support.no)} · Neutral{" "}
        {shares(decision.support.abstain)}
      </p>
      {watch ? (
        <p
          className="mt-1 text-xs text-muted-foreground"
          data-testid="decision-watch"
          role="status"
        >
          <span className="font-medium">
            {votingStatusLabel(watch.status)}.
          </span>{" "}
          {watch.next}
        </p>
      ) : null}
      <p
        className="mt-1 text-xs text-muted-foreground"
        data-testid="decision-next"
      >
        {stage.next}
      </p>

      {watch?.againstCounts ? (
        <p
          className="mt-1 text-xs text-muted-foreground"
          data-testid="decision-against-counts"
        >
          Votes against and neutral votes count toward the Shares taking part.
          While too few have taken part, voting against can help this pass.
        </p>
      ) : null}
      {open &&
      beforeMoneyVote &&
      described &&
      CHALLENGED_KINDS.has(described.kind) ? (
        <div className="mt-2">{beforeMoneyVote}</div>
      ) : null}
      {open ? (
        <DecisionVote
          account={account}
          busy={busy}
          dao={snapshot.dao}
          gate={gate}
          id={decision.id}
          onSend={onSend}
        />
      ) : null}

      {stage.step ? (
        <div className="mt-3">
          <Button
            aria-busy={busy === key}
            data-testid={
              stage.step === "start" ? "decision-start-wait" : "decision-run"
            }
            disabled={
              busy !== null ||
              gate !== null ||
              (stage.step === "run" && !decision.action)
            }
            onClick={() => void step()}
            size="sm"
            type="button"
          >
            {busy === key
              ? "Sending…"
              : stage.step === "start"
                ? "Start the wait"
                : "Make it take effect"}
          </Button>
          {stage.step === "run" && !decision.action ? (
            <p className="mt-1 text-xs text-muted-foreground">
              This decision never published its details, so it cannot be made to
              take effect from here.
            </p>
          ) : null}
        </div>
      ) : null}

      {/* A decision that is over keeps its discussion out of the way: open it to read or add to it. */}
      {["Executed", "Defeated", "Expired"].includes(decision.state) ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Discussion
          </summary>
          {renderDiscussion?.(described?.title ?? "this decision")}
        </details>
      ) : (
        renderDiscussion?.(described?.title ?? "this decision")
      )}

      {link ? (
        <button
          className="mt-3 mr-4 text-xs text-muted-foreground underline"
          data-testid="decision-copy-link"
          onClick={() => {
            navigator.clipboard
              .writeText(link)
              .then(() => toast.success("Link copied"))
              .catch(() =>
                toast.error("Couldn't copy the link", { description: link }),
              );
          }}
          type="button"
        >
          Copy link
        </button>
      ) : null}

      <button
        aria-expanded={showDetails}
        className="mt-3 text-xs text-muted-foreground underline"
        onClick={() => setShowDetails((v) => !v)}
        type="button"
      >
        {showDetails ? "Hide technical details" : "Technical details"}
      </button>
      {showDetails ? (
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 break-all text-xs text-muted-foreground">
          <dt>Decision id</dt>
          <dd className="font-mono">{decision.id}</dd>
          {decision.action ? (
            <>
              <dt>Calls</dt>
              <dd className="font-mono">{decision.action.to}</dd>
              <dt>With</dt>
              <dd className="font-mono">{decision.action.data}</dd>
            </>
          ) : null}
          {decision.openedBy ? (
            <>
              <dt>Opened in</dt>
              <dd className="font-mono">{decision.openedBy}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
    </Card>
  );
}

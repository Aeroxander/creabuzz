import { useState } from "react";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { type DescribeContext, formatUnits } from "../lib/dao-actions";
import { describeDecision } from "../lib/decision-describe";
import type { Decision, DecisionsSnapshot } from "../lib/decisions";
import { encodeExecuteByVotes, encodeQueue } from "../lib/vote-tx";
import { votingRuleWatch, votingStatusLabel } from "../lib/voting-allocation";
import { DecisionVote } from "./DecisionVote";

const shares = (wei: bigint) => formatUnits(wei, 18, 4);

const when = (seconds: number | bigint) =>
  new Date(Number(seconds) * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

function duration(seconds: bigint): string {
  const s = Number(seconds);
  if (s % 86_400 === 0) return `${s / 86_400} day${s === 86_400 ? "" : "s"}`;
  if (s % 3_600 === 0) return `${s / 3_600} hour${s === 3_600 ? "" : "s"}`;
  if (s % 60 === 0) return `${s / 60} minute${s === 60 ? "" : "s"}`;
  return `${s} seconds`;
}

/** Where a decision stands, in words, and the one step (if any) anyone can take to move it along. */
export function decisionStage(
  decision: Decision,
  now: number,
): {
  label: string;
  tone: "open" | "good" | "wait" | "bad" | "done";
  next: string;
  step: "start" | "run" | null;
} {
  const delay = decision.rules?.delay ?? 0n;
  switch (decision.state) {
    case "Executed":
      return {
        label: "Done",
        tone: "done",
        next: "This decision was carried out.",
        step: null,
      };
    case "Expired":
      return {
        label: "Expired",
        tone: "bad",
        next: "It did not get enough support in time. Support you gave it is free again.",
        step: null,
      };
    case "Defeated":
      return {
        label: "Rejected",
        tone: "bad",
        next: "It was voted down.",
        step: null,
      };
    case "Queued":
      return {
        label: "Waiting to run",
        tone: "wait",
        next: `Approved. It can run at ${when(decision.queuedAt + Number(delay))}. Support must hold until then.`,
        step: null,
      };
    case "Succeeded":
      return decision.queuedAt === 0
        ? {
            label: "Approved",
            tone: "good",
            next: `It has enough support. Start the ${duration(delay)} wait, then it can run.`,
            step: "start",
          }
        : {
            label: "Ready to run",
            tone: "good",
            next: "The wait is over and support held. Anyone can run it now.",
            step: "run",
          };
    default:
      return {
        label: "Collecting support",
        tone: "open",
        next:
          decision.rules && now < Number(decision.rules.reviewEndsAt)
            ? `Nothing can run before ${when(decision.rules.reviewEndsAt)}, whatever the vote.`
            : "It needs enough support, and that support has to hold.",
        step: null,
      };
  }
}

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
}) {
  const [showDetails, setShowDetails] = useState(false);
  const stage = decisionStage(decision, snapshot.chainTime);
  const described = decision.action
    ? describeDecision(decision.action, {
        ...describeContext,
        currencyDecimals,
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
  const open = ["Active", "Succeeded", "Queued"].includes(decision.state);
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
    <Card className="p-4" data-testid="decision-card">
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
        <span className="font-mono">{decision.proposer.slice(0, 8)}…</span> ·{" "}
        {when(decision.openedAt)}
      </p>

      {rules ? (
        <p
          className="mt-2 text-xs text-muted-foreground"
          data-testid="decision-rules"
        >
          To pass, at least {shares(rules.quorum)} Shares must take part and{" "}
          {Number(rules.approvalBps) / 100}% of the votes cast must back it.
          Support has to hold for {duration(rules.hold)} without a break
          {rules.bounded ? ", inside a budget the DAO already voted" : ""}, and
          after that there is a {duration(rules.delay)} wait before it can run.
          It expires {when(rules.expiresAt)}.
        </p>
      ) : null}

      <p className="mt-2 text-sm" data-testid="decision-support">
        Backing {shares(decision.support.yes)} · Against{" "}
        {shares(decision.support.no)} · No side{" "}
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
                : "Run it"}
          </Button>
          {stage.step === "run" && !decision.action ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Running needs the decision's details, and this one never published
              them.
            </p>
          ) : null}
        </div>
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

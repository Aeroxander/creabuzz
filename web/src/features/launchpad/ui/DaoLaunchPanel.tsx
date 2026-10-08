import { useMemo } from "react";

import { Button } from "@/shared/ui/button";
import { formatAtomic } from "../lib/amounts";
import { stepMarker } from "../lib/auction-copy";
import type { Launch } from "../models";
import { useDaoLaunch } from "../use-dao-launch";
import { useConnectedWallet } from "../use-connected-wallet";
import {
  AddressRow,
  FailureNote,
  GateNote,
  StatusLine,
  StepRow,
  WalletStrip,
} from "./auction-widgets";
import { UnauditedNotice } from "./UnauditedNotice";

const shares = (wei: bigint) => formatAtomic(wei, 18, { maxFractionDigits: 0 });

function years(seconds: bigint): string {
  const months = Math.round(Number(seconds) / (30.4375 * 86_400));
  if (months >= 24 && months % 12 === 0) return `${months / 12} years`;
  return months === 1 ? "1 month" : `${months} months`;
}

type StepStatus = "done" | "running" | "failed" | "pending";

/**
 * Launch the project with its own DAO: one transaction creates the DAO, opens the sale of its Shares, vests the
 * team's allocation to the founder's wallet and points the raise at the DAO's treasury. Nothing is held by the
 * founder's wallet in between, and nothing needs to be deployed first.
 *
 * Only the transaction spends money, and it is sent once. Saving the result to this launch and publishing its
 * receipt come after it and can be retried (or finished after a reload) without sending anything again.
 */
export function DaoLaunchPanel({
  launch,
  onLink,
}: {
  launch: Launch;
  /** Publishes the launch record with the DAO's Shares, auction and treasury; must PROPAGATE errors. */
  onLink: (link: {
    token: string;
    auction: string;
    treasury: string;
  }) => Promise<unknown>;
}) {
  const { record } = launch;
  const wallet = useConnectedWallet();
  const { view, state, start } = useDaoLaunch({ launch, wallet, onLink });
  const { plan, summary, gate } = view;
  const { progress, failure, running, resumable, done } = state;

  const steps = useMemo(() => {
    const phase = (
      finished: boolean,
      step: "send" | "confirm" | "link" | "publish",
    ): StepStatus => {
      if (finished) return "done";
      if (
        failure &&
        (failure.step === step ||
          (step === "send" && failure.step === "confirm"))
      ) {
        return "failed";
      }
      return "pending";
    };
    const sent = progress.txHash !== null;
    const currentIsSend = running && !sent;
    const currentIsLink = running && sent && !progress.linked;
    const currentIsPublish = running && progress.linked && !progress.published;
    return [
      {
        id: "send",
        label: "Create the DAO and open the sale",
        detail:
          "One transaction. It mints the Shares, locks the team's allocation, and sends the raise to the DAO.",
        status: (currentIsSend
          ? "running"
          : phase(progress.launched !== null || sent, "send")) as StepStatus,
      },
      {
        id: "link",
        label: "Save it to this launch",
        detail: "Adds the DAO and the sale to this page.",
        status: (currentIsLink
          ? "running"
          : phase(progress.linked, "link")) as StepStatus,
      },
      {
        id: "publish",
        label: "Publish the launch receipt",
        detail: "Lets everyone find the DAO from this launch.",
        status: (currentIsPublish
          ? "running"
          : phase(progress.published, "publish")) as StepStatus,
      },
    ];
  }, [failure, progress, running]);

  // Already launched in an earlier visit, nothing left to save: the sale panel below takes over.
  if (record.auction && !done && !running && !failure && !resumable) {
    return null;
  }

  const waitingToFinish = resumable && !running && !failure && !done;
  const canFinish =
    !running && (failure?.mayResend === false || waitingToFinish);
  const canStart = !running && !done && !canFinish && gate.ok && plan !== null;
  const statusText = running
    ? "Working…"
    : done
      ? "Your project is live. The sale is open."
      : "";

  return (
    <div
      className="mt-3 rounded-lg border border-black/10 p-3 dark:border-white/10"
      data-testid="dao-launch-panel"
    >
      <h3 className="text-sm font-semibold text-black dark:text-white">
        Launch with its own DAO
      </h3>
      <p className="mt-1 text-sm text-black/60 dark:text-white/60">
        One transaction creates the project's DAO and opens the sale of its
        Shares. The raise goes straight to the DAO's treasury, never to your
        wallet, and backers can leave with their part of it. Your team
        allocation vests to your wallet over time.
      </p>
      {summary ? (
        <dl
          className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm"
          data-testid="dao-launch-summary"
        >
          <dt className="text-black/60 dark:text-white/60">Sold in the sale</dt>
          <dd>{shares(summary.sale)} Shares</dd>
          <dt className="text-black/60 dark:text-white/60">Your team</dt>
          <dd>
            {shares(summary.team)} Shares
            {plan && summary.team > 0n
              ? `, unlocking after ${years(plan.vestCliff)}, fully by ${years(plan.vestDuration)}`
              : ""}
          </dd>
          <dt className="text-black/60 dark:text-white/60">Kept by the DAO</dt>
          <dd>{shares(summary.treasury)} Shares (they never vote)</dd>
        </dl>
      ) : null}
      <UnauditedNotice chainId={record.chainId} />
      <WalletStrip testIdPrefix="dao-launch" wallet={wallet} />
      <GateNote gate={gate} testId="dao-launch-gate" />

      <ol aria-label="Launch steps" className="mt-3 flex flex-col gap-1">
        {steps.map((step) => (
          <StepRow
            detail={step.detail}
            key={step.id}
            label={step.label}
            marker={stepMarker(step.status)}
            status={
              step.status === "done"
                ? "Done"
                : step.status === "running"
                  ? "In progress…"
                  : step.status === "failed"
                    ? "Needs another try"
                    : ""
            }
            testId={`dao-launch-step-${step.id}`}
          />
        ))}
      </ol>

      {waitingToFinish ? (
        <p
          className="mt-2 text-sm text-black/70 dark:text-white/70"
          data-testid="dao-launch-resume-note"
        >
          A launch you sent earlier has not been saved to this page yet. It will
          not be sent again.
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {canFinish ? (
          <Button
            aria-busy={running}
            data-testid="dao-launch-finish"
            onClick={start}
            size="sm"
            type="button"
          >
            Finish saving
          </Button>
        ) : (
          <Button
            aria-busy={running}
            data-testid="dao-launch-start"
            disabled={!canStart}
            onClick={start}
            size="sm"
            type="button"
          >
            {running ? "Launching…" : "Launch project"}
          </Button>
        )}
        {failure?.mayResend ? (
          <span className="text-sm text-black/60 dark:text-white/60">
            Nothing was created, so you can try again.
          </span>
        ) : null}
      </div>
      {failure ? (
        <FailureNote message={failure.message} testId="dao-launch-failure" />
      ) : null}
      <StatusLine testId="dao-launch-status" text={statusText} />

      {progress.launched ? (
        <>
          <AddressRow
            copyLabel="Copy DAO address"
            label="The project's DAO"
            value={progress.launched.dao}
          />
          <AddressRow
            copyLabel="Copy Shares address"
            label="Its Shares"
            value={progress.launched.shares}
          />
          <AddressRow
            copyLabel="Copy sale address"
            label="The sale"
            value={progress.launched.auction}
          />
        </>
      ) : null}
    </div>
  );
}

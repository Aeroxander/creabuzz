/**
 * The milestones of a project whose team's Shares unlock unless holders object (`MilestoneChallenge`): what the rule is,
 * where each milestone stands, and what the connected person can do about it. It reads the same for everyone; the buttons
 * are the ones this person may press (the team publishes, holders object and vote, anyone finishes or settles).
 *
 * It says plainly what the lock does and does not do: it holds back the team's original allocation; it does not stop
 * holders from voting to spend the treasury or to issue more Shares.
 */

import { useMemo } from "react";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { countOf } from "@/shared/lib/count-of";

import { recordSaleCurrency } from "../chain";
import { formatAtomic } from "../lib/amounts";
import {
  type ChallengeViewer,
  NO_VIEWER,
  challengeActions,
  challengeGateFor,
  challengePublishBlock,
  span,
} from "../lib/challenge-copy";
import { challengeEvidenceFor } from "../lib/challenge-evidence";
import type { ChallengeLockView } from "@creaton/core/launchpad/milestoneChallenge.ts";
import { plannedMilestoneTokens } from "../lib/milestone-plan";
import { formatShares } from "../lib/shares-format";
import { hashText } from "@creaton/core/launchpad/work.ts";
import type { Launch } from "../models";
import { type LockState, useChallengeViewers } from "../use-challenge-lock";
import { useChallengeActions } from "../use-challenge-actions";
import { useActingAccount } from "../use-acting-account";
import { useEvidencePackets } from "../use-evidence";
import { useWalletLabels } from "../use-wallet-labels";
import { FailureNote, GateNote, WalletStrip } from "./account-widgets";
import { ChallengeMilestoneCard } from "./ChallengeMilestoneCard";
import { useTokenDecimals } from "./WorkBudgetForm";

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });

export function ChallengeMilestones({
  launch,
  dao,
  view,
  lockState,
  onOpenDecisions,
}: {
  launch: Launch;
  dao: string;
  view: ChallengeLockView;
  /** How fresh the lock is, and how to read it again. */
  lockState: LockState;
  onOpenDecisions: () => void;
}) {
  const { terms } = view;
  const wallet = useActingAccount();
  const me = wallet.address?.toLowerCase() ?? null;
  const viewers = useChallengeViewers(
    view.lock,
    wallet.address,
    view.milestones.length,
  );
  const evidence = useEvidencePackets(launch);

  // The words of each milestone come from the launch record, and are used only when they hash to what the lock holds.
  const planned = launch.record.unlocks?.milestones ?? [];
  const plannedTokens = plannedMilestoneTokens(launch.record);
  const wordsOf = (index: number): string | undefined => {
    const words = planned[index]?.label?.trim();
    const m = view.milestones[index];
    return words && m && hashText(words).toLowerCase() === m.checkHash
      ? words
      : undefined;
  };

  const sale = recordSaleCurrency(launch.record);
  const bondIsSale =
    terms.bondToken === null ||
    sale.value.toLowerCase() === terms.bondToken.toLowerCase();
  const otherDecimals = useTokenDecimals(
    bondIsSale ? "" : (terms.bondToken ?? ""),
  );
  const money = (units: bigint): string => {
    if (bondIsSale) {
      return `${formatAtomic(units, sale.decimals, { maxFractionDigits: 2 })} ${sale.symbol}`;
    }
    // A bond in some other token: its precision is shown only once it has been read. A guessed one would misstate the amount.
    return otherDecimals.data === undefined
      ? `${units.toString()} raw units of the bond token`
      : `${formatAtomic(units, otherDecimals.data, { maxFractionDigits: 2 })} of the bond token`;
  };
  const shares = (units: bigint) => formatShares(units);

  const people = useMemo(
    () => [
      ...view.team,
      ...view.milestones.flatMap((m) => [
        ...(m.submitter ? [m.submitter] : []),
        ...(m.objection ? [m.objection.objector] : []),
      ]),
    ],
    [view],
  );
  const labelOf = useWalletLabels(people);

  const actions = useChallengeActions({ launch, dao, view, wordsOf });
  // What the lock needs before a milestone can be published: the sale's claim block, and the milestone before it settled.
  const gateFor = (index: number) => challengeGateFor(view, index);
  const unlocked = view.milestones.filter((m) => m.phase === "stood").length;

  return (
    <div className="flex flex-col gap-4" data-testid="challenge-milestones">
      <Card className="p-4">
        <h2 className="text-base font-bold">Milestones</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The team votes with all of its Shares from the start, but a defined
          part of them stays locked: it cannot be sold or moved until a
          milestone is reached.
        </p>
        <details className="mt-2 text-sm" data-testid="challenge-rules">
          <summary className="cursor-pointer font-medium">
            How milestone unlocks work
          </summary>
          <ol className="mt-1 list-decimal space-y-1 pl-5">
            <li>
              The team publishes its evidence and posts a bond of{" "}
              {money(terms.bond)}. A bond is a deposit the team loses if holders
              turn the milestone down.
            </li>
            <li>
              For {span(terms.window)} (longer for a bigger milestone, and
              longer again after each attempt holders turn down) any holder can
              object. If nobody does, anyone can finish it and the Shares
              unlock.
            </li>
            <li>
              A holder who objects posts{" "}
              {terms.deposit > 0n ? money(terms.deposit) : "nothing"} and
              holders vote; the team&apos;s own Shares do not count. The
              objection stands only if more is against the milestone than for it
              and at least {terms.minRejectBps / 100}% of what could vote is
              against it. With less interest than that, the milestone stands.
            </li>
            <li>
              For {span(terms.clawback)} after an unlock, one more objection is
              possible. If holders agree with it, the team&apos;s remaining
              locked Shares are destroyed.
            </li>
          </ol>
          <p className="mt-2 text-muted-foreground">
            Milestones are published in order, and the next only once the one
            before has had its time for late objections. So the Shares still
            ahead stay locked, and can be destroyed, while an earlier milestone
            can be objected to. Once the last one has unlocked, what stands
            behind it is the bond.
          </p>
        </details>
        <p className="mt-2 text-sm text-muted-foreground">
          Backers can still leave with their share of the project's money while
          a milestone waits.
        </p>
        <p className="mt-2 text-sm" data-testid="challenge-summary">
          {unlocked} of {countOf(view.milestones.length, "milestone")} unlocked.{" "}
          {shares(view.locked)} Shares still locked.
        </p>
        <p
          className="mt-2 rounded-lg bg-black/5 p-2 text-xs text-muted-foreground dark:bg-white/5"
          data-testid="challenge-limits"
        >
          What this does not do: it holds back the team&apos;s original Shares.
          Holders can still vote to spend the project's money or to issue more
          Shares or non-voting shares, and those votes do not wait for
          milestones.{" "}
          <button className="underline" onClick={onOpenDecisions} type="button">
            See the decisions
          </button>
        </p>
        <p
          className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
          data-testid="challenge-freshness"
        >
          <span>
            {lockState.readAt
              ? `Read from the network at ${clock(lockState.readAt)}.`
              : "Reading from the network…"}
          </span>
          {lockState.paused ? (
            <span>It has stopped updating on its own.</span>
          ) : (
            <span>It updates on its own while you watch.</span>
          )}
          <Button
            aria-busy={lockState.fetching}
            data-testid="challenge-refresh"
            onClick={lockState.refresh}
            size="sm"
            type="button"
            variant="outline"
          >
            {lockState.fetching ? "Refreshing…" : "Refresh"}
          </Button>
        </p>
        {lockState.stale ? (
          <p
            className="mt-2 rounded-lg bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
            data-testid="challenge-stale"
            role="status"
          >
            Could not refresh just now. What is shown is what was read at{" "}
            {lockState.readAt ? clock(lockState.readAt) : "an earlier time"},
            and a vote or a deadline since then may not show yet.
          </p>
        ) : null}
        <WalletStrip testIdPrefix="challenge" wallet={wallet} />
        <GateNote
          gate={
            actions.sender.gate === null
              ? { ok: true }
              : { ok: false, message: actions.sender.gate }
          }
          testId="challenge-gate"
        />
      </Card>

      <ol className="flex flex-col gap-3">
        {view.milestones.map((m) => {
          const viewer: ChallengeViewer = !me
            ? NO_VIEWER
            : {
                wallet: me,
                onTeam: view.team.includes(me),
                weight: viewers.data?.[m.index]?.weight ?? 0n,
                voted: viewers.data?.[m.index]?.voted ?? false,
              };
          const tokens = plannedTokens[m.index];
          return (
            <ChallengeMilestoneCard
              actions={challengeActions(
                m,
                terms,
                view.now,
                viewer,
                gateFor(m.index),
              )}
              blocked={actions.blocked}
              handlers={actions}
              key={m.index}
              labelOf={labelOf}
              m={m}
              money={money}
              shares={shares}
              evidenceError={evidence.error}
              evidenceIncomplete={evidence.incomplete}
              onRetryEvidence={evidence.refetch}
              publishNote={
                viewer.onTeam &&
                (m.stage === "not-submitted" || m.stage === "rejected")
                  ? challengePublishBlock(m.index, terms, gateFor(m.index))
                  : null
              }
              standing={challengeEvidenceFor(m, evidence.packets, view.lock)}
              tokens={
                tokens !== null && tokens !== undefined
                  ? `About ${shares(tokens)} Shares will be held back (${m.bps / 100}% of the team's locked Shares)`
                  : `${m.bps / 100}% of the team's locked Shares`
              }
              view={view}
              wallet={me}
              weight={viewer.weight}
              words={wordsOf(m.index)}
              working={actions.working}
            />
          );
        })}
      </ol>

      {actions.problem ? (
        <FailureNote message={actions.problem} testId="challenge-problem" />
      ) : null}
      {actions.sender.failure ? (
        <FailureNote
          message={actions.sender.failure}
          testId="challenge-failure"
        />
      ) : null}
    </div>
  );
}

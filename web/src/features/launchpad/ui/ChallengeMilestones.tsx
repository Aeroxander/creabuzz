/**
 * The milestones of a project whose team's tokens unlock unless holders object (`MilestoneChallenge`): what the rule is,
 * where each milestone stands, and what the connected person can do about it. It reads the same for everyone; the buttons
 * are the ones this person may press (the team publishes, holders object and vote, anyone finishes or settles).
 *
 * It says plainly what the lock does and does not do: it holds back the team's original allocation; it does not stop
 * holders from voting to spend the treasury or to issue more Shares.
 */

import { useMemo } from "react";

import { Card } from "@/shared/ui/card";
import { countOf } from "@/shared/lib/count-of";

import { recordSaleCurrency } from "../chain";
import { formatAtomic } from "../lib/amounts";
import {
  type ChallengeViewer,
  NO_VIEWER,
  challengeActions,
  span,
} from "../lib/challenge-copy";
import { challengeEvidenceFor } from "../lib/challenge-evidence";
import type { ChallengeLockView } from "../lib/milestone-challenge";
import { plannedMilestoneTokens } from "../lib/milestone-plan";
import { formatShares } from "../lib/shares-format";
import { hashText } from "../lib/work";
import type { Launch } from "../models";
import { useChallengeViewers } from "../use-challenge-lock";
import { useChallengeActions } from "../use-challenge-actions";
import { useConnectedWallet } from "../use-connected-wallet";
import { useEvidencePackets } from "../use-evidence";
import { useWalletLabels } from "../use-wallet-labels";
import { FailureNote, GateNote, WalletStrip } from "./auction-widgets";
import { ChallengeMilestoneCard } from "./ChallengeMilestoneCard";
import { useTokenDecimals } from "./WorkBudgetForm";

export function ChallengeMilestones({
  launch,
  dao,
  view,
  onOpenDecisions,
}: {
  launch: Launch;
  dao: string;
  view: ChallengeLockView;
  onOpenDecisions: () => void;
}) {
  const { terms } = view;
  const wallet = useConnectedWallet();
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
    const decimals = bondIsSale ? sale.decimals : (otherDecimals.data ?? 18);
    const symbol = bondIsSale ? sale.symbol : "of the bond token";
    return `${formatAtomic(units, decimals, { maxFractionDigits: 2 })} ${symbol}`;
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
  const unlocked = view.milestones.filter((m) => m.phase === "stood").length;

  return (
    <div className="flex flex-col gap-4" data-testid="challenge-milestones">
      <Card className="p-4">
        <h2 className="text-base font-bold">Milestones</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The team votes with all of its tokens from the start, but a defined
          part of them stays locked: it cannot be sold or moved until a
          milestone is reached.
        </p>
        <p className="mt-2 text-sm" data-testid="challenge-rules">
          A milestone is reached like this. The team publishes its evidence and
          posts a bond of {money(terms.bond)}. For {span(terms.window)} (longer
          for a bigger milestone, and longer again after each attempt holders
          turn down) any holder can object; if nobody does, anyone can finish it
          and the tokens unlock. A holder who objects posts{" "}
          {terms.deposit > 0n ? money(terms.deposit) : "nothing"} and holders
          vote. The team&apos;s own tokens do not count. The objection stands
          only if more is against the milestone than for it and at least{" "}
          {terms.minRejectBps / 100}% of what could vote is against it; with
          less interest than that, the milestone stands. For{" "}
          {span(terms.clawback)} after an unlock, one more objection is
          possible, and if holders uphold it the team&apos;s remaining locked
          tokens are burned.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Backers can still leave with their share of the treasury while a
          milestone waits.
        </p>
        <p className="mt-2 text-sm" data-testid="challenge-summary">
          {unlocked} of {countOf(view.milestones.length, "milestone")} unlocked.{" "}
          {shares(view.locked)} tokens still locked.
        </p>
        <p
          className="mt-2 rounded-lg bg-black/5 p-2 text-xs text-muted-foreground dark:bg-white/5"
          data-testid="challenge-limits"
        >
          What this does not do: it holds back the team&apos;s original tokens.
          Holders can still vote to spend the treasury or to issue more tokens,
          and those votes do not wait for milestones.{" "}
          <button className="underline" onClick={onOpenDecisions} type="button">
            See the decisions
          </button>
        </p>
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
              actions={challengeActions(m, terms, view.now, viewer)}
              blocked={actions.blocked}
              handlers={actions}
              key={m.index}
              labelOf={labelOf}
              m={m}
              money={money}
              shares={shares}
              standing={challengeEvidenceFor(m, evidence.packets, view.lock)}
              tokens={
                tokens !== null && tokens !== undefined
                  ? `About ${shares(tokens)} tokens will be held back (${m.bps / 100}% of the team's locked tokens)`
                  : `${m.bps / 100}% of the team's locked tokens`
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

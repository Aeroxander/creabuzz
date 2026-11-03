import { useMemo } from "react";

import { existingUserPubkey } from "@/shared/lib/identity";
import { hashText } from "@creaton/core/launchpad/work.ts";

import type { ChallengeIntent } from "../lib/challenge";
import { payoutsFactory, weeklyRounds } from "../chain-config";
import { recordSources } from "../lib/ways-to-help";
import { useEvidencePackets } from "../use-evidence";
import type { SponsorIntent } from "../lib/sponsor";
import { isContributorProject } from "../lib/funding";
import { Card } from "@/shared/ui/card";
import { FailureNote, WalletStrip } from "./account-widgets";
import { recordSaleCurrency } from "../chain";
import type { Launch } from "../models";
import { useDecisionContext, useDecisions } from "../use-decisions";
import { useWork } from "../use-work";
import { useWalletSend } from "../use-wallet-send";
import { Button } from "@/shared/ui/button";
import { proposalTopic } from "@/features/board/lib/proposal-link";
import { decisionUrl } from "../lib/decision-link";
import { useDaoThreads } from "@/features/board/use-dao-threads";
import { CheckNoteBrief } from "./CheckNoteCard";
import { ChallengeBrief } from "./ChallengeQuestions";
import { useChallenges } from "../use-challenges";
import { DecisionCard } from "./DecisionCard";
import { DecisionDiscussion } from "./DecisionDiscussion";
import { DecisionComposer } from "./DecisionComposer";
import { useSpendingSummary } from "../use-spending";
import { bondsOf } from "./decision-title";

/**
 * Everything the DAO has put to a vote, read from the chain: what each decision would do, where it stands, and how
 * to back it, oppose it, start its wait or make it take effect. Whoever opened a decision (this app, the command line, an agent),
 * it shows up here.
 */
export function DecisionsTab({
  launch,
  dao,
  focusDecision,
  challenge,
  sponsor,
}: {
  launch: Launch;
  dao: string;
  /** The decision a link pointed at: highlighted and scrolled to. */
  focusDecision?: string;
  /** A claim someone came here to doubt: the form for it opens with that claim chosen. */
  challenge?: ChallengeIntent | null;
  /** A suggestion being put to a vote: the composer opens "Approve a work area" filled in from it. */
  sponsor?: SponsorIntent | null;
}) {
  const { wallet, gate, busy, failure, send } = useWalletSend(launch, dao);
  const decisions = useDecisions(dao, wallet.address);
  const sale = launch.record.currency
    ? recordSaleCurrency(launch.record)
    : null;
  const currencyDecimals = sale?.decimals;
  const snapshot = decisions.data;
  const context = useDecisionContext(dao);
  const work = useWork(dao, wallet.address);
  // The case against each money vote, as its proposer answered before opening it (CHALLENGER-PLAN.md).
  const challenges = useChallenges(launch);
  // The talk about each decision lives on the community's boards.
  const chainId = Number(launch.record.chainId);
  const usableChain = Number.isSafeInteger(chainId) && chainId > 0;
  const discussion = useDaoThreads(usableChain ? chainId : null, dao);
  // A work area's words, for the hash its vote names: from the project's record and the updates posted with its votes.
  const evidence = useEvidencePackets(launch);
  const checkWords = useMemo(() => {
    const byHash = new Map<string, string>();
    for (const source of [
      ...recordSources(launch.record.workAreas ?? []),
      ...evidence.areaWords,
    ]) {
      const text = source.text.trim();
      if (text) byHash.set(hashText(text), text);
    }
    return (check: string) => byHash.get(check.toLowerCase()) ?? null;
  }, [launch.record.workAreas, evidence.areaWords]);
  const { labelOf } = useSpendingSummary({
    dao,
    currency: launch.record.currency,
    decisions: snapshot,
    work: work.data,
    factory: context.data?.factory,
  });

  return (
    <div className="flex flex-col gap-4" data-testid="decisions-tab">
      <Card className="p-4">
        <h2 className="text-base font-bold">Decisions</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          What the project is voting on. Back or oppose a decision with your
          Shares; voting never uses them up.
        </p>
        {existingUserPubkey() ? (
          <WalletStrip testIdPrefix="decisions" wallet={wallet} />
        ) : null}
        {gate && wallet.address ? (
          <p
            className="mt-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
            data-testid="decisions-gate"
            role="status"
          >
            {gate}
          </p>
        ) : null}
      </Card>

      {snapshot && context.data ? (
        <DecisionComposer
          launch={launch}
          busy={busy}
          challenge={challenge}
          sponsor={sponsor}
          ctx={{
            dao,
            chainId,
            chainTime: snapshot.chainTime,
            wallet: wallet.address,
            factory: context.data.factory,
            // A work budget needs a currency that exists; a project that sold for none uses its own Shares.
            currency: launch.record.currency ?? context.data.shares,
            currencyDecimals: currencyDecimals ?? null,
            currencySymbol:
              sale?.kind === "custom" ? "USDC" : (sale?.symbol ?? "units"),
            work: work.data,
            decisions: snapshot,
            workError:
              work.isError && !work.data
                ? work.error instanceof Error
                  ? work.error.message
                  : "unknown error"
                : null,
            policy: context.data.policy,
            sharesToken: context.data.shares,
            fundingTerms: context.data.fundingTerms,
            milestoneWords: (launch.record.unlocks?.milestones ?? []).map(
              (m) => m.label,
            ),
            contributor: isContributorProject(launch.record),
          }}
          gate={gate}
          onSend={send}
          snapshot={snapshot}
        />
      ) : null}

      {decisions.isLoading ? (
        <Card className="p-4 text-sm text-muted-foreground">
          Reading the decisions from the network…
        </Card>
      ) : decisions.isError ? (
        <Card className="p-4">
          <FailureNote
            message={`Couldn't read the decisions from the network: ${decisions.error instanceof Error ? decisions.error.message : "unknown error"}`}
            testId="decisions-error"
          />
          <Button
            className="mt-2"
            onClick={() => void decisions.refetch()}
            size="sm"
            type="button"
            variant="outline"
          >
            Try again
          </Button>
        </Card>
      ) : snapshot && snapshot.decisions.length === 0 ? (
        <Card className="p-4 text-sm" data-testid="decisions-empty">
          Nothing has been put to a vote yet.
        </Card>
      ) : snapshot ? (
        <>
          {snapshot.truncated ? (
            <p className="text-sm text-muted-foreground" role="status">
              This DAO has {snapshot.total} decisions. The newest{" "}
              {snapshot.decisions.length} are shown.
            </p>
          ) : null}
          <ol aria-label="Decisions" className="flex flex-col gap-3">
            {snapshot.decisions.map((decision) => (
              <li key={decision.id}>
                <DecisionCard
                  account={wallet.address}
                  beforeMoneyVote={
                    <div className="flex flex-col gap-1">
                      <ChallengeBrief
                        challenge={challenges.challengeOf(decision)}
                        read={challenges.query.data !== undefined}
                      />
                      {isContributorProject(launch.record) ? (
                        <CheckNoteBrief launch={launch} />
                      ) : null}
                    </div>
                  }
                  busy={busy}
                  currencyDecimals={currencyDecimals}
                  decision={decision}
                  describeContext={{
                    dao,
                    factory: context.data?.factory,
                    mandates: work.data?.mandates.map((m) => m.address),
                    bonds: bondsOf(work.data),
                    label: labelOf,
                    checkWords,
                    projectToken: context.data?.shares,
                    fundingTerms:
                      context.data?.fundingTerms?.kind === "present"
                        ? context.data.fundingTerms.address
                        : undefined,
                    weeklyRounds:
                      weeklyRounds(launch.record.chainId ?? null) ?? undefined,
                    payoutsFactory:
                      payoutsFactory(launch.record.chainId ?? null) ??
                      undefined,
                    currency: launch.record.currency ?? undefined,
                    currencySymbol:
                      sale?.kind === "custom" ? "USDC" : sale?.symbol,
                  }}
                  gate={gate}
                  highlighted={decision.id.toLowerCase() === focusDecision}
                  link={decisionUrl(
                    {
                      launchId: launch.record.id,
                      author: launch.record.author,
                      decisionId: decision.id.toLowerCase(),
                    },
                    window.location.origin,
                  )}
                  onSend={send}
                  renderDiscussion={(headline) => {
                    const ref = {
                      chainId,
                      dao: snapshot.dao.toLowerCase(),
                      id: decision.id.toLowerCase(),
                    };
                    // A decision that cannot be named exactly cannot be linked to, so it offers no discussion.
                    if (!usableChain || proposalTopic(ref) === null)
                      return null;
                    return (
                      <DecisionDiscussion
                        boards={discussion.boards}
                        decision={ref}
                        failed={discussion.error != null}
                        headline={headline}
                        loading={discussion.isLoading}
                        onRetry={discussion.refetch}
                        onStarted={discussion.refetch}
                        threads={discussion.threads.get(ref.id) ?? []}
                      />
                    );
                  }}
                  snapshot={snapshot}
                />
              </li>
            ))}
          </ol>
        </>
      ) : null}
      {failure ? (
        <FailureNote message={failure} testId="decisions-failure" />
      ) : null}
    </div>
  );
}

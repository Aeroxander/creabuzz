import { Card } from "@/shared/ui/card";
import { FailureNote, WalletStrip } from "./auction-widgets";
import { recordSaleCurrency } from "../chain";
import { useVerifiedExchange } from "../use-exchange";
import type { Launch } from "../models";
import { useDecisionContext, useDecisions } from "../use-decisions";
import { useWork } from "../use-work";
import { useWalletSend } from "../use-wallet-send";
import { Button } from "@/shared/ui/button";
import { proposalTopic } from "@/features/board/lib/proposal-link";
import { decisionUrl } from "../lib/decision-link";
import { useDaoThreads } from "@/features/board/use-dao-threads";
import { DecisionCard } from "./DecisionCard";
import { DecisionDiscussion } from "./DecisionDiscussion";
import { DecisionComposer } from "./DecisionComposer";
import { useSpendingSummary } from "../use-spending";
import { bondsOf } from "./decision-title";

/**
 * Everything the DAO has put to a vote, read from the chain: what each decision would do, where it stands, and how
 * to back it, oppose it, start its wait or run it. Whoever opened a decision (this app, the command line, an agent),
 * it shows up here.
 */
export function DecisionsTab({
  launch,
  dao,
  focusDecision,
}: {
  launch: Launch;
  dao: string;
  /** The decision a link pointed at: highlighted and scrolled to. */
  focusDecision?: string;
}) {
  const { wallet, gate, busy, failure, send } = useWalletSend(launch, dao);
  const decisions = useDecisions(dao, wallet.address);
  const sale = launch.record.currency
    ? recordSaleCurrency(launch.record)
    : null;
  const currencyDecimals = sale?.decimals;
  const { exchange } = useVerifiedExchange(launch.record.chainId);
  const snapshot = decisions.data;
  const context = useDecisionContext(dao);
  const work = useWork(dao, wallet.address);
  // The talk about each decision lives on the community's boards.
  const chainId = Number(launch.record.chainId);
  const usableChain = Number.isSafeInteger(chainId) && chainId > 0;
  const discussion = useDaoThreads(usableChain ? chainId : null, dao);
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
          What this project's holders have put to a vote. Back what you want
          with your Shares; a decision needs enough Shares taking part and
          enough of the votes behind it, and that support has to hold before it
          can run. Oppose as much as you like: it never uses your Shares up.
        </p>
        <WalletStrip testIdPrefix="decisions" wallet={wallet} />
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
          busy={busy}
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
            workError:
              work.isError && !work.data
                ? work.error instanceof Error
                  ? work.error.message
                  : "unknown error"
                : null,
            policy: context.data.policy,
            sharesToken: context.data.shares,
            exchange,
            milestoneWords: (launch.record.unlocks?.milestones ?? []).map(
              (m) => m.label,
            ),
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
                  busy={busy}
                  currencyDecimals={currencyDecimals}
                  decision={decision}
                  describeContext={{
                    dao,
                    factory: context.data?.factory,
                    mandates: work.data?.mandates.map((m) => m.address),
                    bonds: bondsOf(work.data),
                    label: labelOf,
                    projectToken: context.data?.shares,
                    amm: exchange?.amm,
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

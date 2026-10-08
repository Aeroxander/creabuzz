import { Card } from "@/shared/ui/card";
import { FailureNote, WalletStrip } from "./auction-widgets";
import { recordSaleCurrency } from "../chain";
import type { Launch } from "../models";
import { useDecisionContext, useDecisions } from "../use-decisions";
import { useWork } from "../use-work";
import { useWalletSend } from "../use-wallet-send";
import { Button } from "@/shared/ui/button";
import { DecisionCard } from "./DecisionCard";
import { DecisionComposer } from "./DecisionComposer";

/**
 * Everything the DAO has put to a vote, read from the chain: what each decision would do, where it stands, and how
 * to back it, oppose it, start its wait or run it. Whoever opened a decision (this app, the command line, an agent),
 * it shows up here.
 */
export function DecisionsTab({ launch, dao }: { launch: Launch; dao: string }) {
  const { wallet, gate, busy, failure, send } = useWalletSend(launch, dao);
  const decisions = useDecisions(dao, wallet.address);
  const currencyDecimals = launch.record.currency
    ? recordSaleCurrency(launch.record).decimals
    : undefined;
  const snapshot = decisions.data;
  const context = useDecisionContext(dao);
  const work = useWork(dao, wallet.address);

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
            chainTime: snapshot.chainTime,
            wallet: wallet.address,
            factory: context.data.factory,
            // A work budget needs a currency that exists; a project that sold for none uses its own Shares.
            currency: launch.record.currency ?? context.data.shares,
            currencyDecimals: launch.record.currency
              ? (currencyDecimals ?? null)
              : null,
            work: work.data,
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
                  gate={gate}
                  onSend={send}
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

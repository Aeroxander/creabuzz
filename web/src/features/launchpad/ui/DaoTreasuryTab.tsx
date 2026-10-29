/**
 * The Treasury tab of a project that launched into its own DAO.
 *
 * The raise went straight to the DAO, so there is no executor, escrow or price floor to explain: the tab says what the
 * DAO holds, where the money has gone (reviewed budgets versus direct payments), how a holder leaves with their share,
 * and who votes for them. The older panels (the graduation split, the enforcement register, streams, the plan priced from
 * the terms) describe a different launch and are not shown here.
 */

import { Card } from "@/shared/ui/card";

import { recordSaleCurrency } from "../chain";
import type { DaoBinding } from "../lib/org-money";
import { formatUnits } from "../lib/dao-actions";
import type { Launch } from "../models";
import { useActingAccount } from "../use-acting-account";
import { useDaoHoldings } from "../use-dao-holdings";
import { useDecisionContext, useDecisions } from "../use-decisions";
import { usePaymentRuns, useSpendingSummary } from "../use-spending";
import { useWork } from "../use-work";
import { DelegationCard } from "./DelegationCard";
import { Figure } from "./Figure";
import { RagequitPanel } from "./RagequitPanel";
import { SpendingCard } from "./SpendingCard";

export function DaoTreasuryTab({
  launch,
  dao,
  daoBinding,
  chainId,
  onOpenDecisions,
}: {
  launch: Launch;
  dao: string;
  daoBinding: DaoBinding;
  chainId: number;
  /** Go to the Decisions tab, where spending is voted. */
  onOpenDecisions: () => void;
}) {
  const wallet = useActingAccount().address;
  const decisions = useDecisions(dao, wallet);
  const work = useWork(dao, wallet);
  const context = useDecisionContext(dao);
  const sale = launch.record.currency
    ? recordSaleCurrency(launch.record)
    : null;
  const holdings = useDaoHoldings({
    dao,
    currency: launch.record.currency ?? null,
    shares: context.data?.shares ?? null,
    wallet,
  });
  const { spending, labelOf } = useSpendingSummary({
    dao,
    currency: launch.record.currency,
    decisions: decisions.data,
    work: work.data,
    factory: context.data?.factory,
  });
  const runs = usePaymentRuns(dao, spending);
  const symbol = sale?.kind === "custom" ? "USDC" : (sale?.symbol ?? "");
  const money = holdings.data?.treasury;
  return (
    <div
      className="grid max-w-3xl grid-cols-1 gap-4"
      data-testid="dao-treasury"
    >
      <Card className="p-4">
        <h2 className="text-base font-semibold">Treasury</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The money this project raised sits in its DAO. Holders decide what it
          is spent on, on the Decisions tab, and anyone holding Shares can leave
          with their share of what is left.
        </p>
        <div className="mt-3 max-w-xs">
          <Figure
            label="In the treasury"
            note={
              money === null ? "Could not be read from the network" : undefined
            }
            testId="dao-treasury-figure"
            value={
              money === null || money === undefined || !sale
                ? "—"
                : `${formatUnits(money, sale.decimals)} ${symbol}`.trim()
            }
          />
        </div>
      </Card>
      {spending && sale ? (
        <SpendingCard
          chainId={chainId}
          decimals={sale.decimals}
          labelOf={labelOf}
          onOpenDecisions={onOpenDecisions}
          runs={runs.isError && !runs.data ? null : runs.data}
          summary={spending}
          symbol={symbol}
        />
      ) : null}
      <RagequitPanel
        chainId={chainId}
        daoBinding={daoBinding}
        record={launch.record}
      />
      <DelegationCard
        author={launch.record.author}
        dao={daoBinding.dao}
        launchId={launch.record.id}
        members={[]}
      />
    </div>
  );
}

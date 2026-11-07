/**
 * "Treasury & flows" — the post-sale money story of a graduated launch, in
 * one screen. This is the web answer to the launchpad plan's open verdict
 * ("how do pooled funds flow after launch?" — docs/next-gen-launchpad-plan.md
 * Phase B "Money with a legible fate", §7.2 resolution "make the money
 * legible after the sale first, in the order a user meets it: bid receipts
 * and exit semantics, then the graduation destination").
 *
 * The panel answers, in the paperclip-ux-reference.md order (what is
 * happening / does it need me / what do I do about it):
 *
 * 1. **The split** — the GraduationExecutor's immutable record
 *    (`contracts/src/GraduationExecutor.sol:34-45`, read live from
 *    `graduations(auction)`): the raise split into reserve escrow (the TM
 *    floor seed) and treasury share, plus unsold tokens to the treasury.
 *    The math is `reserveShare = raised * reserveBps / 10_000`,
 *    `treasuryShare = raised - reserveShare` (:253-255), read from the same
 *    contract's `reserveBps()`/`treasury()` getters.
 * 2. **The recorded movements** — the deploy's 47005 `sweep`/`lock` receipts
 *    (payload shapes per `desktop/.../graduationFlow.ts:296-341`), plus any
 *    `summon`/`ragequit` receipts, each linking its tx.
 * 3. **Where the money sits now** — live treasury / pool / escrow balances
 *    (contract reads over the launchpad RPC seam).
 * 4. **What has been spent** — the org spend ledger: kind:37012 budgets
 *    (windows + ceilings), the `OrgAllowance` contract state behind each
 *    (`contracts/src/OrgAllowance.sol:63-81`), and kind:37014 spend receipts
 *    with their txs. Web reads these live off the relay query surface
 *    (`use-launches.ts` `fetchOrgMoney`) — the panel says so when the relay
 *    has none.
 *
 * Every number carries its source: a tx link where the money moved in a
 * transaction, a contract link for a balance read, and "chain read" wording
 * (with an explicit no-explorer note on dev chains) otherwise. Nothing on
 * this panel can move money — it is read-only legibility.
 */
import { useQuery } from "@tanstack/react-query";

import { truncatePubkey } from "@/shared/lib/pubkey";

import { getRpcEndpoint, recordSaleCurrency } from "../chain";
import type { LaunchReceipt, LaunchRecord } from "../models";
import {
  explorerAddressUrl,
  fetchFundFlowPositions,
  fetchGraduationState,
  fundFlowReceiptRows,
  graduationSplit,
  type GraduationState,
  type ReceiptRow,
} from "../lib/fund-flow";
import {
  budgetEpoch,
  fetchAllowanceState,
  type OrgBudget,
  type SpendReceipt,
} from "../lib/org-money";
import { formatAtomic, formatMoney } from "../lib/amounts";
import { ETH_TOKEN } from "../lib/ragequit-tx";
import { useOrgMoney } from "../use-launches";
import { TxLink } from "./TxLink";

export interface TreasuryFlowsPanelProps {
  record: LaunchRecord;
  /** The launch's 47005 receipts (on `Launch`, not `LaunchRecord`). */
  receipts: LaunchReceipt[];
  chainId: number;
}

/** A budget window in words: "per week", and "this week" for the live reading. */
const PER_WINDOW: Record<OrgBudget["windows"][number], string> = {
  epoch: "in total",
  day: "per day",
  week: "per week",
  month: "per month",
};
const THIS_WINDOW: Record<OrgBudget["windows"][number], string> = {
  epoch: "in total",
  day: "today",
  week: "this week",
  month: "this month",
};

/** How this panel prints an amount: money in the sale's own currency, tokens in their 18 decimals. */
interface Amounts {
  money(value: bigint): string;
  tokens(value: bigint): string;
}

function amountsFor(record: LaunchRecord): Amounts {
  const currency = recordSaleCurrency(record);
  return {
    money: (value) => formatMoney(value, currency),
    tokens: (value) => formatAtomic(value, 18, { maxFractionDigits: 2 }),
  };
}

/**
 * A receipt payload field as recorded — displayed verbatim (the payload is
 * the mirror's own decimal string), never re-parsed during render, so a
 * malformed mirror can never crash the panel.
 */
function payloadText(payload: Record<string, unknown>, field: string): string {
  const raw = payload[field];
  return typeof raw === "string" || typeof raw === "number" ? String(raw) : "—";
}

/** A receipt's amount: written out in the sale's currency when it is a whole number, else shown as recorded. */
function payloadAmount(
  payload: Record<string, unknown>,
  field: string,
  print: (value: bigint) => string,
): string {
  const text = payloadText(payload, field);
  return /^\d+$/.test(text) ? print(BigInt(text)) : text;
}

function AddrLink({ chainId, address }: { chainId: number; address: string }) {
  const url = explorerAddressUrl(chainId, address);
  return url ? (
    <a
      className="break-all text-sky-700 underline dark:text-sky-300"
      href={url}
      rel="noreferrer"
      target="_blank"
    >
      {truncatePubkey(address)}
    </a>
  ) : (
    <span className="break-all text-black/60 dark:text-white/60">
      {truncatePubkey(address)}
    </span>
  );
}

/** The money-story summary line + the split rows. */
function SplitSection({
  amounts,
  chainId,
  state,
}: {
  amounts: Amounts;
  chainId: number;
  state: GraduationState;
}) {
  const split = graduationSplit({
    currencyRaised: state.record.currencyRaised,
    reserveBps: state.reserveBps,
  });
  return (
    <section data-testid="fundflow-split">
      <h4 className="text-sm font-semibold text-black dark:text-white">
        What happened to the money when the sale ended
      </h4>
      <p className="mt-1 text-sm text-black/70 dark:text-white/70">
        The money raised went to the payout step and was split on the network:{" "}
        <strong>{amounts.money(state.record.currencyRaised)}</strong> raised →{" "}
        <strong>{amounts.money(split.reserveShare)}</strong> set aside for the
        market&apos;s price floor ({Number(state.reserveBps) / 100}% of the
        raise) + <strong>{amounts.money(split.treasuryShare)}</strong> to the
        project&apos;s money. The set-aside money is a promise the project
        keeps, not a guarantee: it goes to the recorded market pool, and if no
        pool is recorded the project can take it back once the hold on it (30
        days by default) has passed. Unsold tokens (
        {amounts.tokens(state.record.unsoldTokens)}) went to the project; sold
        tokens ({amounts.tokens(state.record.tokensSold)}) went to buyers.
      </p>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm text-black/80 dark:text-white/80">
        <dt>Set aside for the price floor (from the record)</dt>
        <dd className="text-right" data-testid="fundflow-reserve">
          {amounts.money(state.record.reserveEscrow)}
        </dd>
        <dt>Project&apos;s share (from the record)</dt>
        <dd className="text-right" data-testid="fundflow-treasury-share">
          {amounts.money(state.record.treasuryShare)}
        </dd>
        <dt>Split done</dt>
        <dd className="text-right">
          {state.record.executed
            ? "yes, the split has happened"
            : "not yet, the split is pending"}
        </dd>
        <dt>Payout step (contract)</dt>
        <dd className="text-right">
          <AddrLink chainId={chainId} address={state.executor} />
        </dd>
        <dt>Project&apos;s money (contract)</dt>
        <dd className="text-right">
          <AddrLink chainId={chainId} address={state.treasury} />
        </dd>
      </dl>
      {state.record.tokenMasterPool !== `0x${"0".repeat(40)}` ? (
        <p className="mt-1 text-xs text-black/50 dark:text-white/50">
          Market pool contract:{" "}
          <AddrLink chainId={chainId} address={state.record.tokenMasterPool} />
        </p>
      ) : null}
    </section>
  );
}

/** The recorded 47005 money movements, each bound to its tx. */
function ReceiptSection({
  amounts,
  chainId,
  rows,
}: {
  amounts: Amounts;
  chainId: number;
  rows: ReceiptRow[];
}) {
  if (rows.length === 0) {
    return (
      <section data-testid="fundflow-receipts">
        <h4 className="text-sm font-semibold text-black dark:text-white">
          Recorded movements
        </h4>
        <p className="mt-1 text-sm text-black/60 dark:text-white/60">
          No money movements are recorded for this project yet. They are
          recorded when the sale ends.
        </p>
      </section>
    );
  }
  return (
    <section data-testid="fundflow-receipts">
      <h4 className="text-sm font-semibold text-black dark:text-white">
        Recorded movements
      </h4>
      <ul className="mt-1 flex flex-col gap-1">
        {rows.map((row) => (
          <li
            className="flex flex-wrap items-center justify-between gap-2 text-sm text-black/80 dark:text-white/80"
            key={`${row.table}-${row.tx}-${row.createdAt}`}
          >
            <span>
              {row.table === "sweep"
                ? `Money raised ${payloadAmount(row.payload, "currencyRaised", amounts.money)}: project's share ${payloadAmount(row.payload, "treasuryShare", amounts.money)}, unsold tokens ${payloadAmount(row.payload, "unsoldTokens", amounts.tokens)}`
                : row.table === "lock"
                  ? `Set aside: ${payloadAmount(row.payload, "reserveEscrow", amounts.money)} to back the price floor (the project can take it back after the hold if no pool is recorded)`
                  : row.table === "summon"
                    ? "The project was set up for this sale"
                    : "Exit: an owner gave up shares and took their part of the project's money"}
            </span>
            <TxLink chainId={chainId} tx={row.tx} />
          </li>
        ))}
      </ul>
      <p className="mt-1 text-xs text-black/50 dark:text-white/50">
        Source: the records this project saved when the sale ended and when
        people left; each links to its record on the network.
      </p>
    </section>
  );
}

/** Where the money sits right now (live balances). */
function PositionSection({
  amounts,
  chainId,
  positions,
}: {
  amounts: Amounts;
  chainId: number;
  positions: Awaited<ReturnType<typeof fetchFundFlowPositions>>;
}) {
  const labels: Record<string, string> = {
    treasury: "The project holds",
    pool: "The market pool holds (price-floor backing)",
    escrow: "The payout step still holds (money not yet released)",
  };
  return (
    <section data-testid="fundflow-positions">
      <h4 className="text-sm font-semibold text-black dark:text-white">
        Where the money sits now
      </h4>
      <ul className="mt-1 flex flex-col gap-1">
        {positions.map((row) => (
          <li
            className="flex flex-wrap items-center justify-between gap-2 text-sm text-black/80 dark:text-white/80"
            key={`${row.label}-${row.holder}`}
          >
            <span>{labels[row.label] ?? row.label}</span>
            <span>
              <strong data-testid={`fundflow-position-${row.label}`}>
                {amounts.money(row.balance)}
              </strong>{" "}
              · <AddrLink chainId={chainId} address={row.holder} />
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-1 text-xs text-black/50 dark:text-white/50">
        Read live from the network (balances of the linked addresses).
      </p>
    </section>
  );
}

/** One budget row: the window, the ceiling, and the live allowance state. */
function BudgetRow({
  amounts,
  budget,
  token,
  chainId,
  spends,
}: {
  amounts: Amounts;
  budget: OrgBudget;
  token: string;
  chainId: number;
  spends: SpendReceipt[];
}) {
  const window = budget.windows[0] ?? "epoch";
  const allowanceQuery = useQuery({
    queryKey: [
      "org-allowance",
      budget.onchain?.contract,
      budget.onchain?.subject,
      token,
      window,
    ],
    enabled: Boolean(budget.onchain),
    queryFn: () =>
      fetchAllowanceState(getRpcEndpoint(), {
        contract: budget.onchain?.contract as string,
        subject: budget.onchain?.subject as string,
        token,
        window,
        now: BigInt(Math.floor(Date.now() / 1000)),
      }),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const related = spends.filter(
    (s) => s.budgetId === budget.id || s.subject === budget.subject,
  );
  const recorded = related.reduce((sum, s) => sum + s.amount, 0n);
  return (
    <li
      className="rounded-lg bg-black/5 p-2 text-sm text-black/80 dark:bg-white/5 dark:text-white/80"
      data-testid="fundflow-budget"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">
          budget {budget.id}: limit{" "}
          {budget.allocation ? amounts.money(budget.allocation) : "—"}{" "}
          {PER_WINDOW[window]}
          {budget.rollover ? " (rolls over)" : ""}
        </span>
        <span className="text-black/60 dark:text-white/60">
          for {truncatePubkey(budget.subject)}
        </span>
      </div>
      {budget.onchain ? (
        allowanceQuery.error ? (
          <p className="mt-1 text-red-700 dark:text-red-300">
            Could not read the spending limit:{" "}
            {allowanceQuery.error instanceof Error
              ? allowanceQuery.error.message
              : "the request failed"}
          </p>
        ) : allowanceQuery.data ? (
          <p className="mt-1">
            On the network: spent {amounts.money(allowanceQuery.data.spent)} of{" "}
            {amounts.money(allowanceQuery.data.allowance)} {THIS_WINDOW[window]}{" "}
            (period {allowanceQuery.data.epoch.toString()}),{" "}
            {amounts.money(allowanceQuery.data.remaining)} left
            {allowanceQuery.data.spender ? (
              <>
                {" "}
                · allowed to spend:{" "}
                <AddrLink
                  chainId={chainId}
                  address={allowanceQuery.data.spender}
                />
              </>
            ) : null}
          </p>
        ) : (
          <p className="mt-1 text-black/60 dark:text-white/60">
            Reading the spending limit…
          </p>
        )
      ) : (
        <p className="mt-1 text-black/60 dark:text-white/60">
          The network does not enforce a spending limit for this budget; its
          limit is a written record only.
        </p>
      )}
      {related.length > 0 ? (
        <ul className="mt-1 flex flex-col gap-1">
          {related.map((spend) => (
            <li
              className="flex flex-wrap items-center justify-between gap-2 text-black/70 dark:text-white/70"
              key={spend.id}
            >
              <span>
                spent {amounts.money(spend.amount)} by{" "}
                {spend.agent ? truncatePubkey(spend.agent) : "—"}
              </span>
              <TxLink chainId={chainId} tx={spend.txHash} />
            </li>
          ))}
          <li className="text-black/60 dark:text-white/60">
            recorded payments total {amounts.money(recorded)} (a copy for
            information; the network&apos;s own ledger is the source)
          </li>
        </ul>
      ) : (
        <p className="mt-1 text-black/60 dark:text-white/60">
          No payments recorded against this budget yet.
        </p>
      )}
    </li>
  );
}

export function TreasuryFlowsPanel({
  record,
  receipts,
  chainId,
}: TreasuryFlowsPanelProps) {
  const rpcEndpoint = getRpcEndpoint();
  const amounts = amountsFor(record);
  const graduationQuery = useQuery({
    queryKey: ["fund-flow", record.auction, rpcEndpoint],
    enabled: Boolean(record.auction),
    queryFn: () => fetchGraduationState(rpcEndpoint, record.auction as string),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const graduation = graduationQuery.data ?? null;
  const currency = graduation?.currency ?? ETH_TOKEN;

  const positionsQuery = useQuery({
    queryKey: ["fund-flow-positions", record.auction, rpcEndpoint],
    enabled: Boolean(graduation),
    queryFn: () =>
      fetchFundFlowPositions(rpcEndpoint, {
        currency,
        treasury: graduation?.treasury as string,
        tokenMasterPool: graduation?.record.tokenMasterPool as string,
        executor: graduation?.executor as string,
      }),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const orgMoney = useOrgMoney();
  const receiptRows = fundFlowReceiptRows(receipts);

  return (
    <div className="flex flex-col gap-6" data-testid="treasury-flows-panel">
      <p className="text-sm text-black/60 dark:text-white/60">
        When the sale ended, the money raised was split: part is set aside to
        back the token&apos;s price floor, and the rest is the project&apos;s
        money. You only need to act if you hold shares and want out (see Exit
        below). Each item below links to its record on the network.
      </p>
      {graduationQuery.error ? (
        <p
          className="text-sm text-black/60 dark:text-white/60"
          data-testid="fundflow-unavailable"
        >
          This sale does not use the standard payout step, so how the money was
          split cannot be shown:{" "}
          {graduationQuery.error instanceof Error
            ? graduationQuery.error.message
            : "the read failed"}
        </p>
      ) : graduationQuery.isFetching || !graduation ? (
        <p className="text-sm text-black/60 dark:text-white/60">
          Reading how the money was split…
        </p>
      ) : (
        <>
          <SplitSection
            amounts={amounts}
            chainId={chainId}
            state={graduation}
          />
          <ReceiptSection
            amounts={amounts}
            chainId={chainId}
            rows={receiptRows}
          />
          {positionsQuery.data ? (
            <PositionSection
              amounts={amounts}
              chainId={chainId}
              positions={positionsQuery.data}
            />
          ) : positionsQuery.error ? (
            <p className="text-sm text-red-700 dark:text-red-300">
              Could not read the live positions:{" "}
              {positionsQuery.error instanceof Error
                ? positionsQuery.error.message
                : "the request failed"}
            </p>
          ) : (
            <p className="text-sm text-black/60 dark:text-white/60">
              Reading live positions…
            </p>
          )}
        </>
      )}
      <section data-testid="fundflow-spend-ledger">
        <h4 className="text-sm font-semibold text-black dark:text-white">
          What has been spent (budgets and payments)
        </h4>
        {orgMoney.error ? (
          <p className="mt-1 text-sm text-red-700 dark:text-red-300">
            Could not read the budgets and payments from the server:{" "}
            {orgMoney.error instanceof Error
              ? orgMoney.error.message
              : "the request failed"}
          </p>
        ) : orgMoney.isFetching ? (
          <p className="mt-1 text-sm text-black/60 dark:text-white/60">
            Reading budgets and payments…
          </p>
        ) : orgMoney.data && orgMoney.data.budgets.length > 0 ? (
          <>
            <p className="mt-1 text-xs text-black/50 dark:text-white/50">
              Source: the budgets and payments published in this community,
              checked against the spending limit on the network. Current period:{" "}
              {budgetEpoch(
                "month",
                BigInt(Math.floor(Date.now() / 1000)),
              ).toString()}
              .
            </p>
            <ul className="mt-2 flex flex-col gap-2">
              {orgMoney.data.budgets.map((budget) => (
                <BudgetRow
                  amounts={amounts}
                  budget={budget}
                  chainId={chainId}
                  key={`${budget.author}-${budget.id}`}
                  spends={orgMoney.data?.spends ?? []}
                  token={currency}
                />
              ))}
            </ul>
          </>
        ) : (
          <p className="mt-1 text-sm text-black/60 dark:text-white/60">
            No budgets are published in this community yet, so only what the
            network records is shown. Budgets appear here once they are
            recorded.
          </p>
        )}
      </section>
    </div>
  );
}

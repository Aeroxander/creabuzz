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

import { getRpcEndpoint } from "../chain";
import type { LaunchReceipt, LaunchRecord } from "../models";
import {
  explorerAddressUrl,
  explorerTxUrl,
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
import { ETH_TOKEN } from "../lib/ragequit-tx";
import { useOrgMoney } from "../use-launches";

export interface TreasuryFlowsPanelProps {
  record: LaunchRecord;
  /** The launch's 47005 receipts (on `Launch`, not `LaunchRecord`). */
  receipts: LaunchReceipt[];
  chainId: number;
}

function amount(value: bigint): string {
  return value.toString();
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

function TxLink({ chainId, tx }: { chainId: number; tx: string }) {
  const url = explorerTxUrl(chainId, tx);
  return url ? (
    <a
      className="break-all text-sky-700 underline dark:text-sky-300"
      href={url}
      rel="noreferrer"
      target="_blank"
    >
      {truncatePubkey(tx)}
    </a>
  ) : (
    <span
      className="break-all text-black/60 dark:text-white/60"
      title="This chain has no known explorer — the raw hash is the source."
    >
      {truncatePubkey(tx)} (no explorer on this chain)
    </span>
  );
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
      {truncatePubkey(address)} (chain read — no explorer on this chain)
    </span>
  );
}

/** The money-story summary line + the split rows. */
function SplitSection({
  chainId,
  state,
}: {
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
        What happened to the money at graduation
      </h4>
      <p className="mt-1 text-sm text-black/70 dark:text-white/70">
        The raise swept to the executor and split onchain:{" "}
        <strong>{amount(state.record.currencyRaised)}</strong> raised →{" "}
        <strong>{amount(split.reserveShare)}</strong> held in reserve as the
        market&apos;s price floor (reserveBps {state.reserveBps.toString()}
        /10000) + <strong>{amount(split.treasuryShare)}</strong> to the
        treasury. Unsold launch tokens ({amount(state.record.unsoldTokens)})
        went to the treasury; sold tokens ({amount(state.record.tokensSold)})
        went to buyers.
      </p>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm text-black/80 dark:text-white/80">
        <dt>Reserve escrow (from the record)</dt>
        <dd className="text-right" data-testid="fundflow-reserve">
          {amount(state.record.reserveEscrow)}
        </dd>
        <dt>Treasury share (from the record)</dt>
        <dd className="text-right" data-testid="fundflow-treasury-share">
          {amount(state.record.treasuryShare)}
        </dd>
        <dt>Executed</dt>
        <dd className="text-right">
          {state.record.executed
            ? "yes — the split has happened"
            : "not yet — the split is pending"}
        </dd>
        <dt>Executor (source)</dt>
        <dd className="text-right">
          <AddrLink chainId={chainId} address={state.executor} />
        </dd>
        <dt>Treasury (source)</dt>
        <dd className="text-right">
          <AddrLink chainId={chainId} address={state.treasury} />
        </dd>
      </dl>
      {state.record.tokenMasterPool !== `0x${"0".repeat(40)}` ? (
        <p className="mt-1 text-xs text-black/50 dark:text-white/50">
          TM pool master:{" "}
          <AddrLink chainId={chainId} address={state.record.tokenMasterPool} />
        </p>
      ) : null}
    </section>
  );
}

/** The recorded 47005 money movements, each bound to its tx. */
function ReceiptSection({
  chainId,
  rows,
}: {
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
          No sweep / lock / summon / ragequit receipts are recorded for this
          launch yet — the deploy publishes them at graduation.
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
                ? `sweep — raised ${payloadText(row.payload, "currencyRaised")}, treasury share ${payloadText(row.payload, "treasuryShare")}, unsold ${payloadText(row.payload, "unsoldTokens")}`
                : row.table === "lock"
                  ? `lock — reserve escrow ${payloadText(row.payload, "reserveEscrow")} (the price-floor backing)`
                  : row.table === "summon"
                    ? "summon — the DAO was summoned for this launch"
                    : "ragequit — an owner burned shares and claimed treasury"}
            </span>
            <TxLink chainId={chainId} tx={row.tx} />
          </li>
        ))}
      </ul>
      <p className="mt-1 text-xs text-black/50 dark:text-white/50">
        Source: the launch&apos;s kind:47005 receipt mirrors (the deploy and
        exits publish them; the tx links are the chain record).
      </p>
    </section>
  );
}

/** Where the money sits right now (live balances). */
function PositionSection({
  chainId,
  currency,
  positions,
}: {
  chainId: number;
  currency: string;
  positions: Awaited<ReturnType<typeof fetchFundFlowPositions>>;
}) {
  const labels: Record<string, string> = {
    treasury: "Treasury holds",
    pool: "TM pool holds (price-floor backing)",
    escrow: "Executor still holds (unreleased reserve)",
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
            <span>
              {labels[row.label] ?? row.label}{" "}
              {currency === ETH_TOKEN ? "ETH" : truncatePubkey(currency)}
            </span>
            <span>
              <strong data-testid={`fundflow-position-${row.label}`}>
                {amount(row.balance)}
              </strong>{" "}
              · <AddrLink chainId={chainId} address={row.holder} />
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-1 text-xs text-black/50 dark:text-white/50">
        Live contract reads (balances of the linked addresses).
      </p>
    </section>
  );
}

/** One budget row: the window, the ceiling, and the live allowance state. */
function BudgetRow({
  budget,
  token,
  chainId,
  spends,
}: {
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
          budget {budget.id} — ceiling{" "}
          {budget.allocation ? amount(budget.allocation) : "—"} / {window}
          {budget.rollover ? " (rolls over)" : ""}
        </span>
        <span className="text-black/60 dark:text-white/60">
          subject {truncatePubkey(budget.subject)}
        </span>
      </div>
      {budget.onchain ? (
        allowanceQuery.error ? (
          <p className="mt-1 text-red-700 dark:text-red-300">
            Could not read the allowance —{" "}
            {allowanceQuery.error instanceof Error
              ? allowanceQuery.error.message
              : "the request failed"}
          </p>
        ) : allowanceQuery.data ? (
          <p className="mt-1">
            onchain: spent {amount(allowanceQuery.data.spent)} of{" "}
            {amount(allowanceQuery.data.allowance)} this {window} (epoch{" "}
            {allowanceQuery.data.epoch.toString()}), remaining{" "}
            {amount(allowanceQuery.data.remaining)}
            {allowanceQuery.data.spender ? (
              <>
                {" "}
                · spender{" "}
                <AddrLink
                  chainId={chainId}
                  address={allowanceQuery.data.spender}
                />
              </>
            ) : null}
          </p>
        ) : (
          <p className="mt-1 text-black/60 dark:text-white/60">
            Reading the allowance…
          </p>
        )
      ) : (
        <p className="mt-1 text-black/60 dark:text-white/60">
          No onchain allowance is bound to this budget — record-only ceiling.
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
                spend {amount(spend.amount)} by{" "}
                {spend.agent ? truncatePubkey(spend.agent) : "—"}
              </span>
              <TxLink chainId={chainId} tx={spend.txHash} />
            </li>
          ))}
          <li className="text-black/60 dark:text-white/60">
            recorded spend receipts total {amount(recorded)} (advisory mirror of
            the onchain ledger)
          </li>
        </ul>
      ) : (
        <p className="mt-1 text-black/60 dark:text-white/60">
          No spend receipts recorded against this budget yet.
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
        What is happening: the raise split at graduation, the reserve seeds the
        price floor, the treasury funds the project. Does it need you: only when
        you hold shares and want out (see Exit below). What to do about it:
        every movement below links the transaction or contract it came from.
      </p>
      {graduationQuery.error ? (
        <p
          className="text-sm text-black/60 dark:text-white/60"
          data-testid="fundflow-unavailable"
        >
          This launch is not on the GraduationExecutor rails (its funds
          recipient is not a GraduationExecutor), so the split cannot be read:{" "}
          {graduationQuery.error instanceof Error
            ? graduationQuery.error.message
            : "the read failed"}
        </p>
      ) : graduationQuery.isFetching || !graduation ? (
        <p className="text-sm text-black/60 dark:text-white/60">
          Reading the graduation split…
        </p>
      ) : (
        <>
          <SplitSection chainId={chainId} state={graduation} />
          <ReceiptSection chainId={chainId} rows={receiptRows} />
          {positionsQuery.data ? (
            <PositionSection
              chainId={chainId}
              currency={currency}
              positions={positionsQuery.data}
            />
          ) : positionsQuery.error ? (
            <p className="text-sm text-red-700 dark:text-red-300">
              Could not read the live positions —{" "}
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
          What has been spent (budgets &amp; spend ledger)
        </h4>
        {orgMoney.error ? (
          <p className="mt-1 text-sm text-red-700 dark:text-red-300">
            Could not read the budget plane from the relay —{" "}
            {orgMoney.error instanceof Error
              ? orgMoney.error.message
              : "the request failed"}
          </p>
        ) : orgMoney.isFetching ? (
          <p className="mt-1 text-sm text-black/60 dark:text-white/60">
            Reading budgets and spend receipts…
          </p>
        ) : orgMoney.data && orgMoney.data.budgets.length > 0 ? (
          <>
            <p className="mt-1 text-xs text-black/50 dark:text-white/50">
              Source: kind:37012 budgets + kind:37014 spend receipts from this
              community relay, cross-read against the OrgAllowance contract
              (kind 37012&apos;s <code>onchain</code> binding). Current epoch:{" "}
              {budgetEpoch(
                "month",
                BigInt(Math.floor(Date.now() / 1000)),
              ).toString()}
              .
            </p>
            <ul className="mt-2 flex flex-col gap-2">
              {orgMoney.data.budgets.map((budget) => (
                <BudgetRow
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
            No bound-org budget records (kind:37012) are published on this
            community relay, so the spend ledger shows onchain data only — the
            budget picture appears once budgets are recorded.
          </p>
        )}
      </section>
    </div>
  );
}

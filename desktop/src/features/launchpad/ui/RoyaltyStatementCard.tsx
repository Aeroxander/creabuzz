/**
 * Royalty statement card (design contract `docs/token-lifecycle-design.md`
 * §7 "UI (web + desktop)"): the contributor's view of the onchain royalty
 * ledger — credited balance + claim, accrual status (`h`, tier), schedule
 * rows with provenance, and the pending-push fallback note.
 *
 * Honesty copy is load-bearing, not decoration (D1/D2/D5): what you earn is
 * claimable forever, and selling your allocation only stops future royalties.
 *
 * Chain reads/writes follow the launchpad conventions: read-only `evm_call`
 * and the `claim()` send via `evm_send_transaction` (the `evm_*` Tauri IPC
 * contract documented in `mintHooks.ts`); a rejected invoke propagates into
 * query/mutation error state and is surfaced — never rendered as an empty
 * success. A mined `status: "reverted"` is data (nothing moved), not an
 * exception. All calldata, decoding, and display math live in
 * `lib/royalty.ts`.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { useEvmChainStatusQuery } from "@/features/launchpad/mintHooks";
import {
  accrualH,
  averageHeld,
  bandLabel,
  buildRoyaltyClaimCall,
  decodeAddressWord,
  decodeRoyaltyReqResult,
  decodeScheduleResult,
  encodeAllocOf,
  encodeBalanceOf,
  encodeBandOf,
  encodeClaimableOf,
  encodeCurrency,
  encodeDecimals,
  encodeOpenBal,
  encodeProjectToken,
  encodeRoyaltyReq,
  encodeSchedules,
  formatH,
  formatUnits,
  termCountdown,
  type AttestedRoyaltyReq,
  type RoyaltySchedule,
} from "@/features/launchpad/lib/royalty";
import {
  decodeUint256,
  getRpcEndpoint,
} from "@/features/launchpad/lib/chainRpc";
import { useWalletStatusQuery } from "@/features/launchpad/walletHooks";
import { invokeTauri } from "@/shared/api/tauri";
import { getCachedRelayOrigin } from "@/shared/lib/mediaUrl";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";

/** `evm_call()` result (the shared IPC shape in `mintHooks.ts`). */
interface EvmCallResult {
  returnData: string;
}

/** `evm_send_transaction` reply (the `MintTxReceipt` shape). */
interface RoyaltyTxReceipt {
  txHash: string;
  status: "success" | "reverted";
}

/** One schedule row: the minted schedule plus its attested provenance. */
export interface RoyaltyScheduleRow {
  /** The schedule key — the claim id of the contribution record (kind 37013). */
  id: string;
  schedule: RoyaltySchedule;
  attested: AttestedRoyaltyReq;
}

/** Everything the card displays, read from the ledger in one pass. */
export interface RoyaltyStatement {
  /** Credited, never-expiring balance (revenue currency, smallest units). */
  claimable: bigint;
  /** Σ earned token allocations (project token, smallest units). */
  allocation: bigint;
  /** Project-token balance at the last window close (trapezoid open). */
  openBalance: bigint;
  /** Live project-token balance (the trapezoid close of the running window). */
  tokenBalance: bigint;
  /** Highest badge tier across schedules (0 = none minted). */
  band: number;
  /** Display decimals of the revenue currency. */
  currencyDecimals: number;
  /** Display decimals of the project token. */
  tokenDecimals: number;
  rows: RoyaltyScheduleRow[];
}

/** Statement query key; the RPC endpoint is part of it so edits refetch. */
export function royaltyStatementQueryKey(
  rpcUrl: string,
  distributor: string,
  contributor: string,
) {
  return [
    "launchpad",
    "royalty",
    "statement",
    rpcUrl,
    distributor,
    contributor,
  ] as const;
}

const STATEMENT_STALE_TIME_MS = 30_000;

interface StatementFetchInput {
  rpcUrl: string;
  distributor: string;
  claimStake: string;
  contributor: string;
  scheduleIds: readonly string[];
}

async function fetchRoyaltyStatement(
  input: StatementFetchInput,
): Promise<RoyaltyStatement> {
  const call = (to: string, data: string): Promise<string> =>
    invokeTauri<EvmCallResult>("evm_call", {
      rpcUrl: input.rpcUrl,
      to,
      data,
    }).then((result) => result.returnData);
  const { distributor, claimStake, contributor } = input;
  const [
    currencyWord,
    tokenWord,
    claimableRaw,
    allocationRaw,
    openBalanceRaw,
    bandRaw,
  ] = await Promise.all([
    call(distributor, encodeCurrency()),
    call(distributor, encodeProjectToken()),
    call(distributor, encodeClaimableOf(contributor)),
    call(distributor, encodeAllocOf(contributor)),
    call(distributor, encodeOpenBal(contributor)),
    call(distributor, encodeBandOf(contributor)),
  ]);
  const currency = decodeAddressWord(currencyWord);
  const token = decodeAddressWord(tokenWord);
  const [currencyDecimalsRaw, tokenDecimalsRaw, tokenBalanceRaw] =
    await Promise.all([
      call(currency, encodeDecimals()),
      call(token, encodeDecimals()),
      call(token, encodeBalanceOf(contributor)),
    ]);
  const rows = await Promise.all(
    input.scheduleIds.map(async (id): Promise<RoyaltyScheduleRow> => {
      const [scheduleRaw, reqRaw] = await Promise.all([
        call(distributor, encodeSchedules(id)),
        call(claimStake, encodeRoyaltyReq(id)),
      ]);
      return {
        id,
        schedule: decodeScheduleResult(scheduleRaw),
        attested: decodeRoyaltyReqResult(reqRaw),
      };
    }),
  );
  return {
    claimable: decodeUint256(claimableRaw),
    allocation: decodeUint256(allocationRaw),
    openBalance: decodeUint256(openBalanceRaw),
    tokenBalance: decodeUint256(tokenBalanceRaw),
    band: Number(decodeUint256(bandRaw)),
    currencyDecimals: Number(decodeUint256(currencyDecimalsRaw)),
    tokenDecimals: Number(decodeUint256(tokenDecimalsRaw)),
    rows,
  };
}

function useRoyaltyStatementQuery(input: {
  rpcUrl: string;
  distributor: string;
  claimStake: string;
  contributor: string | null;
  scheduleIds: readonly string[];
}) {
  const contributor = input.contributor;
  return useQuery({
    queryKey: royaltyStatementQueryKey(
      input.rpcUrl,
      input.distributor,
      contributor ?? "",
    ),
    queryFn: () => {
      if (!contributor) throw new Error("no contributor address");
      return fetchRoyaltyStatement({
        rpcUrl: input.rpcUrl,
        distributor: input.distributor,
        claimStake: input.claimStake,
        contributor,
        scheduleIds: input.scheduleIds,
      });
    },
    enabled: contributor !== null,
    staleTime: STATEMENT_STALE_TIME_MS,
  });
}

/**
 * Compose and send `claim()` on the distributor through the wallet's
 * `evm_send_transaction` (the `walletHooks`/`mintHooks` mutation pattern).
 * A mined revert stays data: the statement refetches either way, and the
 * receipt's `status` is rendered from `data`.
 */
function useRoyaltyClaimMutation(input: {
  rpcUrl: string;
  chainId: number;
  distributor: string;
}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => {
      const call = buildRoyaltyClaimCall(input.distributor);
      return invokeTauri<RoyaltyTxReceipt>("evm_send_transaction", {
        rpcUrl: input.rpcUrl,
        chainId: input.chainId,
        to: call.to,
        data: call.data,
        value: call.value ?? "0x0",
      });
    },
    onSettled: () => {
      // Whether it landed or reverted, the onchain truth changed or will —
      // refetch rather than guessing from the receipt.
      void queryClient.invalidateQueries({
        queryKey: ["launchpad", "royalty", "statement"],
      });
    },
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Append an optional display symbol without inventing one. */
function withSymbol(amount: string, symbol: string | undefined): string {
  return symbol ? `${amount} ${symbol}` : amount;
}

export function RoyaltyStatementCard({
  distributor,
  claimStake,
  scheduleIds,
  currencySymbol,
  tokenSymbol,
}: {
  /** The launch's RoyaltyDistributor — the onchain royalty ledger. */
  distributor: string;
  /** The launch's ClaimStake — the attested provenance behind schedules. */
  claimStake: string;
  /** The contributor's schedule claim ids (bytes32 hex, from the record). */
  scheduleIds: readonly string[];
  /** Optional display symbol for the revenue currency. */
  currencySymbol?: string;
  /** Optional display symbol for the project token. */
  tokenSymbol?: string;
}) {
  const rpcUrl = React.useMemo(
    () => getRpcEndpoint(getCachedRelayOrigin()),
    [],
  );
  const walletQuery = useWalletStatusQuery();
  const wallet =
    walletQuery.data?.hasWallet && walletQuery.data.address
      ? walletQuery.data.address
      : null;
  const chainQuery = useEvmChainStatusQuery(rpcUrl, wallet !== null);
  const chainId = chainQuery.data?.chainId ?? 0;
  const statement = useRoyaltyStatementQuery({
    rpcUrl,
    distributor,
    claimStake,
    contributor: wallet,
    scheduleIds,
  });
  const claim = useRoyaltyClaimMutation({ rpcUrl, chainId, distributor });

  let gateMessage: React.ReactNode = null;
  if (walletQuery.isPending) {
    gateMessage = (
      <p className="mt-2 text-2xs text-muted-foreground" role="status">
        Checking wallet…
      </p>
    );
  } else if (walletQuery.isError) {
    gateMessage = (
      <p className="mt-2 text-2xs text-destructive" role="alert">
        Couldn&apos;t read wallet status:{" "}
        {errorText(walletQuery.error ?? "unknown error")}
      </p>
    );
  } else if (!wallet) {
    gateMessage = (
      <p className="mt-2 text-2xs text-muted-foreground">
        Create or import a wallet first — the statement reads the royalty ledger
        for the address this app signs with. The Wallet card has both.
      </p>
    );
  } else if (statement.isPending) {
    gateMessage = (
      <p className="mt-2 text-2xs text-muted-foreground" role="status">
        Reading the royalty ledger at {rpcUrl}…
      </p>
    );
  } else if (statement.isError) {
    gateMessage = (
      <p className="mt-2 text-2xs text-destructive" role="alert">
        Couldn&apos;t read the royalty ledger: {errorText(statement.error)}.
        Check the RPC endpoint, then try again.
      </p>
    );
  }

  const data = statement.data;
  const claimBusy = claim.isPending;
  const claimable = data ? data.claimable : 0n;
  const claimDisabled = claimBusy || chainId === 0 || claimable === 0n;

  return (
    <section
      aria-labelledby="royalty-statement-heading"
      className="rounded-2xl border border-border/70 bg-card/60 px-4 py-3"
      data-testid="royalty-statement-card"
    >
      <h3 id="royalty-statement-heading" className="text-sm font-semibold">
        Royalty statement
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Your share of this project&apos;s revenue, settled onchain. Credited
        balances never expire and cannot be taken back.
      </p>
      {gateMessage}
      {data ? (
        <div className="mt-2 grid max-w-3xl grid-cols-1 gap-3">
          <section className="rounded-xl border border-border/60 px-3 py-2">
            <h4 className="text-sm font-semibold">Credited balance</h4>
            <p className="mt-1 text-lg font-semibold tabular-nums">
              {withSymbol(
                formatUnits(data.claimable, data.currencyDecimals),
                currencySymbol,
              )}
            </p>
            <p className="mt-1 text-2xs text-muted-foreground">
              Claimable forever — pull it whenever, no deadline, no clawback.
              Settlement pushes your credit to your address automatically at
              each close; anything sitting here is a push that didn&apos;t
              complete.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <Button
                aria-busy={claimBusy}
                data-testid="royalty-claim-button"
                disabled={claimDisabled}
                onClick={() => claim.mutate()}
                size="sm"
                type="button"
                variant="outline"
              >
                Claim
              </Button>
              {claim.isPending ? (
                <p className="text-2xs text-muted-foreground" role="status">
                  Sending the claim transaction…
                </p>
              ) : null}
            </div>
            {claim.isError ? (
              <p className="mt-1 text-2xs text-destructive" role="alert">
                Couldn&apos;t send the claim: {errorText(claim.error)}. Your
                balance is untouched and stays claimable.
              </p>
            ) : null}
            {claim.data ? (
              claim.data.status === "reverted" ? (
                <p className="mt-1 text-2xs text-destructive" role="alert">
                  The claim reverted onchain — nothing moved, and your balance
                  is still claimable. Transaction{" "}
                  {truncatePubkey(claim.data.txHash)}.
                </p>
              ) : (
                <p
                  className="mt-1 text-2xs text-muted-foreground"
                  role="status"
                >
                  Claimed. Transaction {truncatePubkey(claim.data.txHash)}{" "}
                  confirmed.
                </p>
              )
            ) : null}
          </section>
          <section className="rounded-xl border border-border/60 px-3 py-2">
            <h4 className="text-sm font-semibold">Accrual status</h4>
            <p className="mt-1 text-lg font-semibold tabular-nums">
              h ={" "}
              {formatH(
                accrualH(data.openBalance, data.tokenBalance, data.allocation),
              )}{" "}
              · {bandLabel(data.band)}
            </p>
            <p className="mt-1 text-2xs text-muted-foreground">
              Held (average of last close and now):{" "}
              {withSymbol(
                formatUnits(
                  averageHeld(data.openBalance, data.tokenBalance),
                  data.tokenDecimals,
                ),
                tokenSymbol,
              )}{" "}
              · Earned allocation:{" "}
              {withSymbol(
                formatUnits(data.allocation, data.tokenDecimals),
                tokenSymbol,
              )}
            </p>
            <p className="mt-1 text-2xs text-muted-foreground">
              Royalties scale with the allocation you hold: h is that held share
              (sampled each monthly close), and your tier is the highest badge
              across your schedules. Holding what you earned pays the full
              stream — work is never paywalled.
            </p>
          </section>
          <section className="rounded-xl border border-border/60 px-3 py-2">
            <h4 className="text-sm font-semibold">Royalty schedules</h4>
            {data.rows.length === 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">
                No royalty schedules yet. A schedule is minted when your
                contribution claim passes review — weight, term, and tier come
                from that attested claim.
              </p>
            ) : (
              <ul
                aria-label="Royalty schedules"
                className="mt-2 flex flex-col gap-2"
              >
                {data.rows.map((row) => {
                  const countdown = termCountdown(
                    row.schedule.end,
                    Math.floor(Date.now() / 1000),
                  );
                  return (
                    <li
                      className="rounded-xl border border-border/60 px-3 py-2"
                      key={row.id}
                    >
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                        <span className="font-medium">
                          {row.schedule.weight}× weight
                        </span>
                        <span className="rounded-full border border-border/70 px-2 py-0.5 text-2xs">
                          {bandLabel(row.schedule.band)}
                        </span>
                        <span
                          className="tabular-nums text-2xs text-muted-foreground"
                          title={new Date(
                            Number(row.schedule.end) * 1000,
                          ).toLocaleDateString()}
                        >
                          {countdown.label}
                        </span>
                        {row.schedule.suspended ? (
                          <span className="text-2xs text-destructive">
                            Suspended — future accrual stopped. What you already
                            earned is never touched.
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 text-2xs text-muted-foreground">
                        Provenance: contribution record 37013 for claim{" "}
                        {truncatePubkey(row.id)} — attested{" "}
                        {bandLabel(row.attested.band)}, {row.attested.weight}×
                        weight, {Math.round(Number(row.attested.term) / 86400)}
                        -day term, minted verbatim into this schedule.
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          <p className="text-2xs text-muted-foreground">
            Selling your allocation stops future royalties. What you already
            earned is never touched — it stays claimable forever.
          </p>
        </div>
      ) : null}
    </section>
  );
}

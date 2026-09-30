/**
 * Royalty statement card (design contract `docs/token-lifecycle-design.md`
 * §7 "UI (web + desktop)"): the contributor's view of the onchain royalty
 * ledger — credited balance + claim, accrual status (`h`, tier), schedule
 * rows with provenance, and the pending-push fallback note.
 *
 * Honesty copy is load-bearing, not decoration (D1/D2/D5): what you earn is
 * claimable forever, and selling your allocation only stops future royalties.
 *
 * Web chain conventions: reads are `eth_call`s over the `../chain.ts` seam
 * inside one `useQuery` pass; `claim()` is composed in `lib/royalty.ts` and
 * sent through the launchpad sender picker (`ui/SenderPicker.tsx` — the
 * `MyBidsPanel`/`RagequitPanel` wallet hook pattern), sender-agnostic
 * calldata. A failed read surfaces its error — never an empty success — and a
 * sent claim refetches the ledger rather than guessing from the hash.
 * Schedule ids arrive as a prop: the ABI has no per-contributor enumeration.
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";

import { truncatePubkey } from "@/shared/lib/pubkey";
import { KIND_CONTRIBUTION_RECORD } from "@/shared/constants/kinds";
import { Button } from "@/shared/ui/button";

import { decodeU256, ethCall, getRpcEndpoint } from "../chain";
import { TX_HASH_RE } from "../lib/milestone-receipt";
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
} from "../lib/royalty";
import {
  resolveSender,
  SenderPickerControls,
  senderErrorMessage,
  useSenderPicker,
} from "./SenderPicker";

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
  endpoint: string;
  distributor: string;
  claimStake: string;
  contributor: string;
  scheduleIds: readonly string[];
}

/** Read the ledger in one pass: balances, tier, then each schedule + request. */
async function fetchRoyaltyStatement(
  input: StatementFetchInput,
): Promise<RoyaltyStatement> {
  const call = (to: string, data: string) => ethCall(input.endpoint, to, data);
  const { distributor, claimStake, contributor } = input;
  const [
    currencyRaw,
    tokenRaw,
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
  const currency = decodeAddressWord(currencyRaw);
  const token = decodeAddressWord(tokenRaw);
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
    claimable: decodeU256(claimableRaw),
    allocation: decodeU256(allocationRaw),
    openBalance: decodeU256(openBalanceRaw),
    tokenBalance: decodeU256(tokenBalanceRaw),
    band: Number(decodeU256(bandRaw)),
    currencyDecimals: Number(decodeU256(currencyDecimalsRaw)),
    tokenDecimals: Number(decodeU256(tokenDecimalsRaw)),
    rows,
  };
}

/** The connected injected-wallet account, or null (never prompts). */
async function discoverWallet(): Promise<string | null> {
  const ethereum = (
    window as unknown as {
      ethereum?: {
        request(args: { method: string; params?: unknown[] }): Promise<unknown>;
      };
    }
  ).ethereum;
  if (!ethereum) return null;
  try {
    const accounts = (await ethereum.request({
      method: "eth_accounts",
    })) as string[];
    return accounts?.[0] ?? null;
  } catch {
    return null;
  }
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
  const picker = useSenderPicker();
  const [walletAccount, setWalletAccount] = useState<string | null>(null);
  const [walletChecked, setWalletChecked] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claimTx, setClaimTx] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    discoverWallet().then((address) => {
      if (!alive) return;
      setWalletAccount(address);
      setWalletChecked(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  // The statement is the SELECTED account's: switching wallet ↔ passkey
  // re-reads whose royalties these are (the RagequitPanel stance).
  const holder =
    picker.kind === "passkey" ? picker.passkeyAccount : walletAccount;

  const statement = useQuery({
    queryKey: royaltyStatementQueryKey(
      getRpcEndpoint(),
      distributor,
      holder ?? "",
    ),
    queryFn: () => {
      if (!holder) throw new Error("no contributor address");
      return fetchRoyaltyStatement({
        endpoint: getRpcEndpoint(),
        distributor,
        claimStake,
        contributor: holder,
        scheduleIds,
      });
    },
    enabled: holder !== null,
    staleTime: STATEMENT_STALE_TIME_MS,
    refetchOnWindowFocus: false,
  });

  /**
   * Compose and send `claim()` through the resolved sender (wallet or
   * passkey). The calldata is sender-agnostic; whatever lands, the ledger is
   * refetched rather than the UI guessing the new balance from the hash.
   */
  const sendClaim = async () => {
    if (!holder || claiming) return;
    setClaiming(true);
    setClaimError(null);
    setClaimTx(null);
    try {
      const sender = resolveSender(picker);
      const call = buildRoyaltyClaimCall(distributor);
      const result = await sender.sendCalls([call]);
      if (!TX_HASH_RE.test(result.txHash)) {
        throw new Error("The sender returned an invalid hash.");
      }
      setClaimTx(result.txHash);
      void statement.refetch();
    } catch (err) {
      setClaimError(senderErrorMessage(err, "The claim was not sent."));
    } finally {
      setClaiming(false);
    }
  };

  let gateMessage: ReactNode = null;
  if (picker.kind === "wallet" && !walletChecked) {
    gateMessage = (
      <p
        className="mt-2 text-xs text-black/60 dark:text-white/60"
        role="status"
      >
        Checking for a connected wallet…
      </p>
    );
  } else if (!holder) {
    gateMessage = (
      <p className="mt-2 text-xs text-black/60 dark:text-white/60">
        {picker.kind === "passkey" && picker.passkeyNote
          ? picker.passkeyNote
          : "No account found to read. Connect an injected wallet or switch to the passkey account above — the statement reads the royalty ledger for the selected account."}
      </p>
    );
  } else if (statement.isPending) {
    gateMessage = (
      <p
        className="mt-2 text-xs text-black/60 dark:text-white/60"
        role="status"
      >
        Reading the royalty ledger at {getRpcEndpoint()}…
      </p>
    );
  } else if (statement.isError) {
    gateMessage = (
      <p className="mt-2 text-xs text-red-700 dark:text-red-300" role="alert">
        Couldn&apos;t read the royalty ledger: {errorText(statement.error)}.
        Check the RPC endpoint, then try again.
      </p>
    );
  }

  const data = statement.data;
  const claimable = data ? data.claimable : 0n;
  const claimDisabled = claiming || holder === null || claimable === 0n;

  return (
    <section
      aria-labelledby="royalty-statement-heading"
      className="rounded-2xl border border-black/10 p-4 dark:border-white/10"
      data-testid="royalty-statement-card"
    >
      <h2
        className="text-lg font-semibold text-black dark:text-white"
        id="royalty-statement-heading"
      >
        Royalty statement
      </h2>
      <p className="mt-1 text-sm text-black/60 dark:text-white/60">
        Your share of this project&apos;s revenue, settled onchain. Credited
        balances never expire and cannot be taken back.
      </p>
      {/* The picker sits here because the statement is the SELECTED account's. */}
      <SenderPickerControls state={picker} testIdPrefix="royalty-" />
      {gateMessage}
      {data ? (
        <div className="mt-2 grid max-w-3xl grid-cols-1 gap-3">
          <div className="rounded-xl border border-black/10 px-3 py-2 dark:border-white/10">
            <h3 className="text-sm font-semibold text-black dark:text-white">
              Credited balance
            </h3>
            <p
              className="mt-1 text-lg font-semibold tabular-nums text-black dark:text-white"
              data-testid="royalty-claimable"
            >
              {withSymbol(
                formatUnits(data.claimable, data.currencyDecimals),
                currencySymbol,
              )}
            </p>
            <p className="mt-1 text-xs text-black/60 dark:text-white/60">
              Claimable forever — pull it whenever, no deadline, no clawback.
              Settlement pushes your credit to your address automatically at
              each close; anything sitting here is a push that didn&apos;t
              complete.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <Button
                aria-busy={claiming}
                data-testid="royalty-claim-button"
                disabled={claimDisabled}
                onClick={() => void sendClaim()}
                size="sm"
                type="button"
                variant="outline"
              >
                Claim
              </Button>
              {claiming ? (
                <p
                  className="text-xs text-black/60 dark:text-white/60"
                  role="status"
                >
                  Sending the claim transaction…
                </p>
              ) : null}
            </div>
            {claimError ? (
              <p
                className="mt-1 text-xs text-red-700 dark:text-red-300"
                role="alert"
              >
                Couldn&apos;t send the claim: {claimError} Your balance is
                untouched and stays claimable.
              </p>
            ) : null}
            {claimTx ? (
              <p
                className="mt-1 text-xs text-black/60 dark:text-white/60"
                role="status"
              >
                Claim transaction sent — {truncatePubkey(claimTx)}. The balance
                above refreshes once it lands.
              </p>
            ) : null}
          </div>
          <div className="rounded-xl border border-black/10 px-3 py-2 dark:border-white/10">
            <h3 className="text-sm font-semibold text-black dark:text-white">
              Accrual status
            </h3>
            <p
              className="mt-1 text-lg font-semibold tabular-nums text-black dark:text-white"
              data-testid="royalty-accrual-status"
            >
              h ={" "}
              {formatH(
                accrualH(data.openBalance, data.tokenBalance, data.allocation),
              )}{" "}
              · {bandLabel(data.band)}
            </p>
            <p className="mt-1 text-xs text-black/60 dark:text-white/60">
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
            <p className="mt-1 text-xs text-black/60 dark:text-white/60">
              Royalties scale with the allocation you hold: h is that held share
              (sampled each monthly close), and your tier is the highest badge
              across your schedules. Holding what you earned pays the full
              stream — work is never paywalled.
            </p>
          </div>
          <div className="rounded-xl border border-black/10 px-3 py-2 dark:border-white/10">
            <h3
              className="text-sm font-semibold text-black dark:text-white"
              id="royalty-schedules-heading"
            >
              Royalty schedules
            </h3>
            {data.rows.length === 0 ? (
              <p className="mt-1 text-sm text-black/60 dark:text-white/60">
                No royalty schedules yet. A schedule is minted when your
                contribution claim passes review — weight, term, and tier come
                from that attested claim.
              </p>
            ) : (
              <ul
                aria-labelledby="royalty-schedules-heading"
                className="mt-2 flex flex-col gap-2"
              >
                {data.rows.map((row) => {
                  const countdown = termCountdown(
                    row.schedule.end,
                    Math.floor(Date.now() / 1000),
                  );
                  return (
                    <li
                      className="rounded-xl border border-black/10 px-3 py-2 dark:border-white/10"
                      key={row.id}
                    >
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-black dark:text-white">
                        <span className="font-medium">
                          {row.schedule.weight}× weight
                        </span>
                        <span className="rounded-full border border-black/15 px-2 py-0.5 text-xs text-black/60 dark:border-white/15 dark:text-white/60">
                          {bandLabel(row.schedule.band)}
                        </span>
                        <span
                          className="tabular-nums text-xs text-black/60 dark:text-white/60"
                          title={new Date(
                            Number(row.schedule.end) * 1000,
                          ).toLocaleDateString()}
                        >
                          {countdown.label}
                        </span>
                        {row.schedule.suspended ? (
                          <span className="text-xs text-red-700 dark:text-red-300">
                            Suspended — future accrual stopped. What you already
                            earned is never touched.
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 text-xs text-black/60 dark:text-white/60">
                        Provenance: contribution record{" "}
                        {KIND_CONTRIBUTION_RECORD} for claim{" "}
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
          </div>
          <p className="text-xs text-black/60 dark:text-white/60">
            Selling your allocation stops future royalties. What you already
            earned is never touched — it stays claimable forever.
          </p>
        </div>
      ) : null}
    </section>
  );
}

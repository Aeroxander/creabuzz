/**
 * The web exit surface for a bound org / graduated launch: the connected
 * account's claimable position in the DAO, and the "Exit and claim" action
 * (majeur ragequit) through the sender picker.
 *
 * Why this exists (docs/paperclip-parity-status.md:33, gap #3): the onchain
 * exit is real — `Moloch.sol:759 ragequit(address[],uint256,uint256)` burns
 * shares and pays the proportional treasury claim — but before this panel it
 * had no UI and users had to `cast call`. Everything below is the money plane
 * on web, passkey-first:
 *
 * - the position is a token read (`lib/ragequit-position.ts` — shares/loot
 *   are ERC-20-ish tokens, balanceOf/totalSupply; not 37011 events);
 * - the exit composes one call for every sender (`lib/ragequit-tx.ts`,
 *   `cast`-golden bound) and runs the established step machine
 *   (`lib/ragequit-flow.ts`): failures name their step, a mirror failure never
 *   re-sends the burn;
 * - no hash pasting anywhere: the tx is composed, sent, and its receipt
 *   mirrors into the NIP-LP vocabulary's own `ragequit` word (kind:47005,
 *   NIP-LP.md:159) with the tx hash the flow already holds;
 * - a mined revert is a failed step with data, never a silent success.
 *
 * The UX stance (docs/paperclip-ux-reference.md:21-22): every state answers
 * what is happening / does it need me / what do I do about it.
 */
import { useId, useReducer, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/shared/ui/button";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { KIND_LAUNCH_RECEIPT } from "@/shared/constants/kinds";
import { toast } from "sonner";

import { ethCall, getRpcEndpoint, recordSaleCurrency } from "../chain";
import type { LaunchRecord } from "../models";
import {
  buildRagequitPlan,
  confirmedRagequitDeps,
  exitRetry,
  type ExitCheck,
  firstExit,
  initialRagequitFlowState,
  onExitLanded,
  type RagequitResume,
  ragequitFlowReducer,
  RAGEQUIT_STEP_LABELS,
  runRagequitFlow,
  sentTxHash,
} from "../lib/ragequit-flow";
import type { FlowReceipt } from "../lib/exit-flow";
import { buildRagequitTx, ETH_TOKEN } from "../lib/ragequit-tx";
import { feePercent } from "../lib/funding-terms";
import {
  exitDenominator,
  exitPaysNothing,
  fetchRagequitPosition,
  fetchTokenInfo,
  overdrawsPosition,
  type RagequitPosition,
} from "../lib/ragequit-position";
import {
  decodeCurrencyAnswer,
  exitTokensFor,
  formatTokenAmount,
  type TokenInfo,
} from "../lib/exit-tokens";
import { formatShares } from "../lib/shares-format";
import type { DaoBinding } from "../lib/org-money";
import { usePublishMirror } from "../use-launches";
import { ACCOUNT_MONEY_QUERY } from "../use-account-money";
import { usePickedSend } from "../use-picked-send";
import { Modal } from "./Modal";
import {
  SenderPickerControls,
  senderErrorMessage,
  useSenderPicker,
} from "./SenderPicker";
import { useConnectedWallet } from "../use-connected-wallet";

const SELECTOR_CURRENCY = "0xe5a6b10f"; // currency() — cast sig golden (fund-flow.ts)

/** The page's read of one holder's position: the panel shows it, and the dialog puts a fresh chain read in its place. */
function ragequitPositionKey(
  dao: string | undefined,
  holder: string | null | undefined,
  tokens: string[] | null,
) {
  return [
    "ragequit-position",
    dao,
    holder,
    tokens?.join(",") ?? null,
    getRpcEndpoint(),
  ] as const;
}

export interface RagequitPanelProps {
  record: LaunchRecord;
  chainId: number;
  /** When null the panel renders the honest "no DAO bound" state. */
  daoBinding: DaoBinding | null;
  /** On a contributor project, leave as the account the rest of the page acts as (D139). */
  followActingAccount?: boolean;
}

/** One claimable pool row: what the exit pays, and from which balance. */
function ClaimRow({
  pool,
  due,
  info,
}: {
  pool: bigint;
  due: bigint;
  info: TokenInfo;
}) {
  return (
    <li className="flex items-center justify-between gap-2 text-sm text-black/80 dark:text-white/80">
      <span className="text-black/60 dark:text-white/60">
        The treasury holds {formatTokenAmount(pool, info)}
      </span>
      <span className="font-medium" data-testid="ragequit-claim-row">
        You get {formatTokenAmount(due, info)}
      </span>
    </li>
  );
}

export function RagequitPanel({
  record,
  chainId,
  daoBinding,
  followActingAccount = false,
}: RagequitPanelProps) {
  const picker = useSenderPicker({ followActingAccount });
  const { address: walletAccount } = useConnectedWallet();
  const [dialogOpen, setDialogOpen] = useState(false);

  // The exit runs from whichever account the picker is on: the injected
  // wallet or the passkey's smart account (tokens settle there).
  const holder =
    picker.kind === "passkey" ? picker.passkeyAccount : walletAccount;

  // The DAO's pools to claim: ETH plus the auction's raise currency when one
  // exists. Tokens outside this list are NOT claimed by this action (stated
  // in the dialog) — a custom-token exit is deferred. The exit burns the holder's
  // Shares once and pays only what it names, so the sale's currency must be READ
  // before any exit is offered: while it loads, fails or comes back garbled there
  // is no token list at all (never a quiet ETH-only one).
  const currencyQuery = useQuery({
    queryKey: ["ragequit-currency", record.auction, getRpcEndpoint()],
    enabled: Boolean(record.auction),
    queryFn: async () =>
      decodeCurrencyAnswer(
        await ethCall(
          getRpcEndpoint(),
          record.auction as string,
          SELECTOR_CURRENCY,
        ),
      ),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const saleCurrency = recordSaleCurrency(record);
  const exit = exitTokensFor({
    hasAuction: Boolean(record.auction),
    recordCurrency: saleCurrency.kind === "eth" ? null : saleCurrency.value,
    currency: currencyQuery.isSuccess
      ? { state: "success", address: currencyQuery.data }
      : currencyQuery.isError
        ? {
            state: "error",
            message:
              currencyQuery.error instanceof Error
                ? currencyQuery.error.message
                : "The sale's currency could not be read.",
          }
        : { state: "pending" },
  });
  const tokens = exit.status === "ready" ? exit.tokens : null;
  // The exit currency's own name and decimals (ETH needs no read). It is the token the exit will pay, wherever its address
  // came from: the sale contract's answer, or the launch record when there is no sale contract.
  const exitToken = tokens?.find((t) => t !== ETH_TOKEN) ?? null;
  const infoWanted = exitToken !== null;
  const currencyInfoQuery = useQuery({
    queryKey: ["ragequit-token-info", exitToken, getRpcEndpoint()],
    enabled: infoWanted,
    queryFn: () => fetchTokenInfo(getRpcEndpoint(), exitToken as string),
    staleTime: 300_000,
    refetchOnWindowFocus: false,
  });
  // How each token in the exit is named and counted. A token that did not say is shown in raw units, never at a guessed scale.
  const infoOf = (token: string): TokenInfo =>
    token === ETH_TOKEN
      ? { symbol: "ETH", decimals: 18 }
      : (currencyInfoQuery.data ?? { symbol: null, decimals: null });

  const positionQuery = useQuery({
    queryKey: ragequitPositionKey(daoBinding?.dao, holder, tokens),
    enabled: Boolean(daoBinding && holder && tokens),
    queryFn: () =>
      fetchRagequitPosition(
        getRpcEndpoint(),
        daoBinding?.dao as string,
        holder as string,
        tokens as string[],
      ),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });

  if (!daoBinding) {
    return (
      <section
        className="rounded-2xl border border-black/10 p-4 dark:border-white/10"
        data-testid="ragequit-panel"
      >
        <h3 className="text-base font-semibold text-black dark:text-white">
          Leave and take your share
        </h3>
        <p className="mt-2 text-sm text-black/60 dark:text-white/60">
          There is no DAO for this project yet, so there is nothing to leave.
          This opens once the sale ends and the DAO starts.
        </p>
      </section>
    );
  }

  return (
    <section
      className="rounded-2xl border border-black/10 p-4 dark:border-white/10"
      data-testid="ragequit-panel"
    >
      <h3 className="text-base font-semibold text-black dark:text-white">
        Leave and take your share
      </h3>
      <p className="mt-1 text-sm text-black/60 dark:text-white/60">
        Your Shares are a claim on what the treasury holds. If you want out, you
        can give them up and take your part of it. Shares the DAO keeps for
        itself do not count, so they never shrink what you get. Leaving pays
        your part of what the treasury holds now; it does not protect your share
        of the project itself.{" "}
        <span className="text-muted-foreground">
          DAO {truncatePubkey(daoBinding.dao)}.
        </span>
      </p>
      {/* The picker sits here because the position is the SELECTED account's:
          switching wallet ↔ passkey re-reads who is exiting. */}
      <SenderPickerControls
        legend="Act as"
        state={picker}
        testIdPrefix="ragequit-"
      />
      {holder && exit.status === "reading" ? (
        <p className="mt-2 text-sm text-black/60 dark:text-white/60">
          Checking what currency this project was funded in…
        </p>
      ) : holder && exit.status === "failed" ? (
        <div data-testid="ragequit-currency-failed">
          <p className="mt-2 text-sm text-red-700 dark:text-red-300">
            {exit.message}
          </p>
          <Button
            className="mt-2"
            data-testid="ragequit-currency-retry"
            onClick={() => void currencyQuery.refetch()}
            size="sm"
            variant="outline"
          >
            Try again
          </Button>
        </div>
      ) : holder ? (
        <PositionBody
          infoOf={infoOf}
          position={positionQuery.data ?? null}
          loading={
            positionQuery.isFetching ||
            (infoWanted && currencyInfoQuery.isPending)
          }
          error={
            positionQuery.error instanceof Error
              ? positionQuery.error.message
              : null
          }
          onExit={() => setDialogOpen(true)}
        />
      ) : (
        <p className="mt-2 text-sm text-black/60 dark:text-white/60">
          Choose an account above to see what it could take.
        </p>
      )}
      {dialogOpen && daoBinding && tokens ? (
        <RagequitDialog
          record={record}
          chainId={chainId}
          dao={daoBinding.dao}
          tokens={tokens}
          infoOf={infoOf}
          holder={holder ?? null}
          position={positionQuery.data ?? null}
          picker={picker}
          followActingAccount={followActingAccount}
          onClose={() => setDialogOpen(false)}
        />
      ) : null}
    </section>
  );
}

function PositionBody({
  infoOf,
  position,
  loading,
  error,
  onExit,
}: {
  infoOf: (token: string) => TokenInfo;
  position: RagequitPosition | null;
  loading: boolean;
  error: string | null;
  onExit: () => void;
}) {
  if (error) {
    return (
      <p
        className="mt-2 text-sm text-red-700 dark:text-red-300"
        data-testid="ragequit-error"
      >
        Could not read what you could take back: {error}
      </p>
    );
  }
  if (!position || loading) {
    return (
      <p className="mt-2 text-sm text-black/60 dark:text-white/60">
        Reading what you could take back…
      </p>
    );
  }
  if (position.zeroSupply) {
    return (
      <p className="mt-2 text-sm text-black/60 dark:text-white/60">
        Nobody outside the DAO holds shares yet, so there is nothing to take
        back.
      </p>
    );
  }
  if (!position.ragequittable) {
    return (
      <p
        className="mt-2 text-sm text-amber-800 dark:text-amber-200"
        data-testid="ragequit-locked"
      >
        This DAO is not letting members leave right now, so there is nothing you
        need to do.
      </p>
    );
  }
  if (position.sharesBalance === 0n) {
    return (
      <p className="mt-2 text-sm text-black/60 dark:text-white/60">
        This account holds no shares, so there is nothing to leave with.
      </p>
    );
  }
  if (position.exitRule === "unknown") {
    return (
      <p
        className="mt-2 text-sm text-amber-800 dark:text-amber-200"
        data-testid="ragequit-unknown"
      >
        This app can&apos;t tell what leaving would pay. This DAO&apos;s exit
        asks its milestone lock how many Shares are still locked, and the lock
        is older than the DAO and cannot answer, so the chain would refuse the
        exit. Your Shares are unchanged.
      </p>
    );
  }
  if (position.sharesBurnable === 0n) {
    return (
      <p
        className="mt-2 text-sm text-amber-800 dark:text-amber-200"
        data-testid="ragequit-all-locked"
      >
        All {formatShares(position.sharesBalance)} of your shares are still
        locked until the project reaches its milestones, so none can be given up
        yet.
      </p>
    );
  }
  // A token the treasury holds none of is not worth a line.
  const payable = position.rows.filter((row) => row.pool > 0n);
  const paysNothing = exitPaysNothing(position.rows);
  return (
    <>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm text-black/80 dark:text-white/80">
        <dt>Shares you would give up</dt>
        <dd className="text-right font-medium" data-testid="ragequit-shares">
          {formatShares(position.sharesBurnable)}
        </dd>
        {position.sharesLocked > 0n ? (
          <>
            <dt>Shares still locked (kept)</dt>
            <dd className="text-right" data-testid="ragequit-locked-shares">
              {formatShares(position.sharesLocked)}
            </dd>
          </>
        ) : null}
        {position.lootBalance > 0n ? (
          <>
            <dt>Non-voting shares (kept)</dt>
            <dd className="text-right">{formatShares(position.lootBalance)}</dd>
          </>
        ) : null}
        <dt>
          {position.exitRule === "legacy"
            ? "Shares the treasury is shared among"
            : "Shares that can leave now"}
        </dt>
        <dd className="text-right">
          {formatShares(
            exitDenominator({
              sharesToBurn: 0n,
              lootToBurn: 0n,
              sharesBalance: position.sharesBalance,
              lootBalance: position.lootBalance,
              sharesTotal: position.sharesTotal,
              lootTotal: position.lootTotal,
              daoHeld: position.daoHeld,
              lockedTotal: position.lockedTotal,
              pools: [],
            }),
          )}
        </dd>
      </dl>
      {position.feeApplies ? (
        <p
          className="mt-2 text-sm text-black/60 dark:text-white/60"
          data-testid="ragequit-exit-fee"
        >
          This project&apos;s funding terms set an exit fee of{" "}
          {feePercent(Number(position.exitFeeBps))}: that part of your share
          stays in the treasury, for those who stay. The amounts below are what
          you get after it.
        </p>
      ) : null}
      {position.exitRule === "legacy" ? (
        <p
          className="mt-2 text-sm text-black/60 dark:text-white/60"
          data-testid="ragequit-legacy"
        >
          This DAO was made before Shares still locked behind milestones were
          left out of an exit, so its exit still counts them: your part is
          worked out over every Share outside the DAO, locked ones included.
        </p>
      ) : null}
      <p className="mt-3 text-sm font-medium text-black dark:text-white">
        What you would take back now:
      </p>
      <ul className="mt-1 flex flex-col gap-1">
        {payable.length === 0 ? (
          <li className="text-sm text-black/60 dark:text-white/60">
            The treasury holds nothing to take back right now.
          </li>
        ) : null}
        {payable.map((row) => (
          <ClaimRow
            due={row.due}
            info={infoOf(row.token)}
            key={row.token}
            pool={row.pool}
          />
        ))}
      </ul>
      {paysNothing ? (
        <p
          className="mt-2 text-sm text-amber-800 dark:text-amber-200"
          data-testid="ragequit-pays-nothing"
        >
          Leaving now pays you nothing, and your{" "}
          {formatShares(position.sharesBurnable)} Shares would be destroyed.
        </p>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          This is worked out from the treasury as it is now. The exact amount is
          fixed when the exit goes through.
        </p>
      )}
      <Button
        className="mt-3"
        data-testid="ragequit-exit"
        onClick={onExit}
        variant={paysNothing ? "outline" : "default"}
      >
        {paysNothing ? "Leave anyway" : "Leave and take my share"}
      </Button>
    </>
  );
}

function RagequitDialog({
  record,
  chainId,
  dao,
  tokens,
  infoOf,
  holder,
  position,
  picker,
  followActingAccount,
  onClose,
}: {
  record: LaunchRecord;
  chainId: number;
  dao: string;
  tokens: string[];
  infoOf: (token: string) => TokenInfo;
  holder: string | null;
  position: RagequitPosition | null;
  picker: ReturnType<typeof useSenderPicker>;
  followActingAccount: boolean;
  onClose: () => void;
}) {
  const [state, dispatch] = useReducer(
    ragequitFlowReducer,
    undefined,
    initialRagequitFlowState,
  );
  const [running, setRunning] = useState(false);
  const [understood, setUnderstood] = useState(false);
  // Said when what can leave changed between the page's read and the send, so nothing was sent (D145).
  const [recheck, setRecheck] = useState<string | null>(null);
  // The Shares the last exit sent asked to burn, and the holder's Shares just before: a retry reads the position again
  // and compares, so an exit whose confirmation timed out is never sent twice. The record says what was burned.
  const sent = useRef<{ burn: bigint; balanceBefore: bigint } | null>(null);
  // The transaction a send that was not confirmed named, so a landed exit can still be recorded.
  const sentHash = useRef<string | null>(null);
  const ackId = useId();
  const published = usePublishMirror();
  const queryClient = useQueryClient();
  const send = usePickedSend(picker, chainId, followActingAccount);

  // Locked team Shares cannot be burned: the exit gives up only what is free.
  const sharesToBurn = position?.sharesBurnable ?? 0n;
  const overdrawn = position
    ? overdrawsPosition({
        sharesToBurn,
        lootToBurn: 0n,
        sharesBalance: position.sharesBalance,
        lootBalance: position.lootBalance,
        sharesTotal: position.sharesTotal,
        lootTotal: position.lootTotal,
        daoHeld: position.daoHeld,
        lockedTotal: position.lockedTotal,
        pools: [],
      })
    : true;
  // Leaving pays nothing: the Shares are destroyed all the same, so it takes a tick saying so (D144).
  const paysNothing = position ? exitPaysNothing(position.rows) : false;
  const paid = (position?.rows ?? []).filter((row) => row.due > 0n);

  // Once the exit is confirmed, everything that shows Shares or money is read again (D144).
  const reread = () => {
    void queryClient.invalidateQueries({ queryKey: ["ragequit-position"] });
    void queryClient.invalidateQueries({ queryKey: ["delegates"] });
    void queryClient.invalidateQueries({
      queryKey: ["launchpad", "work", dao],
    });
    void queryClient.invalidateQueries({
      queryKey: ["launchpad", "contributor-funds", dao],
    });
    void queryClient.invalidateQueries({
      queryKey: ["launchpad", "holders", dao],
    });
    void queryClient.invalidateQueries({ queryKey: [...ACCOUNT_MONEY_QUERY] });
  };

  /** The position as it is now, straight from the chain; null when it could not be read. */
  const readFresh = async (): Promise<RagequitPosition | null> => {
    if (!holder) return null;
    try {
      return await fetchRagequitPosition(getRpcEndpoint(), dao, holder, tokens);
    } catch {
      return null;
    }
  };

  /**
   * What can leave is not what the dialog showed: nothing is sent. The dialog shows the fresh read instead and starts
   * over, so the person sees the new amount and confirms again (D145).
   */
  const refuseChanged = (
    fresh: RagequitPosition | null,
    burnable: bigint,
    afterSend: boolean,
  ) => {
    if (fresh) {
      queryClient.setQueryData(ragequitPositionKey(dao, holder, tokens), fresh);
    }
    sent.current = null;
    sentHash.current = null;
    setUnderstood(false);
    dispatch({ type: "reset", order: [] });
    const now = formatShares(burnable);
    setRecheck(
      afterSend
        ? `Your Shares changed after the exit was sent, so it was not sent again. The first exit may have gone through: ${now} Shares can leave now. Check what this shows before you leave again.`
        : `Your Shares changed since this page read them: ${now} can leave now, not ${formatShares(sharesToBurn)}. Nothing was sent. Check what this shows, then confirm again.`,
    );
  };

  const run = async (retrying = false) => {
    setRunning(true);
    setRecheck(null);
    try {
      let burn = sharesToBurn;
      let balanceBefore = 0n;
      let resume: RagequitResume | undefined;
      let priorExit: FlowReceipt | undefined;
      if (!retrying) {
        // The position is read from the chain just before the send: the exit burns exactly what the dialog showed.
        const fresh = await readFresh();
        const check: ExitCheck = firstExit({ shown: sharesToBurn, fresh });
        if (check.kind === "unknown") {
          toast.error(
            "Couldn't read your Shares just now, so nothing was sent. Try again.",
          );
          return;
        }
        if (check.kind === "changed") {
          refuseChanged(fresh, check.burnable, false);
          return;
        }
        burn = check.burn;
        balanceBefore = check.balanceBefore;
      } else {
        const exitDone = state.steps.exit === "done";
        const fresh = exitDone ? null : await readFresh();
        const next = exitRetry({
          exitDone,
          sent: sent.current,
          fresh,
          current: sharesToBurn,
        });
        if (next.kind === "unknown") {
          toast.error(
            "Couldn't check whether your exit went through, so nothing was sent. Refresh the page, then try again.",
          );
          return;
        }
        if (next.kind === "changed") {
          refuseChanged(fresh, next.burnable, sent.current !== null);
          return;
        }
        if (next.kind === "landed") {
          // It went through: show it and read the page again, and record it rather than send it twice.
          const receipt: FlowReceipt = {
            txHash: sentHash.current ?? "",
            status: "success",
          };
          dispatch({ type: "step-done", step: "exit", receipt });
          reread();
          if (!sentHash.current) {
            dispatch({
              type: "step-failed",
              step: "mirror",
              message:
                "your exit went through, but its transaction is not known here, so no record of it was saved",
            });
            return;
          }
          burn = sent.current?.burn ?? sharesToBurn;
          resume = { completed: new Set(["exit"]) };
          priorExit = receipt;
        } else if (next.kind === "record") {
          burn = next.burn;
          resume = { completed: new Set(["exit"]) };
          priorExit = state.receipts.exit;
        } else {
          burn = next.burn;
          balanceBefore = next.balanceBefore;
        }
      }
      if (!resume) {
        sent.current = { burn, balanceBefore };
        sentHash.current = null;
      }
      const plan = buildRagequitPlan({
        buildTx: () =>
          buildRagequitTx(dao, {
            tokens,
            sharesToBurn: burn,
            lootToBurn: 0n,
            forbidden: position
              ? [position.sharesToken, position.lootToken, dao]
              : [dao],
          }),
        priorExitReceipt: priorExit,
      });
      if (!resume) {
        dispatch({ type: "reset", order: plan.order });
      }
      // A send that was not confirmed may name its transaction: kept, so a landed exit can still be recorded.
      const sendKeepingHash = async (calls: Parameters<typeof send>[0]) => {
        try {
          return await send(calls);
        } catch (error) {
          sentHash.current = sentTxHash(error) ?? sentHash.current;
          throw error;
        }
      };
      const deps = confirmedRagequitDeps(sendKeepingHash, async (receipt) => {
        // The NIP-LP `ragequit` word (NIP-LP.md:159) — a record-only write
        // bound to the tx hash the flow already holds. No hash pasting.
        await published.mutateAsync({
          kind: KIND_LAUNCH_RECEIPT,
          author: record.author,
          launchId: record.id,
          extraTags: [
            ["kind", "ragequit"],
            ["tx", receipt.txHash],
            ["chain", String(chainId)],
            ["contract", dao],
          ],
          content: {
            table: "ragequit",
            dao,
            sharesBurned: burn.toString(),
            lootBurned: "0",
            tokens,
          },
        });
      });
      await runRagequitFlow(plan, deps, onExitLanded(dispatch, reread), resume);
    } catch (err) {
      toast.error(senderErrorMessage(err, "The exit was not sent."));
    } finally {
      setRunning(false);
    }
  };

  const done = state.phase === "done";
  const exitLanded = state.steps.exit === "done";
  // A landed exit whose transaction is not known cannot be recorded: nothing is offered that would only fail again.
  const canRetry =
    state.phase === "failed" &&
    (!exitLanded || Boolean(state.receipts.exit?.txHash));
  const account = holder ? truncatePubkey(holder) : "this account";

  return (
    <Modal label="Leave and take your share" onClose={onClose}>
      <h2 className="text-lg font-semibold text-black dark:text-white">
        Leave and take your share
      </h2>
      {exitLanded || !position ? null : paysNothing ? (
        <p
          className="mt-1 text-sm text-amber-800 dark:text-amber-200"
          data-testid="ragequit-dialog-nothing"
        >
          The treasury holds nothing you can take, so leaving now pays you
          nothing. Your {formatShares(sharesToBurn)} Shares are destroyed all
          the same, and you lose their votes.
        </p>
      ) : (
        <p
          className="mt-1 text-sm text-black/60 dark:text-white/60"
          data-testid="ragequit-dialog-summary"
        >
          Your {formatShares(sharesToBurn)} Shares are destroyed, and you get{" "}
          {paid
            .map((row) => formatTokenAmount(row.due, infoOf(row.token)))
            .join(" and ")}{" "}
          at {account}, in one step. A record of it is then saved on this
          project.
        </p>
      )}
      <p className="mt-1 text-xs text-muted-foreground">
        Leaving pays out{" "}
        {tokens
          .map((t) => infoOf(t).symbol ?? "the project's currency")
          .join(" and ")}
        . Anything else the DAO holds stays in the treasury.
      </p>
      {recheck ? (
        <p
          className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
          data-testid="ragequit-recheck"
          role="alert"
        >
          {recheck}
        </p>
      ) : null}
      {paysNothing && !exitLanded ? (
        <label
          className="mt-3 flex items-start gap-2 text-sm text-black/80 dark:text-white/80"
          htmlFor={ackId}
        >
          <input
            checked={understood}
            data-testid="ragequit-nothing-ack"
            disabled={running}
            id={ackId}
            onChange={(e) => setUnderstood(e.target.checked)}
            type="checkbox"
          />
          <span>
            I understand that my {formatShares(sharesToBurn)} Shares are
            destroyed and I get nothing back.
          </span>
        </label>
      ) : null}
      <ol className="mt-3 flex flex-col gap-1">
        {state.order.map((step) => (
          <li
            className="flex items-center justify-between text-sm text-black/80 dark:text-white/80"
            key={step}
          >
            <span>{RAGEQUIT_STEP_LABELS[step]}</span>
            <span data-testid={`ragequit-step-${step}`}>
              {state.steps[step]}
            </span>
          </li>
        ))}
      </ol>
      {state.errorMessage ? (
        <p
          className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200"
          data-testid="ragequit-failure"
          role="alert"
        >
          {state.errorMessage}
          {exitLanded && state.receipts.exit?.txHash ? (
            <>
              {" "}
              The exit transaction:{" "}
              <code className="break-all">{state.receipts.exit.txHash}</code>
            </>
          ) : null}
        </p>
      ) : null}
      {done ? (
        <p
          className="mt-3 rounded-lg bg-green-50 p-3 text-sm text-green-800 dark:bg-green-950 dark:text-green-200"
          data-testid="ragequit-done"
          role="status"
        >
          Exit confirmed
          {state.receipts.exit ? (
            <>
              {" "}
              (tx{" "}
              <code className="break-all">{state.receipts.exit.txHash}</code>)
            </>
          ) : null}
          , and the receipt is recorded.
        </p>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose} size="sm" variant="outline">
          Close
        </Button>
        {canRetry ? (
          <Button
            data-testid="ragequit-retry"
            disabled={running || (!exitLanded && paysNothing && !understood)}
            onClick={() => void run(true)}
            size="sm"
          >
            {exitLanded ? "Retry the record" : "Retry"}
          </Button>
        ) : exitLanded ? null : (
          <Button
            data-testid="ragequit-run"
            disabled={
              running ||
              overdrawn ||
              sharesToBurn === 0n ||
              (paysNothing && !understood)
            }
            onClick={() => void run()}
            size="sm"
          >
            {running
              ? "Working…"
              : paysNothing
                ? "Leave with nothing"
                : "Leave and take my share"}
          </Button>
        )}
      </div>
    </Modal>
  );
}

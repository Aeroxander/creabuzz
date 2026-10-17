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
import { useReducer, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/shared/ui/button";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { KIND_LAUNCH_RECEIPT } from "@/shared/constants/kinds";
import { toast } from "sonner";

import { ethCall, getRpcEndpoint } from "../chain";
import type { LaunchRecord } from "../models";
import {
  buildRagequitPlan,
  initialRagequitFlowState,
  ragequitFlowReducer,
  RAGEQUIT_STEP_LABELS,
  resumeRagequitFromState,
  runRagequitFlow,
  senderRagequitDeps,
} from "../lib/ragequit-flow";
import {
  buildRagequitTx,
  ETH_TOKEN,
  normalizeRagequitTokens,
} from "../lib/ragequit-tx";
import {
  fetchRagequitPosition,
  fetchTokenInfo,
  overdrawsPosition,
  type RagequitPosition,
  type TokenInfo,
} from "../lib/ragequit-position";
import { formatShares } from "../lib/shares-format";
import { formatUnits } from "../lib/dao-actions";
import type { DaoBinding } from "../lib/org-money";
import { usePublishMirror } from "../use-launches";
import { Modal } from "./Modal";
import {
  resolveSender,
  SenderPickerControls,
  senderErrorMessage,
  useSenderPicker,
} from "./SenderPicker";
import { useConnectedWallet } from "../use-connected-wallet";

const SELECTOR_CURRENCY = "0xe5a6b10f"; // currency() — cast sig golden (fund-flow.ts)

export interface RagequitPanelProps {
  record: LaunchRecord;
  chainId: number;
  /** When null the panel renders the honest "no DAO bound" state. */
  daoBinding: DaoBinding | null;
}

/** A token amount as people read it: its own decimals, a few fraction digits, and its name. */
function formatToken(value: bigint, info: TokenInfo): string {
  return `${formatUnits(value, info.decimals, info.decimals > 6 ? 4 : 2)} ${info.symbol}`;
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
        The treasury holds {formatToken(pool, info)}
      </span>
      <span className="font-medium" data-testid="ragequit-claim-row">
        You get {formatToken(due, info)}
      </span>
    </li>
  );
}

export function RagequitPanel({
  record,
  chainId,
  daoBinding,
}: RagequitPanelProps) {
  const picker = useSenderPicker();
  const { address: walletAccount } = useConnectedWallet();
  const [dialogOpen, setDialogOpen] = useState(false);

  // The exit runs from whichever account the picker is on: the injected
  // wallet or the passkey's smart account (tokens settle there).
  const holder =
    picker.kind === "passkey" ? picker.passkeyAccount : walletAccount;

  // The DAO's pools to claim: ETH plus the auction's raise currency when one
  // exists. Tokens outside this list are NOT claimed by this action (stated
  // in the dialog) — a custom-token exit is deferred.
  const currencyQuery = useQuery({
    queryKey: ["ragequit-currency", record.auction, getRpcEndpoint()],
    enabled: Boolean(record.auction),
    queryFn: async () => {
      const raw = await ethCall(
        getRpcEndpoint(),
        record.auction as string,
        SELECTOR_CURRENCY,
      );
      // A currency() answer is one ABI word; a short/garbled reply (an
      // unanswered mock or a non-contract) is NOT an address — fall back to
      // the ETH-only token list instead of composing a bogus one.
      const body = raw.startsWith("0x") ? raw.slice(2) : raw;
      if (body.length !== 64) return null;
      return `0x${body.slice(-40).toLowerCase()}`;
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const tokens = currencyQuery.data
    ? normalizeRagequitTokens([ETH_TOKEN, currencyQuery.data])
    : [ETH_TOKEN];
  const currencyInfoQuery = useQuery({
    queryKey: ["ragequit-token-info", currencyQuery.data, getRpcEndpoint()],
    enabled: Boolean(currencyQuery.data),
    queryFn: () =>
      fetchTokenInfo(getRpcEndpoint(), currencyQuery.data as string),
    staleTime: 300_000,
    refetchOnWindowFocus: false,
  });
  // How each token in the exit is named and counted; the sale's currency is read from its own contract.
  const infoOf = (token: string): TokenInfo =>
    token === ETH_TOKEN
      ? { symbol: "ETH", decimals: 18 }
      : (currencyInfoQuery.data ?? { symbol: "units", decimals: 18 });

  const positionQuery = useQuery({
    queryKey: [
      "ragequit-position",
      daoBinding?.dao,
      holder,
      tokens.join(","),
      getRpcEndpoint(),
    ],
    enabled: Boolean(daoBinding && holder),
    queryFn: () =>
      fetchRagequitPosition(
        getRpcEndpoint(),
        daoBinding?.dao as string,
        holder as string,
        tokens,
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
        Your shares are a claim on the treasury. If you stop believing in the
        project, you can give them up and take your part of the treasury back.
        Shares the DAO keeps for itself do not count, so they never shrink what
        you get.{" "}
        <span className="text-black/45 dark:text-white/45">
          DAO {truncatePubkey(daoBinding.dao)}.
        </span>
      </p>
      {/* The picker sits here because the position is the SELECTED account's:
          switching wallet ↔ passkey re-reads who is exiting. */}
      <SenderPickerControls state={picker} testIdPrefix="ragequit-" />
      {holder ? (
        <PositionBody
          infoOf={infoOf}
          position={positionQuery.data ?? null}
          loading={positionQuery.isFetching}
          error={
            positionQuery.error instanceof Error
              ? positionQuery.error.message
              : null
          }
          onExit={() => setDialogOpen(true)}
        />
      ) : (
        <p className="mt-2 text-sm text-black/60 dark:text-white/60">
          Pick the sender above (an injected wallet or the passkey account) to
          see that account&apos;s claimable position.
        </p>
      )}
      {dialogOpen && daoBinding ? (
        <RagequitDialog
          record={record}
          chainId={chainId}
          dao={daoBinding.dao}
          tokens={tokens}
          holder={holder ?? null}
          position={positionQuery.data ?? null}
          picker={picker}
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
        <dt>Shares held outside the DAO</dt>
        <dd className="text-right">
          {formatShares(
            position.sharesTotal + position.lootTotal - position.daoHeld,
          )}
        </dd>
      </dl>
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
      <p className="mt-2 text-xs text-black/50 dark:text-white/50">
        This is worked out from the treasury as it is now. The exact amount is
        fixed when the exit goes through.
      </p>
      <Button className="mt-3" onClick={onExit} data-testid="ragequit-exit">
        Leave and take my share
      </Button>
    </>
  );
}

function RagequitDialog({
  record,
  chainId,
  dao,
  tokens,
  holder,
  position,
  picker,
  onClose,
}: {
  record: LaunchRecord;
  chainId: number;
  dao: string;
  tokens: string[];
  holder: string | null;
  position: RagequitPosition | null;
  picker: ReturnType<typeof useSenderPicker>;
  onClose: () => void;
}) {
  const [state, dispatch] = useReducer(
    ragequitFlowReducer,
    undefined,
    initialRagequitFlowState,
  );
  const [running, setRunning] = useState(false);
  const published = usePublishMirror();

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
        pools: [],
      })
    : true;

  const run = async (resume?: ReturnType<typeof resumeRagequitFromState>) => {
    setRunning(true);
    try {
      const sender = resolveSender(picker);
      const plan = buildRagequitPlan({
        buildTx: () =>
          buildRagequitTx(dao, {
            tokens,
            sharesToBurn,
            lootToBurn: 0n,
            forbidden: position
              ? [position.sharesToken, position.lootToken, dao]
              : [dao],
          }),
        priorExitReceipt: resume ? state.receipts.exit : undefined,
      });
      if (!resume) {
        dispatch({ type: "reset", order: plan.order });
      }
      const deps = senderRagequitDeps(sender, async (receipt) => {
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
            sharesBurned: sharesToBurn.toString(),
            lootBurned: "0",
            tokens,
          },
        });
      });
      await runRagequitFlow(plan, deps, dispatch, resume);
    } catch (err) {
      toast.error(senderErrorMessage(err, "The exit was not sent."));
    } finally {
      setRunning(false);
    }
  };

  const canRetry = state.phase === "failed";
  const done = state.phase === "done";
  const exitLanded = state.steps.exit === "done";

  return (
    <Modal label="Leave and take your share" onClose={onClose}>
      <h2 className="text-lg font-semibold text-black dark:text-white">
        Leave and take your share
      </h2>
      <p className="mt-1 text-sm text-black/60 dark:text-white/60">
        You give up {formatShares(sharesToBurn)} shares and receive your part of
        the treasury at {holder ? truncatePubkey(holder) : "this account"}, in
        one step. A record of it is then saved on this project.
      </p>
      <p className="mt-1 text-xs text-black/50 dark:text-white/50">
        You receive:{" "}
        {tokens
          .map((t) => (t === ETH_TOKEN ? "ETH" : truncatePubkey(t)))
          .join(", ")}
        . Anything else the DAO holds stays in the treasury.
      </p>
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
        >
          {state.errorMessage}
          {exitLanded && state.receipts.exit ? (
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
            disabled={running}
            onClick={() => void run(resumeRagequitFromState(state))}
            size="sm"
          >
            {exitLanded ? "Retry the record" : "Retry"}
          </Button>
        ) : (
          <Button
            data-testid="ragequit-run"
            disabled={running || overdrawn || sharesToBurn === 0n}
            onClick={() => void run()}
            size="sm"
          >
            {running ? "Working…" : "Leave and take my share"}
          </Button>
        )}
      </div>
    </Modal>
  );
}

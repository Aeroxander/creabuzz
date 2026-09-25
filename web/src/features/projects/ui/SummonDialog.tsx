/**
 * Form the DAO — the summon preview and its one send.
 *
 * Until now the Project Detail bridge only *described* the next step
 * ("Next: form the DAO"). This dialog is the step: it shows the Project
 * Board's equity map as the shares majeur will mint, checks the caps and the
 * bindings before any bytes exist, and sends one transaction through the
 * existing sender picker (wallet or sponsored passkey — the same
 * `RagequitPanel` pattern, same step machine).
 *
 * What the preview owes the reader, and where it comes from:
 *
 * - **the allocation table** — name → bound address → % → shares. Shares are
 *   `pct × 10^18` (`summon-composer.ts`, Shares `decimals = 18`,
 *   `Moloch.sol:1064`). A seat with no bound address shows an em dash and is
 *   refused; nothing is guessed.
 * - **the cap line** — `budget × 6 vs the graduation threshold` (the 1/6
 *   rule, `launch-params.ts:140-155`) with the 3× default-pass figure next to
 *   it. `over` blocks the send; a record with no figures reads `unknown`,
 *   never `within`.
 * - **the unbound list** — who is missing and exactly what fixes it.
 * - **the §9 stance** — the disclaimer the board already shows
 *   (`JoinDialog.tsx` `STAKE_DISCLAIMER`, manifest.ts:27 cites plan §9): the
 *   platform records, the project owns the legal act.
 * - **one action** — compose + send. The mirror (kind:47005 `summon` receipt)
 *   is the second step of the same machine, so a record failure retries
 *   alone and can never re-send the summon (`summon-flow.ts`).
 */
import { useEffect, useMemo, useReducer, useState } from "react";
import { toast } from "sonner";

import { readWalletBinding } from "@/features/identity/lib/siwe";
import { getRpcEndpoint } from "@/features/launchpad/chain";
import type { Launch } from "@/features/launchpad/models";
import { usePublishMirror } from "@/features/launchpad/use-launches";
import { Modal } from "@/features/launchpad/ui/Modal";
import {
  resolveSender,
  SenderPickerControls,
  senderErrorMessage,
  useSenderPicker,
} from "@/features/launchpad/ui/SenderPicker";
import { toAtomic } from "@/features/launchpad/lib/amounts";
import { KIND_LAUNCH_RECEIPT } from "@/shared/constants/kinds";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

import { confirmSummonTx } from "../lib/summon-chain";
import {
  buildSummonTx,
  composeSummon,
  deriveOrgSymbol,
  localBindingMap,
  SHARES_PER_PERCENT,
  summonReceiptContent,
  summonSalt,
  type SummonOrg,
} from "../lib/summon-composer";
import {
  buildSummonPlan,
  initialSummonFlowState,
  resumeSummonFromState,
  runSummonFlow,
  senderSummonDeps,
  SUMMON_ORDER,
  SUMMON_STEP_LABELS,
  summonFlowReducer,
  type SummonStepId,
} from "../lib/summon-flow";
import type { ProjectState } from "../lib/state";
import { STAKE_DISCLAIMER } from "./JoinDialog";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Duplicate sentences render once — and give the list stable keys. */
function unique(messages: readonly string[]): string[] {
  return [...new Set(messages)];
}
const DEFAULT_CHAIN_ID = "11155111";

export interface SummonDialogProps {
  onOpenChange: (next: boolean) => void;
  project: ProjectState;
  /** The project's launch record — the cap figures and the receipt's anchor. */
  launch: Launch | undefined;
  nameOf: (pubkey: string) => string;
}

export function SummonDialog({
  onOpenChange,
  project,
  launch,
  nameOf,
}: SummonDialogProps) {
  const picker = useSenderPicker();
  const [state, dispatch] = useReducer(
    summonFlowReducer,
    undefined,
    initialSummonFlowState,
  );
  const [summoner, setSummoner] = useState("");
  // The plan is visible before anything is sent: both steps start `pending`
  // instead of the empty-order `skipped` the reducer boots with.
  useEffect(() => {
    dispatch({ type: "reset", order: SUMMON_ORDER });
  }, []);
  const [running, setRunning] = useState(false);
  const published = usePublishMirror();

  // Read once per dialog: the binding is the relay's own SIWE record mirrored
  // into this browser (`siwe.ts:30`), and re-reading it every render would
  // invalidate the memoised composition for no reason.
  const [binding] = useState(() =>
    typeof window === "undefined" ? null : readWalletBinding(),
  );
  const org: SummonOrg = useMemo(
    () => ({
      nodeId: project.manifest.nodeId,
      orgName: project.manifest.name,
      orgSymbol: deriveOrgSymbol(project.manifest.name),
    }),
    [project.manifest.nodeId, project.manifest.name],
  );
  const composition = useMemo(() => {
    const bindings = localBindingMap(binding, project.team);
    return composeSummon(
      project.team,
      bindings,
      {
        budget: launch ? toAtomic(launch.record.budget) : null,
        requiredCurrencyRaised: launch
          ? (toAtomic(launch.record.requiredRaised) ?? 0n)
          : 0n,
        currency: launch?.record.currency ?? undefined,
      },
      org,
    );
  }, [binding, launch, org, project.team]);

  const summonerOk = ADDRESS_RE.test(summoner.trim());
  const chainId =
    launch?.record.chainId ??
    (picker.chainId > 0 ? String(picker.chainId) : DEFAULT_CHAIN_ID);

  // Precondition failures the composer cannot see (they are about the record
  // and the deployment, not the map) — named here so the send button can
  // never be a dead end without saying why.
  const preconditions: string[] = [];
  if (!launch) {
    preconditions.push(
      `No launch record for “${project.manifest.nodeId}” — the kind:47005 summon receipt attaches to it. Create the launch first; the ids line up.`,
    );
  }
  if (!summonerOk) {
    preconditions.push(
      "No Summoner contract address — paste the one the deployment printed (forge script DeployOrgDao logs “Summoner: 0x…”).",
    );
  }
  const blockers = [...preconditions, ...composition.blockers];
  const unbound = composition.seats.filter((seat) => seat.status === "unbound");
  const canSend =
    blockers.length === 0 &&
    composition.ok &&
    !running &&
    state.phase !== "done";

  const run = async (resume?: ReturnType<typeof resumeSummonFromState>) => {
    if (!launch || !composition.callData) return;
    setRunning(true);
    try {
      const data = composition.callData;
      const sender = resolveSender(picker);
      const plan = buildSummonPlan({
        buildTx: () => buildSummonTx(summoner.trim(), data),
        priorReceipt: resume ? state.receipts.send : undefined,
      });
      // A fresh attempt resets; a resume keeps the ledger (done steps stay
      // done, `reconcile` stays latched).
      if (!resume) {
        dispatch({ type: "reset", order: plan.order });
      }
      const deps = senderSummonDeps(
        sender,
        (txHash) => confirmSummonTx(getRpcEndpoint(), txHash),
        async (receipt) => {
          // The record leg: same publisher as every other launch receipt.
          await published.mutateAsync({
            kind: KIND_LAUNCH_RECEIPT,
            author: launch.record.author,
            launchId: launch.record.id,
            extraTags: [
              ["kind", "summon"],
              ["tx", receipt.txHash],
              ["chain", chainId],
              ["contract", summoner.trim()],
            ],
            content: summonReceiptContent({
              composition,
              org,
              chainId,
              summoner: summoner.trim(),
              dao: receipt.dao,
            }),
          });
        },
      );
      await runSummonFlow(plan, deps, dispatch, resume);
    } catch (err) {
      toast.error(senderErrorMessage(err, "The summon was not sent."));
    } finally {
      setRunning(false);
    }
  };

  const canRetry = state.phase === "failed";
  const done = state.phase === "done";

  return (
    <Modal label="Form the DAO" onClose={() => onOpenChange(false)}>
      <h2 className="text-lg font-semibold text-black dark:text-white">
        Form the DAO
      </h2>
      <p className="mt-1 text-sm text-black/60 dark:text-white/60">
        One transaction mints these shares inside a new majeur Moloch: the seats
        below get voting power, a proportional treasury exit (
        <code className="font-mono">ragequit</code>), and a record on chain —
        instead of a revocable Nostr grant.
      </p>
      <p className="mt-2 text-xs text-black/50 dark:text-white/50">
        <code className="font-mono">{org.orgName}</code> ({org.orgSymbol}) ·
        quorum {org.quorumBps ?? 500} bps · salt{" "}
        <code className="font-mono">
          {summonSalt(org.nodeId).slice(0, 12)}…
        </code>
      </p>

      <p className="mt-3 text-sm font-medium" data-testid="summon-cap-line">
        {composition.cap.state === "unchecked" ? (
          <>
            Budget cap: unknown —{" "}
            {launch
              ? "the launch record carries no budget or threshold"
              : "no launch record to check against"}
          </>
        ) : (
          <>
            Budget cap: {composition.cap.sixMonthText} of{" "}
            {composition.cap.thresholdText} —{" "}
            <span
              className={
                composition.cap.state === "within"
                  ? "text-green-700 dark:text-green-400"
                  : "text-red-700 dark:text-red-400"
              }
            >
              {composition.cap.state === "within" ? "within" : "over"}
            </span>
          </>
        )}
      </p>
      {composition.cap.defaultPassText ? (
        <p className="text-xs text-black/50 dark:text-white/50">
          Large spends default-pass up to {composition.cap.defaultPassText} — 3×
          the monthly budget.
        </p>
      ) : null}

      <table
        className="mt-3 w-full border-collapse text-sm"
        data-testid="summon-allocation"
      >
        <caption className="caption-top text-left text-xs text-black/50 dark:text-white/50">
          Allocation — {composition.totalPct}% of the pool, minted as{" "}
          {composition.totalShares.toString()} shares (1% ={" "}
          {SHARES_PER_PERCENT.toString()})
        </caption>
        <thead>
          <tr className="border-b border-black/10 text-left dark:border-white/10">
            <th className="py-1 font-medium" scope="col">
              Seat
            </th>
            <th className="py-1 font-medium" scope="col">
              Address
            </th>
            <th className="py-1 text-right font-medium" scope="col">
              %
            </th>
            <th className="py-1 text-right font-medium" scope="col">
              Shares
            </th>
          </tr>
        </thead>
        <tbody>
          {composition.seats.map((seat) => (
            <tr
              className="border-b border-black/5 last:border-0 dark:border-white/5"
              data-testid={`summon-seat-${seat.roleSlug}`}
              key={`${seat.pubkey}:${seat.roleSlug}`}
            >
              <td className="py-1">
                <span className="block">{nameOf(seat.pubkey)}</span>
                <span className="text-2xs text-black/50 dark:text-white/50">
                  {seat.roleLabel}
                  {seat.source === "declared" ? " · declared" : " · granted"}
                </span>
              </td>
              <td className="py-1 font-mono text-xs">
                {seat.address ? (
                  <span title={seat.address}>
                    {truncatePubkey(seat.address)}
                  </span>
                ) : (
                  <span className="text-red-700 dark:text-red-400">—</span>
                )}
              </td>
              <td className="py-1 text-right tabular-nums">{seat.pct}%</td>
              <td className="py-1 text-right font-mono text-xs tabular-nums">
                {seat.shares.toString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {unbound.length > 0 ? (
        <div className="mt-3" data-testid="summon-unbound">
          <h3 className="text-sm font-medium">
            {unbound.length} seat{unbound.length === 1 ? "" : "s"} with no bound
            address
          </h3>
          <ul className="mt-1 flex flex-col gap-1 text-sm text-black/70 dark:text-white/70">
            {unbound.map((seat) => (
              <li key={`${seat.pubkey}:${seat.roleSlug}`}>
                {nameOf(seat.pubkey)} — {seat.roleLabel} ({seat.pct}%)
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-black/60 dark:text-white/60">
            Ask them to bind an address: they sign in with the wallet that holds
            their seat (SIWE) and the relay records the binding. Until then
            their seat is refused — a share is never minted to an address nobody
            proved.
          </p>
        </div>
      ) : null}

      {composition.warnings.length > 0 ? (
        <ul
          className="mt-3 flex flex-col gap-1 text-xs text-black/60 dark:text-white/60"
          data-testid="summon-warnings"
        >
          {unique(composition.warnings).map((warning) => (
            <li key={warning}>· {warning}</li>
          ))}
        </ul>
      ) : null}

      {blockers.length > 0 ? (
        <ul
          className="mt-3 flex flex-col gap-1 rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200"
          data-testid="summon-blockers"
        >
          {unique(blockers).map((blocker) => (
            <li key={blocker}>{blocker}</li>
          ))}
        </ul>
      ) : null}

      <p
        className="mt-3 text-xs text-black/50 dark:text-white/50"
        data-testid="summon-disclaimer"
      >
        {STAKE_DISCLAIMER}
      </p>

      <div className="mt-3 text-sm">
        <label className="font-medium" htmlFor="summon-summoner">
          Summoner contract
        </label>
        <Input
          className="mt-1 block w-full font-mono"
          data-testid="summon-summoner"
          id="summon-summoner"
          onChange={(event) => setSummoner(event.target.value)}
          placeholder="0x… — the Summoner factory the deployment printed"
          value={summoner}
        />
      </div>

      <SenderPickerControls state={picker} testIdPrefix="summon-" />

      <ol className="mt-3 flex flex-col gap-1" data-testid="summon-steps">
        {(Object.keys(SUMMON_STEP_LABELS) as SummonStepId[]).map((step) => (
          <li
            className="flex items-center justify-between text-sm text-black/80 dark:text-white/80"
            key={step}
          >
            <span>{SUMMON_STEP_LABELS[step]}</span>
            <span data-testid={`summon-step-${step}`}>{state.steps[step]}</span>
          </li>
        ))}
      </ol>

      {state.errorMessage ? (
        <p
          className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200"
          data-testid="summon-failure"
        >
          {state.errorMessage}
        </p>
      ) : null}
      {done ? (
        <p
          className="mt-3 rounded-lg bg-green-50 p-3 text-sm text-green-800 dark:bg-green-950 dark:text-green-200"
          data-testid="summon-done"
        >
          The DAO is summoned
          {state.receipts.send?.dao
            ? ` — ${truncatePubkey(state.receipts.send.dao)}`
            : ""}
          {state.receipts.send ? (
            <>
              {" "}
              (tx{" "}
              <code className="break-all">{state.receipts.send.txHash}</code>)
            </>
          ) : null}
          , and the receipt is recorded.
        </p>
      ) : null}

      {!canSend && !canRetry && !done ? (
        <p
          className="mt-2 text-xs text-black/50 dark:text-white/50"
          data-testid="summon-disabled-reason"
        >
          {unique(blockers)[0] ?? "The summon is not ready to send."}
        </p>
      ) : null}

      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={() => onOpenChange(false)} size="sm" variant="outline">
          Close
        </Button>
        {canRetry ? (
          <Button
            data-testid="summon-retry"
            disabled={running}
            onClick={() => void run(resumeSummonFromState(state))}
            size="sm"
          >
            {state.steps.send === "done" ? "Retry the record" : "Retry"}
          </Button>
        ) : (
          <Button
            data-testid="summon-run"
            disabled={!canSend}
            onClick={() => void run()}
            size="sm"
          >
            {running ? "Forming…" : "Form the DAO"}
          </Button>
        )}
      </div>
    </Modal>
  );
}

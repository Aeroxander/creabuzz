/**
 * "My bids" — the connected wallet's and passkey account's onchain bids on one
 * launch, with contract-gated Exit / Claim / "Claim all" actions that run
 * through the sender picker (wallet vs sponsored passkey) exactly like
 * `ui/RecordBidDialog.tsx`.
 *
 * Reads are `lib/my-bids.ts`'s view calls over the launchpad RPC seam; the
 * legality gating (which action is offered per bid and why not) is the ported
 * CCA derivation with its contract citations. No hash pasting: the action
 * dialogs have no tx field at all — the money action is composed, sent, and
 * its step failures are named (checkpoint / exit / claim).
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { Button } from "@/shared/ui/button";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { toast } from "sonner";

import type { LaunchRecord } from "../models";
import {
  buildClaimExecution,
  buildExitExecution,
  type BidActions,
  type BidView,
  EXIT_STEP_LABELS,
  type ExitPlan,
  type MyBidsSnapshot,
  fetchMyBidsSnapshot,
  resolveExitPlanAt,
} from "../lib/my-bids.ts";
import {
  completedExitSteps,
  exitFlowReducer,
  initialExitFlowState,
  resumeExitFromState,
  runExitFlow,
  senderFlowDeps,
} from "../lib/exit-flow.ts";
import { Modal } from "./Modal";
import {
  resolveSender,
  SenderPickerControls,
  senderErrorMessage,
  useSenderPicker,
} from "./SenderPicker";

const STATUS_LABELS: Record<string, string> = {
  active: "In play",
  outbid: "Outbid",
  ended: "Auction ended",
  exited: "Exited",
  claimable: "Claimable",
  settled: "Settled",
};

interface OwnerGroup {
  kind: "wallet" | "passkey";
  address: string;
}

type GroupSnapshot =
  | { status: "loading" }
  | { status: "ready"; snapshot: MyBidsSnapshot }
  | { status: "error"; error: string };

type Action =
  | {
      mode: "exit";
      owner: string;
      ownerKind: "wallet" | "passkey";
      bidId: bigint;
      plan: ExitPlan;
    }
  | {
      mode: "claim";
      owner: string;
      ownerKind: "wallet" | "passkey";
      bidIds: bigint[];
    };

/** Derive the two candidate owners without prompting the wallet. */
async function discoverOwners(): Promise<OwnerGroup[]> {
  const owners: OwnerGroup[] = [];
  const ethereum = (
    window as unknown as {
      ethereum?: {
        request(args: { method: string; params?: unknown[] }): Promise<unknown>;
      };
    }
  ).ethereum;
  if (ethereum) {
    try {
      const accounts = (await ethereum.request({
        method: "eth_accounts",
      })) as string[];
      if (accounts?.[0]) owners.push({ kind: "wallet", address: accounts[0] });
    } catch {
      // No connected account is a normal state — the passkey group still lists.
    }
  }
  return owners;
}

export function MyBidsPanel({
  record,
  rpcEndpoint,
  autoAction,
}: {
  record: LaunchRecord;
  rpcEndpoint: string;
  /**
   * Desktop → web handoff (`?action=exit|claim`): open the first matching
   * bid's action dialog once the snapshot is in. Opening is never destructive
   * — the dialog still needs its own explicit Run (deep-link contract).
   */
  autoAction?: "exit" | "claim" | null;
}) {
  const auction = record.auction;
  const [groups, setGroups] = useState<OwnerGroup[]>([]);
  const [snapshots, setSnapshots] = useState<Record<string, GroupSnapshot>>({});
  const [action, setAction] = useState<Action | null>(null);
  const picker = useSenderPicker();
  const epochRef = useRef(0);
  const rootRef = useRef<HTMLElement | null>(null);
  const autoConsumedRef = useRef(false);

  // One load pass: owner discovery (the injected wallet when already
  // connected, plus the passkey account's counterfactual derivation) then one
  // snapshot read per owner. Fenced by an epoch counter (Review-Proven Rule 2):
  // a stale read must never overwrite a newer reload.
  const reload = useCallback(async () => {
    const epoch = ++epochRef.current;
    const walletOwners = await discoverOwners();
    const all: OwnerGroup[] = [...walletOwners];
    if (picker.sponsoredStatus.available) {
      try {
        const address = await picker.sponsoredSender.getAddress();
        all.push({ kind: "passkey", address });
      } catch {
        // Availability said ready but derivation failed — listed as nothing.
      }
    }
    if (epoch !== epochRef.current) return;
    setGroups(all);
    if (!auction || all.length === 0) return;
    setSnapshots(
      Object.fromEntries(
        all.map((g) => [g.address, { status: "loading" as const }]),
      ),
    );
    const entries = await Promise.all(
      all.map(async (group) => {
        try {
          const snapshot = await fetchMyBidsSnapshot({
            endpoint: rpcEndpoint,
            auction,
            owner: group.address,
          });
          return [
            group.address,
            { status: "ready" as const, snapshot },
          ] as const;
        } catch (err) {
          return [
            group.address,
            {
              status: "error" as const,
              error: err instanceof Error ? err.message : "read failed",
            },
          ] as const;
        }
      }),
    );
    if (epoch !== epochRef.current) return;
    setSnapshots(Object.fromEntries(entries));
  }, [auction, picker.sponsoredSender, picker.sponsoredStatus, rpcEndpoint]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Deep-link `?action=exit|claim`: scroll here and expand the first bid
  // whose requested action is actually available (nothing runs without the
  // user's explicit confirm in the dialog).
  useEffect(() => {
    if (!autoAction || autoConsumedRef.current || action) return;
    for (const group of groups) {
      const snap = snapshots[group.address];
      if (snap?.status !== "ready") continue;
      for (const entry of snap.snapshot.bids) {
        if (autoAction === "exit") {
          const plan = entry.actions.exit;
          if (plan.kind === "unavailable") continue;
          autoConsumedRef.current = true;
          setAction({
            mode: "exit",
            owner: group.address,
            ownerKind: group.kind,
            bidId: entry.bidId,
            plan,
          });
        } else {
          if (entry.actions.claim.kind !== "claim") continue;
          autoConsumedRef.current = true;
          setAction({
            mode: "claim",
            owner: group.address,
            ownerKind: group.kind,
            bidIds: [entry.bidId],
          });
        }
        rootRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
    }
  }, [autoAction, action, groups, snapshots]);

  const refresh = useCallback(() => {
    void reload();
  }, [reload]);

  if (!auction) return null;

  return (
    <section
      className="flex flex-col gap-4"
      data-testid="mybids-panel"
      ref={rootRef}
    >
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-black dark:text-white">
            My bids
          </h2>
          <p className="text-sm text-black/60 dark:text-white/60">
            Onchain bids owned by your wallet or passkey account. Exit refunds
            the unfilled share; claim collects filled tokens after the claim
            block.
          </p>
        </div>
        <Button onClick={refresh} size="sm" variant="outline">
          Refresh
        </Button>
      </div>
      {groups.length === 0 ? (
        <p className="rounded-lg bg-black/5 p-3 text-sm text-black/60 dark:bg-white/5 dark:text-white/60">
          No connected account found. Connect an injected wallet or create a
          passkey on the identity page to see bids here.
        </p>
      ) : null}
      {groups.map((group) => {
        const snap: GroupSnapshot | undefined = snapshots[group.address];
        return (
          <div
            className="rounded-lg border border-black/10 p-3 dark:border-white/10"
            key={group.address}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium text-black dark:text-white">
                {group.kind === "passkey" ? "Passkey account" : "Wallet"}{" "}
                <span className="font-normal text-black/60 dark:text-white/60">
                  {truncatePubkey(group.address)}
                </span>
              </p>
              {snap?.status === "ready" ? (
                <ClaimAllButton
                  snapshot={snap.snapshot}
                  onClaim={(bidIds) =>
                    setAction({
                      mode: "claim",
                      owner: group.address,
                      ownerKind: group.kind,
                      bidIds,
                    })
                  }
                />
              ) : null}
            </div>
            {!snap || snap.status === "loading" ? (
              <p className="mt-2 text-sm text-black/60 dark:text-white/60">
                Reading bids…
              </p>
            ) : snap.status === "error" ? (
              <p className="mt-2 text-sm text-red-700 dark:text-red-300">
                Could not read bids — {snap.error}
              </p>
            ) : snap.snapshot.bids.length === 0 ? (
              <p className="mt-2 text-sm text-black/60 dark:text-white/60">
                No bids from this account on this auction.
              </p>
            ) : (
              <ul className="mt-2 flex flex-col gap-2">
                {snap.snapshot.bids.map((entry) => (
                  <BidRow
                    key={entry.bidId.toString()}
                    bidId={entry.bidId}
                    bid={entry.bid}
                    actions={entry.actions}
                    onExit={(plan) =>
                      setAction({
                        mode: "exit",
                        owner: group.address,
                        ownerKind: group.kind,
                        bidId: entry.bidId,
                        plan,
                      })
                    }
                    onClaim={() =>
                      setAction({
                        mode: "claim",
                        owner: group.address,
                        ownerKind: group.kind,
                        bidIds: [entry.bidId],
                      })
                    }
                  />
                ))}
              </ul>
            )}
          </div>
        );
      })}
      {action ? (
        <MoneyActionDialog
          action={action}
          auction={auction}
          rpcEndpoint={rpcEndpoint}
          picker={picker}
          onClose={() => setAction(null)}
          onSettled={() => {
            setAction(null);
            refresh();
          }}
        />
      ) : null}
    </section>
  );
}

function ClaimAllButton({
  snapshot,
  onClaim,
}: {
  snapshot: MyBidsSnapshot;
  onClaim: (bidIds: bigint[]) => void;
}) {
  const claimable = snapshot.bids.filter(
    (b) => b.actions.claim.kind === "claim",
  );
  if (claimable.length === 0) return null;
  return (
    <Button
      onClick={() => onClaim(claimable.map((b) => b.bidId))}
      size="sm"
      variant="outline"
    >
      Claim all ({claimable.length})
    </Button>
  );
}

function BidRow({
  bidId,
  bid,
  actions,
  onExit,
  onClaim,
}: {
  bidId: bigint;
  bid: BidView;
  actions: BidActions;
  onExit: (plan: ExitPlan) => void;
  onClaim: () => void;
}) {
  const exitReady = actions.exit.kind !== "unavailable";
  const claimReady = actions.claim.kind === "claim";
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-black/5 p-2 dark:bg-white/5">
      <div className="text-sm text-black dark:text-white">
        <span className="font-medium">Bid #{bidId.toString()}</span>{" "}
        <span className="text-black/60 dark:text-white/60">
          max {bid.maxPrice.toString()} · filled {bid.tokensFilled.toString()} ·{" "}
          {STATUS_LABELS[actions.status] ?? actions.status}
        </span>
      </div>
      <div className="flex gap-2">
        {exitReady ? (
          <Button
            data-testid="mybids-exit"
            onClick={() => onExit(actions.exit)}
            size="sm"
            variant="outline"
          >
            Exit
          </Button>
        ) : (
          <span
            className="self-center text-xs text-black/60 dark:text-white/60"
            title={
              actions.exit.kind === "unavailable" ? actions.exit.reason : ""
            }
          >
            Exit unavailable
          </span>
        )}
        {claimReady ? (
          <Button data-testid="mybids-claim" onClick={onClaim} size="sm">
            Claim
          </Button>
        ) : (
          <span
            className="self-center text-xs text-black/60 dark:text-white/60"
            title={
              actions.claim.kind === "unavailable" ? actions.claim.reason : ""
            }
          >
            {actions.claim.kind === "unavailable"
              ? actions.claim.reason
              : "Claim unavailable"}
          </span>
        )}
      </div>
    </li>
  );
}

/**
 * One exit/claim attempt: the sender picker, the step phase, and honest
 * partial-failure reporting that names the failed step. Mirror-only concerns
 * do not exist here — exit/claim are money actions with no feed mirror
 * (desktop `exitHooks.ts` flow contract) — so every failure IS a named money
 * step and retry re-sends only the remaining steps.
 */
function MoneyActionDialog({
  action,
  auction,
  rpcEndpoint,
  picker,
  onClose,
  onSettled,
}: {
  action: Action;
  auction: string;
  rpcEndpoint: string;
  picker: ReturnType<typeof useSenderPicker>;
  onClose: () => void;
  onSettled: () => void;
}) {
  const [state, dispatch] = useReducer(
    exitFlowReducer,
    undefined,
    initialExitFlowState,
  );
  const [running, setRunning] = useState(false);

  const title =
    action.mode === "exit"
      ? `Exit bid #${action.bidId.toString()}`
      : action.bidIds.length === 1
        ? `Claim tokens for bid #${action.bidIds[0].toString()}`
        : `Claim tokens for ${action.bidIds.length} bids`;

  const run = async (resume?: ReturnType<typeof resumeExitFromState>) => {
    setRunning(true);
    try {
      const sender = resolveSender(picker);
      const execution =
        action.mode === "exit"
          ? buildExitExecution({
              auction,
              bidId: action.bidId,
              plan: action.plan,
              resolvePlan: () =>
                resolveExitPlanAt(rpcEndpoint, auction, action.bidId),
            })
          : buildClaimExecution({
              auction,
              owner: action.owner,
              bidIds: action.bidIds,
            });
      if (!resume) {
        dispatch({ type: "reset", order: execution.order });
      }
      await runExitFlow(execution, senderFlowDeps(sender), dispatch, resume);
    } catch (err) {
      toast.error(senderErrorMessage(err, "The action was not sent."));
    } finally {
      setRunning(false);
    }
  };

  const canRetry = state.phase === "failed";
  const done = state.phase === "done";

  return (
    <Modal label={title} onClose={onClose}>
      <h2 className="text-lg font-semibold text-black dark:text-white">
        {title}
      </h2>
      <p className="mt-1 text-sm text-black/60 dark:text-white/60">
        {action.mode === "exit"
          ? "Exits the auction contract bid: refunds the unfilled share and records the filled tokens for a later claim."
          : "Claims the filled tokens to the bid owner after the claim block."}{" "}
        The chain is the ledger — there is nothing to mirror.
      </p>
      <SenderPickerControls state={picker} testIdPrefix="mybids-" />
      <ol className="mt-3 flex flex-col gap-1">
        {state.order.map((step) => (
          <li
            className="flex items-center justify-between text-sm text-black/80 dark:text-white/80"
            key={step}
          >
            <span>{EXIT_STEP_LABELS[step]}</span>
            <span data-testid={`mybids-step-${step}`}>{state.steps[step]}</span>
          </li>
        ))}
      </ol>
      {state.errorMessage ? (
        <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
          {state.errorMessage}
        </p>
      ) : null}
      {done ? (
        <p className="mt-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
          Done. Receipts:{" "}
          {[...completedExitSteps(state)]
            .map((step) => `${step}: ${state.receipts[step]?.txHash ?? "…"}`)
            .join(", ")}
        </p>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose} size="sm" variant="outline">
          Close
        </Button>
        {canRetry ? (
          <Button
            data-testid="mybids-retry"
            disabled={running}
            onClick={() => void run(resumeExitFromState(state))}
            size="sm"
          >
            Retry remaining
          </Button>
        ) : (
          <Button
            data-testid="mybids-run"
            disabled={running || done}
            onClick={() => void run()}
            size="sm"
          >
            {running ? "Sending…" : done ? "Sent" : "Send"}
          </Button>
        )}
      </div>
      {done ? (
        <div className="mt-2 flex justify-end">
          <Button data-testid="mybids-done" onClick={onSettled} size="sm">
            Done — refresh bids
          </Button>
        </div>
      ) : null}
    </Modal>
  );
}

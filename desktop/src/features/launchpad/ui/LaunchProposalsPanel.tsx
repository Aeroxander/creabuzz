/**
 * Decision-routed proposal cards — S2 of
 * `docs/agentic-governance-design.md`, upgraded from display-only to the
 * decision-routing spine (D1).
 *
 * Litmus test (§0): a stranger sees all three facts on every card, with no
 * tooltip —
 *
 * 1. **Which mechanism** (the D1 routing map, spelled out per kind:
 *    `signal` = deliberation with NO ballot, `plain` = the majeur ballot,
 *    `futarchy-budget` = read-only market note — markets land later);
 * 2. **Who held authority** (D5: the proposer + grant provenance or its
 *    honest fallback, and the sender of every action);
 * 3. **Where the receipts are** (D4: the kind:47005 proposal/vote/execute
 *    mirrors, listed per proposal with their txs, and emitted by every
 *    action this panel runs).
 *
 * Mechanics ride the desktop composer (`lib/voteTx.ts`, `cast`-pinned):
 * `openProposal(id)` -> `castVote(id, support)` -> `state(id)` gates ->
 * `queue(id)` -> `executeByVotes(...)`. Actions are gated on real `state(id)`
 * reads; without an onchain binding a card degrades to D8's record-only
 * copy — never to a theater ballot. D6's quorum math renders in plain
 * language before any vote, from the DAO's own config getters ("per DAO
 * config" where the chain did not answer — never a guessed number). D2's
 * dissent door (ragequit shortcut) is persistent on every card.
 *
 * Chain reads/writes follow the launchpad conventions (`RoyaltyStatementCard`):
 * read-only `evm_call`, sends via `evm_send_transaction`; a mined revert is
 * data (nothing moved), never a silent success. A failed 47005 mirror never
 * re-sends the tx — the chain is the ledger.
 */

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  Launch,
  LaunchProposal,
} from "@/features/launchpad/launchpadModels";
import {
  authorityLine,
  governanceReceiptMirror,
  PROPOSAL_ACTION_LABELS,
  proposalReceipts,
  quorumSummary,
  RECEIPTS_VOCABULARY,
  RECORD_ONLY_COPY,
  renderedActions,
  resolveDaoBinding,
  routeDecision,
  type ProposalAction,
  type ProposalDaoBinding,
} from "@/features/launchpad/lib/decisionRouting";
import {
  loadDaoGovParams,
  type DaoGovParams,
} from "@/features/launchpad/lib/daoGovConfig";
import { getRpcEndpoint } from "@/features/launchpad/lib/chainRpc";
import {
  buildProposalActionCall,
  decodeProposalState,
  encodeStateView,
  type ProposalState,
} from "@/features/launchpad/lib/voteTx";
import {
  publishSignedEvent,
  usePublishLaunchMirrorMutation,
} from "@/features/launchpad/hooks";
import {
  decodeTallies,
  quorumWatch,
} from "@/features/launchpad/lib/quorumWatch";
import {
  computeProposalId,
  encodeTalliesView,
} from "@/features/launchpad/lib/voteTx";
import { WikiDraftComposer } from "./WikiDraftComposer";
import { useEvmChainStatusQuery } from "@/features/launchpad/mintHooks";
import { useWalletStatusQuery } from "@/features/launchpad/walletHooks";
import {
  ProposalRagequitDialog,
  ProposalRagequitShortcut,
} from "@/features/launchpad/ui/ProposalRagequitDialog";
import { invokeTauri } from "@/shared/api/tauri";
import { KIND_LAUNCH_RECEIPT } from "@/shared/constants/kinds";
import { getCachedRelayOrigin } from "@/shared/lib/mediaUrl";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";

/** `evm_call()` result (the shared IPC shape in `mintHooks.ts`). */
interface EvmCallResult {
  returnData: string;
}

/** `evm_send_transaction` reply (the `MintTxReceipt` shape). */
interface GovTxReceipt {
  txHash: string;
  status: "success" | "reverted";
}

const KIND_STYLES: Record<string, string> = {
  "futarchy-budget": "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  plain: "bg-muted text-muted-foreground",
  signal: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
};

function kindLabel(kind: string): string {
  return kind === "futarchy-budget" ? "Futarchy · budget" : kind;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What a state with no composable action is telling the card. */
function lifecycleNote(state: ProposalState, hasOperation: boolean): string {
  switch (state) {
    case "Queued":
      return hasOperation
        ? "Queued — run Execute after the timelock (per DAO config)."
        : "Queued — the timelock (per DAO config) runs before execution. executeByVotes(op, to, value, data, nonce) needs the proposal's operation bytes; this record carries the proposal id only, so no execute action is composable here.";
    case "Defeated":
      return "Defeated — FOR did not beat AGAINST, or the minYes floor failed. Nothing executes.";
    case "Expired":
      return "Expired — the TTL window closed before the proposal passed. Nothing executes.";
    case "Executed":
      return "Executed — the operation landed onchain; the execute receipt above carries the tx.";
    default:
      return "";
  }
}

export function LaunchProposalsPanel({ launch }: { launch: Launch }) {
  const rpcUrl = React.useMemo(
    () => getRpcEndpoint(getCachedRelayOrigin()),
    [],
  );
  const walletQuery = useWalletStatusQuery();
  const wallet =
    walletQuery.data?.hasWallet && walletQuery.data.address
      ? walletQuery.data.address
      : null;
  const chainQuery = useEvmChainStatusQuery(rpcUrl, true);
  const chainId = chainQuery.data?.chainId ?? 0;
  const [ragequit, setRagequit] = React.useState<{
    binding: ProposalDaoBinding | null;
  } | null>(null);

  if (launch.proposals.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        <p>No proposals yet.</p>
        <p className="mt-1">
          Signal proposals live as git issues; budget and membership proposals
          go onchain after graduation. Futarchy markets resolve budget and
          subDAO allocation only.
        </p>
      </div>
    );
  }
  return (
    <>
      <WikiDraftComposer launch={launch} />
      <ol className="flex max-w-2xl flex-col gap-2">
        {launch.proposals.map((proposal) => (
          <ProposalCard
            chainId={chainId}
            key={proposal.id}
            launch={launch}
            onRagequit={(binding) => setRagequit({ binding })}
            proposal={proposal}
            rpcUrl={rpcUrl}
            wallet={wallet}
            walletError={
              walletQuery.isError ? errorText(walletQuery.error) : null
            }
            walletPending={walletQuery.isPending}
          />
        ))}
      </ol>
      {ragequit ? (
        <ProposalRagequitDialog
          author={launch.record.author}
          binding={ragequit.binding}
          chainId={chainId}
          launchId={launch.record.id}
          onClose={() => setRagequit(null)}
        />
      ) : null}
    </>
  );
}

function ProposalCard({
  launch,
  proposal,
  rpcUrl,
  chainId,
  wallet,
  walletPending,
  walletError,
  onRagequit,
}: {
  launch: Launch;
  proposal: LaunchProposal;
  rpcUrl: string;
  chainId: number;
  wallet: string | null;
  walletPending: boolean;
  walletError: string | null;
  onRagequit: (binding: ProposalDaoBinding | null) => void;
}) {
  const queryClient = useQueryClient();
  const mirror = usePublishLaunchMirrorMutation();
  const route = routeDecision(proposal.kind);
  const daoBinding = React.useMemo(
    () => resolveDaoBinding(proposal, launch.receipts),
    [proposal, launch.receipts],
  );
  const bound = Boolean(daoBinding && proposal.proposalId);
  const hasOperation = proposal.intent !== null;

  // D6's numbers come from the DAO's own config getters — the chain reads
  // win for honesty; an unread slot renders "per DAO config".
  const govConfigQuery = useQuery({
    queryKey: ["launchpad", "gov", "config", rpcUrl, daoBinding?.dao ?? ""],
    queryFn: (): Promise<DaoGovParams> => {
      if (!daoBinding) throw new Error("no DAO bound");
      return loadDaoGovParams((data) =>
        invokeTauri<EvmCallResult>("evm_call", {
          rpcUrl,
          to: daoBinding.dao,
          data,
        }).then((result) => result.returnData),
      );
    },
    enabled: Boolean(daoBinding),
    staleTime: 60_000,
  });

  // Every action is gated on the real `state(id)` read (D1 mechanics).
  const stateQuery = useQuery({
    queryKey: [
      "launchpad",
      "gov",
      "state",
      rpcUrl,
      daoBinding?.dao ?? "",
      proposal.proposalId ?? "",
    ],
    queryFn: (): Promise<ProposalState> => {
      if (!daoBinding || !proposal.proposalId) {
        throw new Error("no onchain binding");
      }
      return invokeTauri<EvmCallResult>("evm_call", {
        rpcUrl,
        to: daoBinding.dao,
        data: encodeStateView(proposal.proposalId),
      }).then((result) => decodeProposalState(result.returnData));
    },
    enabled: bound,
    staleTime: 15_000,
  });

  const action = useMutation({
    mutationFn: async (actionId: ProposalAction) => {
      if (!daoBinding || !proposal.proposalId) {
        throw new Error("no onchain binding");
      }
      const call = buildProposalActionCall({
        dao: daoBinding.dao,
        proposalId: proposal.proposalId,
        action: actionId,
        intent: proposal.intent,
      });
      const receipt = await invokeTauri<GovTxReceipt>("evm_send_transaction", {
        rpcUrl,
        chainId,
        to: call.to,
        data: call.data,
        value: call.value ?? "0x0",
      });
      let mirrorError: string | null = null;
      if (receipt.status === "success") {
        // D4: every governance action emits a 47005 receipt mirror. The
        // mirror binds the tx the flow already holds — a mirror failure is
        // reported, never retried by re-sending the action.
        const mirrorInput = governanceReceiptMirror({
          action: actionId,
          recordId: proposal.id,
          proposalId: proposal.proposalId,
          txHash: receipt.txHash,
        });
        try {
          await mirror.mutateAsync({
            kind: KIND_LAUNCH_RECEIPT,
            author: launch.record.author,
            launchId: launch.record.id,
            extraTags: mirrorInput.extraTags,
            content: mirrorInput.content,
          });
        } catch (err) {
          mirrorError = errorText(err);
        }
      }
      return { actionId, receipt, mirrorError };
    },
    onSettled: () => {
      // Whether it landed or reverted, the onchain truth changed or will —
      // refetch the state gate rather than guessing from the receipt.
      void queryClient.invalidateQueries({ queryKey: ["launchpad", "gov"] });
    },
  });

  // A5: the turn-out watch — live tallies against the visible gates. The TTL
  // clock joins once the config read carries raw seconds; the vote math is
  // honest without it (never invented numbers).
  const talliesQuery = useQuery({
    queryKey: [
      "launchpad",
      "tallies",
      rpcUrl,
      daoBinding?.dao,
      proposal.proposalId,
    ],
    queryFn: () =>
      invokeTauri<EvmCallResult>("evm_call", {
        rpcUrl,
        to: daoBinding?.dao ?? "",
        data: encodeTalliesView(proposal.proposalId ?? "0x0"),
      }).then((result) => decodeTallies(result.returnData)),
    enabled: bound && proposal.kind === "plain" && Boolean(proposal.proposalId),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
  const watch =
    talliesQuery.data && govConfigQuery.data
      ? quorumWatch({
          tallies: talliesQuery.data,
          minYes:
            govConfigQuery.data.minYesAbsolute != null
              ? BigInt(govConfigQuery.data.minYesAbsolute)
              : null,
          ttlEndsAt: null,
          createdAt: BigInt(proposal.createdAt),
          now: BigInt(Math.floor(Date.now() / 1000)),
        })
      : null;

  const state = stateQuery.data ?? null;
  const actions = renderedActions({
    kind: proposal.kind,
    state,
    bound,
    hasOperation,
  });
  const receipts = proposalReceipts(launch.receipts, proposal);
  const actionLabel = action.data
    ? (PROPOSAL_ACTION_LABELS[action.data.actionId] ?? action.data.actionId)
    : "";

  // The agent-draft's counter-sign (persona-drafting-loop D5): the onchain id
  // is DERIVED offline (computeProposalId) from the draft's intent + the
  // DAO's live `config()` (bumpConfig invalidates; selector pinned to
  // `cast sig "config()"`) — nothing typed by hand, no id, no button.
  const isDraft = proposal.state === "agent-draft";
  const configQuery = useQuery({
    queryKey: [
      "launchpad",
      "gov",
      "config-bump",
      rpcUrl,
      daoBinding?.dao ?? "",
    ],
    queryFn: (): Promise<bigint | null> =>
      invokeTauri<EvmCallResult>("evm_call", {
        rpcUrl,
        to: daoBinding?.dao ?? "",
        data: "0x79502c55", // config() — `cast sig "config()"`
      })
        .then((result) => BigInt(result.returnData))
        .catch(() => null),
    enabled: Boolean(daoBinding),
    staleTime: 60_000,
  });
  const derivedId =
    isDraft &&
    proposal.intent &&
    daoBinding &&
    configQuery.data !== null &&
    configQuery.data !== undefined
      ? computeProposalId(daoBinding.dao, proposal.intent, configQuery.data)
      : null;

  const draftDispose = useMutation({
    mutationFn: async (mode: "approve" | "reject") => {
      if (mode === "approve") {
        if (!daoBinding || !proposal.intent || !derivedId || !proposal.source) {
          throw new Error("the draft cannot be counter-signed yet");
        }
        const call = buildProposalActionCall({
          dao: daoBinding.dao,
          proposalId: derivedId,
          action: "open",
          intent: proposal.intent,
        });
        const receipt = await invokeTauri<GovTxReceipt>(
          "evm_send_transaction",
          {
            rpcUrl,
            chainId,
            to: call.to,
            data: call.data,
            value: call.value ?? "0x0",
          },
        );
        if (receipt.status !== "success") {
          return { mode, done: false as const };
        }
        // D5: the accepted record supersedes the draft…
        await mirror.mutateAsync({
          kind: 47004, // KIND_LAUNCH_PROPOSAL (literal: the mirror kind union)
          author: launch.record.author,
          launchId: launch.record.id,
          extraTags: [
            ["wiki", proposal.source.page, String(proposal.source.anchor)],
          ],
          content: {
            proposalId: derivedId,
            kind: proposal.kind,
            issue: proposal.issue,
            state: "open",
            title: proposal.title,
            evidence: proposal.evidence,
            intent: proposal.intent,
          },
        });
      }
      // …then the draft is tombstoned (kind:5 `e` tag — never an `a` tag,
      // which would read as a launch deletion). The hash chain keeps the audit.
      await publishSignedEvent({
        kind: 5,
        content: "",
        tags: [["e", proposal.id]],
      });
      return { mode, done: true as const };
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["launchpad"] });
    },
  });

  return (
    <li
      className="rounded-2xl border border-border/70 bg-card/60 px-4 py-3"
      data-testid="proposal-card"
    >
      <div className="flex items-center gap-2">
        <span
          className={`rounded-full px-2 py-0.5 text-2xs font-medium uppercase tracking-wide ${KIND_STYLES[proposal.kind] ?? KIND_STYLES.plain}`}
        >
          {kindLabel(proposal.kind)}
        </span>
        <span className="text-2xs uppercase tracking-wide text-muted-foreground">
          {bound
            ? stateQuery.isPending
              ? "state: reading…"
              : stateQuery.isError
                ? "state: unread"
                : `state: ${state} (onchain)`
            : `state: ${proposal.state} (record)`}
        </span>
      </div>
      <h4 className="mt-1 text-sm font-semibold">{proposal.title}</h4>
      {proposal.issue ? (
        <p className="mt-1 font-mono text-2xs text-muted-foreground">
          Issue: {proposal.issue}
        </p>
      ) : null}
      {proposal.proposalId ? (
        <p className="mt-0.5 font-mono text-2xs text-muted-foreground">
          Onchain: {proposal.proposalId}
          {daoBinding ? ` · DAO ${truncatePubkey(daoBinding.dao)}` : ""}
        </p>
      ) : null}

      {/* The agent-draft's provenance + disposition (persona-drafting-loop D5):
          source block, verbatim evidence, then counter-sign or dispose. */}
      {isDraft ? (
        <section
          aria-label="Agent draft"
          className="mt-2 rounded-md bg-sky-500/5 px-2 py-1.5"
          data-testid="proposal-draft"
        >
          <p className="text-2xs text-muted-foreground">
            Agent draft · from wiki{" "}
            <span className="font-mono">
              {proposal.source
                ? `${proposal.source.page}#${proposal.source.anchor}`
                : "source omitted"}
            </span>{" "}
            — awaiting a human counter-sign; nothing broadcasts onchain without
            it.
          </p>
          {proposal.evidence ? (
            <p className="mt-1 border-l-2 border-sky-500/40 pl-2 text-2xs italic text-muted-foreground">
              “{proposal.evidence}”
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              data-testid="proposal-draft-approve"
              disabled={
                draftDispose.isPending ||
                !derivedId ||
                !wallet ||
                !proposal.source
              }
              onClick={() =>
                void draftDispose.mutateAsync("approve").catch(() => {})
              }
              size="sm"
              type="button"
            >
              {derivedId
                ? "Approve → open on-chain"
                : "Counter-sign needs the DAO config read"}
            </Button>
            <Button
              data-testid="proposal-draft-reject"
              disabled={draftDispose.isPending}
              onClick={() =>
                void draftDispose.mutateAsync("reject").catch(() => {})
              }
              size="sm"
              type="button"
              variant="outline"
            >
              Reject
            </Button>
          </div>
          {draftDispose.isError ? (
            <p className="mt-1 text-2xs text-destructive">
              {errorText(draftDispose.error)}
            </p>
          ) : null}
        </section>
      ) : null}

      {/* Litmus fact 1 — which mechanism decided this (D1 routing map). */}
      <section aria-label="Mechanism" className="mt-2">
        <p className="text-2xs">
          <span className="font-medium text-foreground">Mechanism:</span>{" "}
          {route.mechanism} — {route.why}
        </p>
        {route.note ? (
          <p className="mt-0.5 text-2xs text-muted-foreground">{route.note}</p>
        ) : null}
      </section>

      {/* Litmus fact 2 — who held what authority (D5). */}
      <section aria-label="Authority" className="mt-1.5">
        <p className="text-2xs">
          <span className="font-medium text-foreground">Authority:</span>{" "}
          {authorityLine({ proposer: proposal.author, grant: proposal.grant })}
        </p>
      </section>

      {/* Litmus fact 3 — where the receipts are (D4, the 47005 mirrors). */}
      <section aria-label="Receipts" className="mt-1.5">
        <p className="text-2xs">
          <span className="font-medium text-foreground">Receipts:</span>{" "}
          {RECEIPTS_VOCABULARY} — every action on this card mirrors its tx
          there.
        </p>
        {receipts.length > 0 ? (
          <ul className="mt-1 flex flex-col gap-0.5">
            {receipts.map((receipt) => (
              <li
                className="font-mono text-2xs text-muted-foreground"
                key={receipt.id}
              >
                {receipt.table}
                {receipt.vote ? ` · ${receipt.vote}` : ""} · tx{" "}
                {truncatePubkey(receipt.tx)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-0.5 text-2xs text-muted-foreground">
            No mirrors recorded for this proposal yet.
          </p>
        )}
      </section>

      {/* D6 — the exact majeur rules, in plain language before any vote. */}
      {proposal.kind === "plain" ? (
        <p
          className="mt-2 text-2xs text-muted-foreground"
          data-testid="proposal-quorum"
        >
          <span className="font-medium text-foreground">
            Passing rules (majeur):
          </span>{" "}
          {quorumSummary(govConfigQuery.data ?? null).join(" · ")}
        </p>
      ) : null}

      {/* A5 — the turn-out watch: quorum risk and the TTL clock, legible. */}
      {watch ? (
        <p
          className="mt-1 text-2xs text-muted-foreground"
          data-testid="quorum-watch"
          role="status"
        >
          <span
            className={`rounded-full px-2 py-0.5 text-2xs font-medium ${
              watch.status === "leading"
                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                : watch.status === "at-risk" || watch.status === "expired"
                  ? "bg-red-500/15 text-red-700 dark:text-red-300"
                  : "bg-amber-500/15 text-amber-700 dark:text-amber-300"
            }`}
          >
            {watch.status}
          </span>{" "}
          {watch.detail}
        </p>
      ) : null}

      {/* Actions: routed by kind, gated on state(id), D8 without a binding. */}
      <div className="mt-2">
        {!bound ? (
          <p
            className="text-2xs text-muted-foreground"
            data-testid="proposal-record-only"
          >
            {RECORD_ONLY_COPY}
          </p>
        ) : stateQuery.isPending ? (
          <p className="text-2xs text-muted-foreground" role="status">
            Reading the onchain state at {truncatePubkey(daoBinding?.dao ?? "")}
            …
          </p>
        ) : stateQuery.isError ? (
          <p className="text-2xs text-destructive" role="alert">
            Couldn&apos;t read the onchain state: {errorText(stateQuery.error)}.
            Actions stay gated on the state read — check the RPC endpoint, then
            try again.
          </p>
        ) : (
          <>
            {actions.length > 0 ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  {actions.map((actionId) => (
                    <Button
                      data-testid={`proposal-action-${actionId}`}
                      disabled={chainId === 0 || !wallet || action.isPending}
                      key={actionId}
                      onClick={() => action.mutate(actionId)}
                      size="sm"
                      type="button"
                      variant={actionId === "vote-for" ? "default" : "outline"}
                    >
                      {PROPOSAL_ACTION_LABELS[actionId] ?? actionId}
                    </Button>
                  ))}
                </div>
                <p className="mt-1 text-2xs text-muted-foreground">
                  {walletPending
                    ? "Checking wallet…"
                    : walletError
                      ? `Couldn't read wallet status: ${walletError}`
                      : wallet
                        ? `Sender: ${truncatePubkey(wallet)} — the wallet this app signs with.`
                        : "Create or import a wallet first — actions sign with the wallet this app holds. The Wallet card has both."}
                </p>
              </>
            ) : (
              <p className="text-2xs text-muted-foreground">
                {lifecycleNote(state ?? "Active", hasOperation)}
              </p>
            )}
            {action.data ? (
              action.data.receipt.status === "reverted" ? (
                <p className="mt-1 text-2xs text-destructive" role="alert">
                  {actionLabel} reverted onchain — nothing moved. Transaction{" "}
                  {truncatePubkey(action.data.receipt.txHash)}; the state read
                  above is the authority.
                </p>
              ) : (
                <p
                  className="mt-1 text-2xs text-muted-foreground"
                  role="status"
                >
                  {actionLabel} confirmed — transaction{" "}
                  {truncatePubkey(action.data.receipt.txHash)}
                  {action.data.mirrorError
                    ? ` · the 47005 mirror failed to publish (${action.data.mirrorError}) — the chain is the ledger; the receipt record will catch up on refetch.`
                    : " · mirrored to its kind:47005 receipt."}
                </p>
              )
            ) : null}
            {action.isError ? (
              <p className="mt-1 text-2xs text-destructive" role="alert">
                Couldn&apos;t send the transaction: {errorText(action.error)}.
              </p>
            ) : null}
          </>
        )}
      </div>

      {/* D2 — the dissent door, persistent on every card. */}
      <ProposalRagequitShortcut onOpen={() => onRagequit(daoBinding)} />
    </li>
  );
}

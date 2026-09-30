import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { TX_HASH_RE } from "../lib/milestone-receipt";
import {
  composeAcceptedRecord,
  composeRejectTombstone,
} from "../lib/draft-proposal";
import { launchCoordinate } from "../models";
import { publishMirror } from "../use-launches";
import {
  authorityLine,
  fetchProposalStates,
  governanceRoute,
  quorumSummary,
  RECEIPTS_COPY,
  RECORD_ONLY_COPY,
} from "../lib/governance-view";
import {
  computeProposalId,
  encodeCastVote,
  encodeExecuteByVotes,
  encodeOpenProposal,
  encodeQueue,
  encodeTalliesView,
  VOTE_ABSTAIN,
  VOTE_AGAINST,
  VOTE_FOR,
} from "../lib/vote-tx";
import { decodeTallies, quorumWatch } from "../lib/quorum-watch";
import { ethCall, getRpcEndpoint } from "../chain";
import { fetchDaoGovConfig } from "../lib/dao-gov-config";
import {
  resolveSender,
  senderErrorMessage,
  SenderPickerControls,
  useSenderPicker,
} from "./SenderPicker";

/** The proposal row shape this card renders (LaunchProposal's subset). */
export interface ProposalRow {
  id: string;
  author: string;
  createdAt: number;
  /** Launch identity for the accepted record's `a` tag (D5). */
  launchId: string;
  launchKey: string;
  proposalId: string | null;
  kind: "plain" | "futarchy-budget" | "signal";
  state: "open" | "passed" | "executed" | "defeated" | "agent-draft";
  title: string;
  issue: string | null;
  /** The agent-draft's verbatim justification (persona-drafting-loop D3/D8). */
  evidence?: string;
  /** The draft's source wiki block (`["wiki", page, anchor]`, D7/D8). */
  source?: { page: string; anchor: number };
  /** The `executeByVotes` intent; absent = execution stays record-only. */
  intent?: {
    op: 0 | 1;
    to: string;
    value: bigint | string;
    data: string;
    nonce: string;
  };
}

/**
 * The decision-routed proposal card (S2 of
 * `docs/agentic-governance-design.md`). The litmus test is the layout's
 * spine: a stranger must see WHICH MECHANISM, WHO/WHAT AUTHORITY, and WHERE
 * THE RECEIPTS ARE — with no tooltip — before any action is offered.
 */
export function ProposalCard({
  proposal,
  dao,
  displayName,
  onDissent,
}: {
  proposal: ProposalRow;
  /** The bound DAO (from `resolveDaoBinding`); null = not wired onchain. */
  dao: string | null;
  /** The proposer's resolved display name. */
  displayName: string;
  /** D2: the dissent door — every card can exit instead. */
  onDissent: () => void;
}) {
  const picker = useSenderPicker();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);

  const route = governanceRoute(proposal.kind);
  const bound = proposal.proposalId !== null && dao !== null;
  // Narrowed const so the execute action needs no non-null assertion.
  const executeIntent = proposal.intent;

  const liveState = useQuery({
    queryKey: ["proposal-state", getRpcEndpoint(), dao, proposal.proposalId],
    queryFn: () =>
      fetchProposalStates({
        endpoint: getRpcEndpoint(),
        dao: dao as string,
        ids: [proposal.proposalId as string],
      }),
    enabled: bound,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  // D6 with LIVE numbers (the honesty rule: chain reads win; unreadable
  // slots render as "per DAO config", never invented).
  const govConfig = useQuery({
    queryKey: ["dao-gov-config", getRpcEndpoint(), dao],
    queryFn: () => fetchDaoGovConfig(getRpcEndpoint(), dao as string),
    enabled: bound,
    staleTime: 300_000,
    refetchOnWindowFocus: false,
  });
  // A5: the turn-out watch — live tallies against the visible gates.
  const tallies = useQuery({
    queryKey: ["proposal-tallies", getRpcEndpoint(), dao, proposal.proposalId],
    queryFn: async () => {
      const raw = await ethCall(
        getRpcEndpoint(),
        dao as string,
        encodeTalliesView(proposal.proposalId as string),
      );
      return decodeTallies(raw);
    },
    enabled: bound && route.ballot,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
  const watch =
    tallies.data && govConfig.data
      ? quorumWatch({
          tallies: tallies.data,
          minYes:
            govConfig.data.minYes != null
              ? BigInt(govConfig.data.minYes)
              : null,
          ttlEndsAt:
            govConfig.data.proposalTtlSeconds != null
              ? BigInt(proposal.createdAt) + govConfig.data.proposalTtlSeconds
              : null,
          createdAt: BigInt(proposal.createdAt),
          now: BigInt(Math.floor(Date.now() / 1000)),
        })
      : null;
  const stateLabel = proposal.proposalId
    ? (liveState.data?.[proposal.proposalId] ?? "…")
    : null;

  // The agent-draft's counter-sign (persona-drafting-loop D5): the onchain
  // id is DERIVED offline from the draft's intent + the DAO's live `config`
  // (bumpConfig invalidates), so nothing is ever typed by hand. No derived
  // id, no counter-sign button — never a guessed hash.
  const isDraft = proposal.state === "agent-draft";
  const draftIntent = isDraft ? proposal.intent : undefined;
  const derivedId =
    draftIntent && dao !== null && govConfig.data?.config != null
      ? computeProposalId(dao, draftIntent, govConfig.data.config)
      : null;

  const approveDraft = async () => {
    if (!derivedId || !draftIntent || !proposal.source) return;
    setError(null);
    setPending(true);
    try {
      const sender = resolveSender(picker);
      const result = await sender.sendCalls([
        {
          to: dao as string,
          data: encodeOpenProposal(derivedId),
          value: "0x0",
        },
      ]);
      if (!TX_HASH_RE.test(result.txHash)) {
        throw new Error("The sender returned an invalid hash.");
      }
      setLastTx(result.txHash);
      // D5: the accepted record supersedes the draft, then the draft is
      // tombstoned — the hash chain keeps the audit.
      const accepted = composeAcceptedRecord(
        launchCoordinate(
          proposal.launchKey.split(":")[0] ?? "",
          proposal.launchId,
        ),
        proposal.source.page,
        {
          anchor: proposal.source.anchor,
          title: proposal.title,
          kind: proposal.kind,
          evidence: proposal.evidence ?? "",
          // The composer's wire form is the strict shape (value as decimal
          // string) — normalize here, never at the seams.
          intent: { ...draftIntent, value: String(draftIntent.value) },
        },
        derivedId,
      );
      await publishMirror({
        kind: accepted.kind,
        tags: accepted.tags,
        content: JSON.parse(accepted.content) as Record<string, unknown>,
      });
      const tombstone = composeRejectTombstone(proposal.id);
      await publishMirror(tombstone);
    } catch (err) {
      setError(senderErrorMessage(err, "The draft was not counter-signed."));
    } finally {
      setPending(false);
    }
  };

  const rejectDraft = async () => {
    setError(null);
    setPending(true);
    try {
      await publishMirror(composeRejectTombstone(proposal.id));
    } catch (err) {
      setError(senderErrorMessage(err, "The draft was not disposed."));
    } finally {
      setPending(false);
    }
  };

  const send = async (data: string) => {
    setError(null);
    setPending(true);
    try {
      const sender = resolveSender(picker);
      const result = await sender.sendCalls([
        { to: dao as string, data, value: "0x0" },
      ]);
      if (!TX_HASH_RE.test(result.txHash)) {
        throw new Error("The sender returned an invalid hash.");
      }
      setLastTx(result.txHash);
      void liveState.refetch();
    } catch (err) {
      setError(senderErrorMessage(err, "The governance action was not sent."));
    } finally {
      setPending(false);
    }
  };

  return (
    <Card className="p-4">
      {/* Litmus fact 1: which mechanism, and why that one (D1). */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {route.mechanism}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            proposal.state === "agent-draft"
              ? "bg-sky-500/15 text-sky-700 dark:text-sky-300"
              : proposal.state === "open"
                ? "bg-amber-500/15 text-amber-800 dark:text-amber-300"
                : proposal.state === "defeated"
                  ? "bg-red-500/15 text-red-800 dark:text-red-300"
                  : "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300"
          }`}
        >
          {proposal.state}
        </span>
        {proposal.proposalId ? (
          <span className="font-mono text-xs text-black/60 dark:text-white/60">
            #{proposal.proposalId.slice(0, 10)}
          </span>
        ) : null}
      </div>
      <h3 className="mt-1 text-sm font-semibold">{proposal.title}</h3>
      <p className="mt-1 text-xs text-black/60 dark:text-white/60">
        {route.rationale}
      </p>

      {/* Litmus fact 2: who acted, under what authority (D5). */}
      <p className="mt-1 text-xs text-black/60 dark:text-white/60">
        {authorityLine(displayName, null)}
      </p>

      {/* Litmus fact 3: where the receipts are (D4). */}
      <p className="mt-1 text-xs text-black/60 dark:text-white/60">
        {RECEIPTS_COPY}
        {lastTx ? ` · last tx ${lastTx.slice(0, 10)}…` : ""}
      </p>

      {/* D6: the rules, before anyone votes — live numbers when readable. */}
      {route.ballot ? (
        <p className="mt-2 rounded-md bg-black/5 px-2 py-1 text-xs text-black/70 dark:bg-white/5 dark:text-white/70">
          {quorumSummary(govConfig.data ?? {})}
        </p>
      ) : null}

      {/* A5: the turn-out watch — quorum risk and the TTL clock, legible. */}
      {watch ? (
        <p
          className="mt-1 text-xs text-black/60 dark:text-white/60"
          data-testid="quorum-watch"
          role="status"
        >
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              watch.status === "leading"
                ? "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300"
                : watch.status === "at-risk" || watch.status === "expired"
                  ? "bg-red-500/15 text-red-800 dark:text-red-300"
                  : "bg-amber-500/15 text-amber-800 dark:text-amber-300"
            }`}
          >
            {watch.status}
          </span>{" "}
          {watch.detail}
        </p>
      ) : null}

      {/* The agent-draft's provenance + disposition (persona-drafting-loop D5):
          source block and verbatim evidence, then counter-sign or dispose. */}
      {isDraft ? (
        <div className="mt-2 rounded-md bg-sky-500/5 px-2 py-1">
          <p className="text-xs text-black/70 dark:text-white/70">
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
            <p className="mt-1 border-l-2 border-sky-500/40 pl-2 text-xs italic text-black/70 dark:text-white/70">
              “{proposal.evidence}”
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              data-testid="proposal-draft-approve"
              disabled={pending || !derivedId}
              onClick={() => void approveDraft()}
              size="sm"
              type="button"
            >
              {derivedId
                ? "Approve → open on-chain"
                : "Counter-sign needs the DAO config read"}
            </Button>
            <Button
              data-testid="proposal-draft-reject"
              disabled={pending}
              onClick={() => void rejectDraft()}
              size="sm"
              type="button"
              variant="outline"
            >
              Reject
            </Button>
          </div>
        </div>
      ) : null}

      {!bound && !isDraft ? (
        <p
          className="mt-2 text-xs text-black/60 dark:text-white/60"
          role="status"
        >
          {RECORD_ONLY_COPY}
        </p>
      ) : null}

      {route.ballot && bound ? (
        <div className="mt-2">
          <SenderPickerControls
            state={picker}
            testIdPrefix={`proposal-${proposal.id}-`}
          />
          <div className="mt-1 flex flex-wrap gap-2">
            {stateLabel === "Unopened" ? (
              <Button
                data-testid="proposal-open"
                disabled={pending}
                onClick={() =>
                  void send(encodeOpenProposal(proposal.proposalId as string))
                }
                size="sm"
                type="button"
              >
                Open for voting
              </Button>
            ) : null}
            {stateLabel === "Active" ? (
              <>
                <Button
                  data-testid="proposal-vote-for"
                  disabled={pending}
                  onClick={() =>
                    void send(
                      encodeCastVote(proposal.proposalId as string, VOTE_FOR),
                    )
                  }
                  size="sm"
                  type="button"
                >
                  For
                </Button>
                <Button
                  data-testid="proposal-vote-against"
                  disabled={pending}
                  onClick={() =>
                    void send(
                      encodeCastVote(
                        proposal.proposalId as string,
                        VOTE_AGAINST,
                      ),
                    )
                  }
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Against
                </Button>
                <Button
                  data-testid="proposal-vote-abstain"
                  disabled={pending}
                  onClick={() =>
                    void send(
                      encodeCastVote(
                        proposal.proposalId as string,
                        VOTE_ABSTAIN,
                      ),
                    )
                  }
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Abstain
                </Button>
              </>
            ) : null}
            {stateLabel === "Succeeded" ? (
              <Button
                data-testid="proposal-queue"
                disabled={pending}
                onClick={() =>
                  void send(encodeQueue(proposal.proposalId as string))
                }
                size="sm"
                type="button"
              >
                Queue (start timelock)
              </Button>
            ) : null}
            {stateLabel === "Queued" ? (
              executeIntent ? (
                <Button
                  data-testid="proposal-execute"
                  disabled={pending}
                  onClick={() => void send(encodeExecuteByVotes(executeIntent))}
                  size="sm"
                  type="button"
                >
                  Execute (end timelock)
                </Button>
              ) : (
                <span className="text-xs text-black/60 dark:text-white/60">
                  In timelock — execution runs through the executor flow (`buzz
                  launchpad process`).
                </span>
              )
            ) : null}
          </div>
        </div>
      ) : null}

      {proposal.issue ? (
        <p className="mt-1 text-xs text-black/60 dark:text-white/60">
          Discussed in issue {proposal.issue.slice(0, 8)}
        </p>
      ) : null}

      {/* D2: the dissent door — always here. */}
      <div className="mt-2">
        <Button
          data-testid="proposal-dissent"
          onClick={onDissent}
          size="sm"
          type="button"
          variant="outline"
        >
          Disagree with the direction? Exit instead (ragequit)
        </Button>
      </div>

      {error ? (
        <p className="mt-1 text-xs text-red-700 dark:text-red-400" role="alert">
          {error}
        </p>
      ) : null}
    </Card>
  );
}

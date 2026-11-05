/**
 * The TrustGraph card — the gate, the published roots, and the graph.
 *
 * Own design (the objective allows it), built on the audited EVM/Nostr split:
 * live `TrustGatedHook` state (EVM), kind:37006 score-root records (Nostr),
 * the proofs bundle behind the record's `indexerUrl`, and the rotate-gate
 * rotation as one signed call. Honesty rules: unreadable reads say so, a
 * rebuilt root that disagrees with the published one is called contradicted,
 * and nothing here is inferred from a name — the graph is the Merkle tree
 * every consumer verifies the same way (`trust-score.ts` = the hook).
 *
 * The proofs bundle is loaded only when the reader asks (an explicit load,
 * re-read by pressing again), and the read is named by the signed record it
 * answers for — event id, root, and the pointer this app may follow — so a
 * fetch can never be answered for one publisher's record (or another
 * community's) with another's. Changing the epoch, or the list of records
 * changing under a choice, cancels the read and clears the approval.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";

import { ethCall, getRpcEndpoint } from "../chain";
import { viteEnv } from "../chain-config";
import { relayWsUrl } from "@/shared/lib/relay-url";
import {
  acceptedPublisherPolicy,
  scoreRootsQueryScope,
} from "../lib/score-root-policy";
import type { Launch, ScoreRoot } from "../models";
import { useScoreRoots } from "../use-launches";
import {
  decodeBytes32Word,
  decodeUintWord,
  encodeSetScoreRoot,
  parseBundleEntries,
  treeLevels,
  SELECTOR_MIN_SCORE,
  SELECTOR_SCORE_ROOT,
  type BundleEntry,
} from "@creaton/core/launchpad/trust-gate.ts";
import {
  resolveSender,
  senderErrorMessage,
  SenderPickerControls,
  useSenderPicker,
} from "./SenderPicker";
import { timedFetchStreamed } from "@/shared/lib/timed-fetch";

function shortHex(value: string): string {
  return value.length > 12 ? `${value.slice(0, 10)}…` : value;
}

export function TrustGateCard({ launch }: { launch: Launch }) {
  const hooks = launch.record.hooks;
  const [hookIndex, setHookIndex] = useState(0);
  const hook = hooks[hookIndex] ?? null;
  const roots = useScoreRoots();
  const [selectedId, setSelectedId] = useState("");
  const [minScoreInput, setMinScoreInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const picker = useSenderPicker();

  // Keyed by the node being asked as well as the hook: the same address on
  // another chain (or pointed at another node) is a different gate, and one
  // answer must never stand for both.
  const endpoint = getRpcEndpoint();
  const gate = useQuery({
    queryKey: ["trust-gate", endpoint ?? "", hook?.address ?? ""],
    queryFn: async () => {
      if (!hook || !endpoint) return null;
      const [rootData, minData] = await Promise.all([
        ethCall(endpoint, hook.address, SELECTOR_SCORE_ROOT),
        ethCall(endpoint, hook.address, SELECTOR_MIN_SCORE),
      ]);
      return {
        root: rootData ? decodeBytes32Word(rootData) : null,
        minScore: minData ? decodeUintWord(minData) : null,
      };
    },
    enabled: Boolean(hook),
    staleTime: 60_000,
  });

  const records: ScoreRoot[] = roots.data ?? [];
  const selected = records.find((r) => r.id === selectedId) ?? null;

  /**
   * The proofs are fetched only when the reader asks, and only for the epoch
   * they asked for. Nothing here loads on its own while a page opens: a remote
   * fetch that a reader never asked for is hidden anyway, and one keyed
   * loosely would be answered for another epoch. The query is keyed by the
   * community and accepted-publisher policy a read belongs to (the same
   * captured scope the roots read was keyed by, `lib/score-root-policy.ts` —
   * not hand-rolled here), then by the signed record's event id and the root
   * and the pointer it may follow: one cache slot answers for exactly one
   * record of one community under one policy, and the reader's own signal
   * cancels an in-flight read when the choice or the scope changes.
   */
  const [approval, setApproval] = useState<{
    id: string;
    scope: string;
  } | null>(null);
  // The same values the roots read was captured with, this render: the scope
  // string the bundle query keys by, so the cache cannot ignore the policy
  // the community accepted.
  const relay = relayWsUrl();
  const policy = acceptedPublisherPolicy({ relayUrl: relay, env: viteEnv() });
  const scope = scoreRootsQueryScope(relay, policy);
  const queryClient = useQueryClient();
  // The approval is bound to the scope it was given in: a signed record
  // cross-posted into another community (or a policy change) does not carry
  // it. The bundle query only runs for a record approved in this scope.
  const approved =
    selected && approval?.id === selected.id && approval.scope === scope
      ? selected
      : null;

  const bundle = useQuery({
    queryKey: [
      "trust-bundle",
      approved ? scope : "",
      approved?.id ?? "",
      approved?.root ?? "",
      approved?.proofUrl ?? "",
    ],
    queryFn: async ({ queryKey, signal }) => {
      const [, , recordId, root, proofUrl] = queryKey as [
        string,
        string,
        string,
        string,
        string,
      ];
      // The record still on the scoped list and agreeing with the key is the fetch target: not whatever is selected now, so an answer for one record cannot land in another's slot.
      const answer =
        records.find(
          (r) =>
            r.id === recordId && r.root === root && r.proofUrl === proofUrl,
        ) ?? null;
      if (!answer?.proofUrl) return null;
      const response = await timedFetchStreamed(answer.proofUrl, { signal });
      const body: unknown = await response.json();
      const proofs =
        body !== null && typeof body === "object"
          ? (body as Record<string, unknown>).proofs
          : null;
      return parseBundleEntries(proofs, answer.root);
    },
    enabled: Boolean(approved?.proofUrl),
    staleTime: 300_000,
    refetchOnWindowFocus: false, // the button re-reads; the page never does
  });

  const entries: BundleEntry[] = bundle.data ?? [];
  const tree = useMemo(() => treeLevels(entries), [entries]);

  // A scope change — the community (relay) or the accepted-publisher policy —
  // ends the world the choice was made in: the old scope's read is cancelled
  // (only that one), and both the approval and the selected epoch are
  // dropped, even if a record with the same id exists under the new scope.
  const previousScope = useRef(scope);
  useEffect(() => {
    const previous = previousScope.current;
    previousScope.current = scope;
    if (previous === scope) return;
    void queryClient.cancelQueries({ queryKey: ["trust-bundle", previous] });
    setApproval(null);
    setSelectedId("");
  }, [scope, queryClient]);

  // A choice also ends when its record leaves the scoped list; only the read
  // approved in this scope is cancelled.
  useEffect(() => {
    if (!selectedId) return;
    if (!records.some((r) => r.id === selectedId)) {
      void queryClient.cancelQueries({
        queryKey: ["trust-bundle", scope, selectedId],
      });
      setApproval(null);
      setSelectedId("");
    }
  }, [records, selectedId, scope, queryClient]);

  const chooseEpoch = (id: string) => {
    if (id === selectedId) return;
    if (approval) {
      // Only the read approved so far: a record approved under another scope
      // never had a read running, and this scope's other slots are idle.
      void queryClient.cancelQueries({
        queryKey: ["trust-bundle", approval.scope],
      });
    }
    setSelectedId(id);
    setApproval(null);
  };

  // The one way proofs are fetched: the reader loads the chosen epoch's
  // bundle in this scope (and asks again, by pressing again, to re-read it).
  const loadProofs = () => {
    if (!selected?.proofUrl) return;
    if (approval?.id === selected.id && approval.scope === scope)
      void bundle.refetch();
    else setApproval({ id: selected.id, scope });
  };

  // The honest verdicts: published root vs live gate, rebuilt root vs
  // published root. Contradicted is shown as contradicted.
  const gateMatches =
    gate.data?.root && selected
      ? gate.data.root === selected.root.toLowerCase()
      : null;
  const rebuiltMatches =
    tree && selected ? tree.root === selected.root.toLowerCase() : null;

  const rotate = async () => {
    if (!hook || !selected) return;
    setError(null);
    setPending(true);
    try {
      const minScore = BigInt(minScoreInput || "0");
      const data = encodeSetScoreRoot(selected.root, minScore);
      const sender = resolveSender(picker);
      const result = await sender.sendCalls([
        { to: hook.address, data, value: "0x0" },
      ]);
      setLastTx(result.txHash);
    } catch (err) {
      setError(senderErrorMessage(err, "The gate was not updated. Try again."));
    } finally {
      setPending(false);
    }
  };

  return (
    <Card className="p-4" data-testid="trust-gate-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">Trust gate</h3>
        <span
          className="text-xs text-black/60 dark:text-white/60"
          role="status"
        >
          {hook
            ? `bid group ${hook.bucket} · ${shortHex(hook.address)}`
            : "No trust gate is set up for this project yet"}
        </span>
      </div>

      <p className="mt-1 text-xs text-black/60 dark:text-white/60">
        A trust gate lets only people with a high enough score place bids. Each
        bid group has its own gate.
      </p>

      {!hook ? null : (
        <div className="mt-3 space-y-3 text-xs">
          {/* Live gate state (EVM). */}
          <section aria-label="Gate state">
            <h4 className="font-medium">Gate on the network</h4>
            {gate.isLoading ? (
              <p className="text-black/60 dark:text-white/60">reading…</p>
            ) : gate.data?.root ? (
              <p className="text-black/70 dark:text-white/70">
                Score list {shortHex(gate.data.root)} · minimum score{" "}
                {gate.data.minScore?.toString() ?? "could not be read"}
              </p>
            ) : (
              <p className="text-black/60 dark:text-white/60">
                Could not be read: the network did not answer. That is not the
                same as empty.
              </p>
            )}
            {hooks.length > 1 ? (
              <select
                aria-label="Gated bid group"
                className="mt-1 rounded-md border bg-transparent px-2 py-1"
                onChange={(event) => setHookIndex(Number(event.target.value))}
                value={hookIndex}
              >
                {hooks.map((h, index) => (
                  <option key={h.address + h.bucket} value={index}>
                    bid group {h.bucket}
                  </option>
                ))}
              </select>
            ) : null}
          </section>

          {/* Published roots (Nostr 37006) — dropdown of epochs, no hashes. */}
          <section aria-label="Published score lists">
            <h4 className="font-medium">Published score lists</h4>
            <select
              aria-label="Published score list"
              className="rounded-md border bg-transparent px-2 py-1"
              onChange={(event) => chooseEpoch(event.target.value)}
              value={selectedId}
            >
              <option value="">Choose a period…</option>
              {records.map((r) => (
                <option key={r.id} value={r.id}>
                  {`${r.program} · period ${r.epoch}${r.standing === "publisher-claim" ? " (publisher's own claim)" : ""}`}
                </option>
              ))}
            </select>
            {selected ? (
              <p className="mt-1 text-black/70 dark:text-white/70">
                score list {shortHex(selected.root)}
                {selected.anchorBlock != null
                  ? ` · the record says it was made at block ${selected.anchorBlock} (not checked against the network)`
                  : ""}
                {gateMatches === true
                  ? " · the gate on the network matches this list"
                  : gateMatches === false
                    ? " · CONTRADICTED: the network holds a different list"
                    : ""}
              </p>
            ) : (
              <p className="mt-1 text-black/60 dark:text-white/60">
                No score lists published yet. The scoring operator publishes one
                each period.
              </p>
            )}
            {selected && selected.standing === "publisher-claim" ? (
              <p className="mt-1 text-black/60 dark:text-white/60">
                This community has not named an accepted scoring publisher, so
                this record is shown as its publisher&apos;s own claim — not as
                the community&apos;s reputation.
              </p>
            ) : null}
          </section>

          {/* The graph: the roster + the Merkle tree every consumer verifies. */}
          <section aria-label="Check the scores">
            <h4 className="font-medium">Check the scores</h4>
            <p className="text-black/60 dark:text-white/60">
              An included score is proven to be in the list. That says nothing
              about how the scores were computed — only a working method read
              and its result checked would.
            </p>
            {!selected ? (
              <p className="text-black/60 dark:text-white/60">
                Choose a period, then load its proofs to check them against the
                published list.
              </p>
            ) : !selected.proofUrl ? (
              <p className="text-black/60 dark:text-white/60">
                This record has no link to its proofs, or the link is one this
                app will not load. Only the list's fingerprint is shared. The
                underlying data stays private.
              </p>
            ) : !approved ? (
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-black/60 dark:text-white/60">
                  The proofs live somewhere other than this workspace; the page
                  fetches them only when you ask.
                </p>
                <Button
                  data-testid="trust-gate-load-proofs"
                  onClick={loadProofs}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Load the proofs for this period
                </Button>
              </div>
            ) : bundle.isLoading ? (
              <p className="text-black/60 dark:text-white/60">
                Loading the proofs…
              </p>
            ) : entries.length === 0 ? (
              <>
                <p className="text-black/60 dark:text-white/60">
                  The proofs could not be read: their host did not answer, or
                  some entries were damaged and left out rather than guessed.
                </p>
                <Button
                  data-testid="trust-gate-reload-proofs"
                  onClick={loadProofs}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Read the proofs again
                </Button>
              </>
            ) : (
              <>
                <p className="text-black/70 dark:text-white/70">
                  {entries.length} scored members ·{" "}
                  {entries.filter((e) => e.verified).length} proofs verified
                  against the published list
                  {rebuiltMatches === false
                    ? " · CONTRADICTED: the list rebuilt from these proofs differs from the published one"
                    : rebuiltMatches === true
                      ? " · the list rebuilt from these proofs matches the published one"
                      : ""}
                </p>
                {tree ? (
                  <div
                    className="mt-1 space-y-1 overflow-x-auto"
                    data-testid="trust-graph-tree"
                  >
                    {[...tree.levels].reverse().map((level) => (
                      <div
                        className="flex gap-1"
                        key={`${level.length}-${level[0]}`}
                      >
                        {level.map((node) => (
                          <code
                            className="rounded bg-black/5 px-1 py-0.5 text-3xs dark:bg-white/10"
                            key={`${level.length}-${node}`}
                            title={node}
                          >
                            {shortHex(node)}
                          </code>
                        ))}
                      </div>
                    ))}
                  </div>
                ) : null}
                <ul className="mt-2 space-y-0.5">
                  {entries.map((entry) => (
                    <li
                      className="text-black/70 dark:text-white/70"
                      key={entry.member}
                    >
                      {shortHex(entry.member)} · score {entry.score} ·{" "}
                      {entry.verified ? "proven" : "unverified"}
                    </li>
                  ))}
                </ul>
                <Button
                  className="mt-2"
                  data-testid="trust-gate-reload-proofs"
                  onClick={loadProofs}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Read the proofs again
                </Button>
              </>
            )}
          </section>

          {/* Rotation (owner-only on chain — the call reverts otherwise). */}
          <section aria-label="Update the gate">
            <h4 className="font-medium">Update the gate</h4>
            <p className="text-black/60 dark:text-white/60">
              Owner only. Points the gate at the chosen period's score list and
              sets the minimum score.
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <input
                aria-label="Minimum score"
                className="w-28 rounded-md border bg-transparent px-2 py-1"
                onChange={(event) => setMinScoreInput(event.target.value)}
                placeholder={
                  gate.data?.minScore != null
                    ? gate.data.minScore.toString()
                    : "Minimum score"
                }
                type="text"
                value={minScoreInput}
              />
              <Button
                data-testid="trust-gate-rotate"
                disabled={!selected || pending}
                onClick={() => void rotate()}
                size="sm"
                type="button"
              >
                Update to period {selected?.epoch ?? "…"}
              </Button>
              <SenderPickerControls state={picker} testIdPrefix="trust-gate-" />
            </div>
            {lastTx ? (
              <p className="mt-1 text-black/70 dark:text-white/70">
                Updated · confirmation {shortHex(lastTx)}
              </p>
            ) : null}
            {error ? (
              <p className="mt-1 text-red-700 dark:text-red-300">{error}</p>
            ) : null}
          </section>
        </div>
      )}
    </Card>
  );
}

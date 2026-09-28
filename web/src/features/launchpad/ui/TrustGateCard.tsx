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
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";

import { ethCall, getRpcEndpoint } from "../chain";
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
} from "../lib/trust-gate";
import {
  resolveSender,
  senderErrorMessage,
  SenderPickerControls,
  useSenderPicker,
} from "./SenderPicker";

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

  const gate = useQuery({
    queryKey: ["trust-gate", hook?.address ?? ""],
    queryFn: async () => {
      const endpoint = getRpcEndpoint();
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

  const bundle = useQuery({
    queryKey: ["trust-bundle", selected?.id ?? ""],
    queryFn: async () => {
      if (!selected?.indexerUrl) return null;
      const response = await fetch(selected.indexerUrl);
      const body: unknown = await response.json();
      const proofs =
        body !== null && typeof body === "object"
          ? (body as Record<string, unknown>).proofs
          : null;
      return parseBundleEntries(proofs, selected.root);
    },
    enabled: Boolean(selected?.indexerUrl),
    staleTime: 300_000,
  });

  const entries: BundleEntry[] = bundle.data ?? [];
  const tree = useMemo(() => treeLevels(entries), [entries]);

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
      setError(senderErrorMessage(err, "The gate was not rotated."));
    } finally {
      setPending(false);
    }
  };

  return (
    <Card className="p-4" data-testid="trust-gate-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">Trust gate (TrustGraph)</h3>
        <span
          className="text-xs text-black/60 dark:text-white/60"
          role="status"
        >
          {hook
            ? `bucket ${hook.bucket} · ${shortHex(hook.address)}`
            : "no hook wired on this launch (pre-launch)"}
        </span>
      </div>

      {!hook ? null : (
        <div className="mt-3 space-y-3 text-xs">
          {/* Live gate state (EVM). */}
          <section aria-label="Gate state">
            <h4 className="font-medium">Gate on-chain</h4>
            {gate.isLoading ? (
              <p className="text-black/60 dark:text-white/60">reading…</p>
            ) : gate.data?.root ? (
              <p className="text-black/70 dark:text-white/70">
                scoreRoot {shortHex(gate.data.root)} · minScore{" "}
                {gate.data.minScore?.toString() ?? "unreadable"}
              </p>
            ) : (
              <p className="text-black/60 dark:text-white/60">
                unreadable — the RPC did not answer (not the same as empty)
              </p>
            )}
            {hooks.length > 1 ? (
              <select
                aria-label="Gated bucket"
                className="mt-1 rounded-md border bg-transparent px-2 py-1"
                onChange={(event) => setHookIndex(Number(event.target.value))}
                value={hookIndex}
              >
                {hooks.map((h, index) => (
                  <option key={h.address + h.bucket} value={index}>
                    bucket {h.bucket}
                  </option>
                ))}
              </select>
            ) : null}
          </section>

          {/* Published roots (Nostr 37006) — dropdown of epochs, no hashes. */}
          <section aria-label="Published roots">
            <h4 className="font-medium">Published score roots</h4>
            <select
              aria-label="Score root record"
              className="rounded-md border bg-transparent px-2 py-1"
              onChange={(event) => setSelectedId(event.target.value)}
              value={selectedId}
            >
              <option value="">Choose an epoch…</option>
              {records.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.program} · epoch {r.epoch}
                </option>
              ))}
            </select>
            {selected ? (
              <p className="mt-1 text-black/70 dark:text-white/70">
                root {shortHex(selected.root)}
                {selected.anchorBlock != null
                  ? ` · anchored at block ${selected.anchorBlock}`
                  : ""}
                {gateMatches === true
                  ? " · the gate on-chain matches this root"
                  : gateMatches === false
                    ? " · CONTRADICTED — the chain holds a different root"
                    : ""}
              </p>
            ) : (
              <p className="mt-1 text-black/60 dark:text-white/60">
                no score-root records yet (the scoring operator publishes one
                per epoch)
              </p>
            )}
          </section>

          {/* The graph: the roster + the Merkle tree every consumer verifies. */}
          <section aria-label="Trust graph">
            <h4 className="font-medium">The graph</h4>
            {!selected ? (
              <p className="text-black/60 dark:text-white/60">
                choose an epoch to load its proofs bundle
              </p>
            ) : !selected.indexerUrl ? (
              <p className="text-black/60 dark:text-white/60">
                this record carries no proofs pointer — only the root ships, the
                workspace data stays private
              </p>
            ) : bundle.isLoading ? (
              <p className="text-black/60 dark:text-white/60">
                fetching the proofs bundle…
              </p>
            ) : entries.length === 0 ? (
              <p className="text-black/60 dark:text-white/60">
                unreadable bundle — the indexer did not answer or the entries
                were malformed (dropped, never guessed)
              </p>
            ) : (
              <>
                <p className="text-black/70 dark:text-white/70">
                  {entries.length} scored members ·{" "}
                  {entries.filter((e) => e.verified).length} proofs verified
                  against the root
                  {rebuiltMatches === false
                    ? " · CONTRADICTED — the rebuilt root differs from the published one"
                    : rebuiltMatches === true
                      ? " · rebuilt root matches the published root"
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
              </>
            )}
          </section>

          {/* Rotation (owner-only on chain — the call reverts otherwise). */}
          <section aria-label="Rotate gate">
            <h4 className="font-medium">Rotate gate</h4>
            <p className="text-black/60 dark:text-white/60">
              One call, owner-only: `setScoreRoot(root, minScore)` to the
              selected epoch's root.
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <input
                aria-label="minScore"
                className="w-28 rounded-md border bg-transparent px-2 py-1"
                onChange={(event) => setMinScoreInput(event.target.value)}
                placeholder={
                  gate.data?.minScore != null
                    ? gate.data.minScore.toString()
                    : "minScore"
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
                Rotate to epoch {selected?.epoch ?? "…"}
              </Button>
              <SenderPickerControls state={picker} testIdPrefix="trust-gate-" />
            </div>
            {lastTx ? (
              <p className="mt-1 text-black/70 dark:text-white/70">
                rotated · {shortHex(lastTx)}
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

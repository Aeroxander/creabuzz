/**
 * The TrustGraph card — desktop twin of web's `TrustGateCard`: gate state
 * (EVM), kind:37006 score-root records (Nostr), the proofs bundle behind the
 * record's `indexerUrl`, the Merkle graph every consumer verifies the same
 * way (`trustScore.ts` = `TrustGatedHook.validate`), and the rotate-gate
 * rotation as one signed call. Unreadable reads say so; a rebuilt root that
 * disagrees with the published one is called contradicted.
 */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { relayClient } from "@/shared/api/relayClient";
import { invokeTauri } from "@/shared/api/tauri";
import { KIND_SCORE_ROOT } from "@/shared/constants/kinds";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";

import { getRpcEndpoint } from "@/features/launchpad/lib/chainRpc";
import { getCachedRelayOrigin } from "@/shared/lib/mediaUrl";
import type { Launch } from "@/features/launchpad/launchpadModels";
import {
  decodeBytes32Word,
  decodeUintWord,
  encodeSetScoreRoot,
  parseBundleEntries,
  parseScoreRootRecord,
  treeLevels,
  SELECTOR_MIN_SCORE,
  SELECTOR_SCORE_ROOT,
  type BundleEntry,
  type ScoreRootRecord,
} from "@/features/launchpad/lib/trustGate";
import { useEvmChainStatusQuery } from "@/features/launchpad/mintHooks";
import { useWalletStatusQuery } from "@/features/launchpad/walletHooks";

/** `evm_call()` result (the shared IPC shape in `mintHooks.ts`). */
interface EvmCallResult {
  returnData: string;
}

/** `evm_send_transaction` reply (the `MintTxReceipt` shape). */
interface RotateReceipt {
  txHash: string;
  status: "success" | "reverted";
}

function shortHex(value: string): string {
  return value.length > 12 ? `${value.slice(0, 10)}…` : value;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function TrustGateCard({ launch }: { launch: Launch }) {
  const rpcUrl = React.useMemo(
    () => getRpcEndpoint(getCachedRelayOrigin()),
    [],
  );
  const hooks = launch.record.hooks;
  const [hookIndex, setHookIndex] = React.useState(0);
  const hook = hooks[hookIndex] ?? null;
  const [selectedId, setSelectedId] = React.useState("");
  const [minScoreInput, setMinScoreInput] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [lastTx, setLastTx] = React.useState<string | null>(null);
  const [rotating, setRotating] = React.useState(false);

  const walletQuery = useWalletStatusQuery();
  const wallet =
    walletQuery.data?.hasWallet && walletQuery.data.address
      ? walletQuery.data.address
      : null;
  const chainQuery = useEvmChainStatusQuery(rpcUrl, true);
  const chainId = chainQuery.data?.chainId ?? 0;

  const gate = useQuery({
    queryKey: ["trust-gate", rpcUrl, hook?.address ?? ""],
    queryFn: async () => {
      if (!hook) return null;
      const [rootData, minData] = await Promise.all([
        invokeTauri<EvmCallResult>("evm_call", {
          rpcUrl,
          to: hook.address,
          data: SELECTOR_SCORE_ROOT,
        }),
        invokeTauri<EvmCallResult>("evm_call", {
          rpcUrl,
          to: hook.address,
          data: SELECTOR_MIN_SCORE,
        }),
      ]);
      return {
        root: decodeBytes32Word(rootData.returnData),
        minScore: decodeUintWord(minData.returnData),
      };
    },
    enabled: Boolean(hook),
    staleTime: 60_000,
  });

  const roots = useQuery({
    queryKey: ["score-roots"],
    queryFn: async (): Promise<ScoreRootRecord[]> => {
      const events = await relayClient.fetchEvents({
        kinds: [KIND_SCORE_ROOT],
        limit: 200,
      });
      return events
        .map((event) => parseScoreRootRecord(event))
        .filter((r): r is ScoreRootRecord => r !== null);
    },
    staleTime: 60_000,
  });

  const records = roots.data ?? [];
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
  const tree = React.useMemo(() => treeLevels(entries), [entries]);
  const gateMatches =
    gate.data?.root && selected
      ? gate.data.root === selected.root.toLowerCase()
      : null;
  const rebuiltMatches =
    tree && selected ? tree.root === selected.root.toLowerCase() : null;

  const rotate = async () => {
    if (!hook || !selected || !wallet) return;
    setError(null);
    setRotating(true);
    try {
      const minScore = BigInt(minScoreInput || "0");
      const data = encodeSetScoreRoot(selected.root, minScore);
      const receipt = await invokeTauri<RotateReceipt>("evm_send_transaction", {
        rpcUrl,
        chainId,
        to: hook.address,
        data,
        value: "0x0",
      });
      if (receipt.status === "success") setLastTx(receipt.txHash);
      else
        setError(
          "The rotation reverted (the wallet is likely not the hook's owner).",
        );
    } catch (err) {
      setError(errorText(err));
    } finally {
      setRotating(false);
    }
  };

  return (
    <Card className="p-4" data-testid="trust-gate-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">Trust gate (TrustGraph)</h3>
        <span className="text-2xs text-muted-foreground" role="status">
          {hook
            ? `bucket ${hook.bucket} · ${shortHex(hook.address)}`
            : "no hook wired on this launch (pre-launch)"}
        </span>
      </div>

      {!hook ? null : (
        <div className="mt-3 space-y-3 text-2xs">
          {/* Live gate state (EVM). */}
          <section aria-label="Gate state">
            <h4 className="font-medium">Gate on-chain</h4>
            {gate.isLoading ? (
              <p className="text-muted-foreground">reading…</p>
            ) : gate.data?.root ? (
              <p className="text-muted-foreground">
                scoreRoot {shortHex(gate.data.root)} · minScore{" "}
                {gate.data.minScore?.toString() ?? "unreadable"}
              </p>
            ) : (
              <p className="text-muted-foreground">
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
              <p className="mt-1 text-muted-foreground">
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
              <p className="mt-1 text-muted-foreground">
                no score-root records yet (the scoring operator publishes one
                per epoch)
              </p>
            )}
          </section>

          {/* The graph: the roster + the Merkle tree every consumer verifies. */}
          <section aria-label="Trust graph">
            <h4 className="font-medium">The graph</h4>
            {!selected ? (
              <p className="text-muted-foreground">
                choose an epoch to load its proofs bundle
              </p>
            ) : !selected.indexerUrl ? (
              <p className="text-muted-foreground">
                this record carries no proofs pointer — only the root ships, the
                workspace data stays private
              </p>
            ) : bundle.isLoading ? (
              <p className="text-muted-foreground">
                fetching the proofs bundle…
              </p>
            ) : entries.length === 0 ? (
              <p className="text-muted-foreground">
                unreadable bundle — the indexer did not answer or the entries
                were malformed (dropped, never guessed)
              </p>
            ) : (
              <>
                <p className="text-muted-foreground">
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
                            className="rounded bg-muted px-1 py-0.5 font-mono text-3xs"
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
                    <li className="text-muted-foreground" key={entry.member}>
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
            <p className="text-muted-foreground">
              One call, owner-only: setScoreRoot(root, minScore) to the selected
              epoch's root.
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
                disabled={!selected || rotating || !wallet}
                onClick={() => void rotate()}
                size="sm"
                type="button"
              >
                {rotating
                  ? "Rotating…"
                  : `Rotate to epoch ${selected?.epoch ?? "…"}`}
              </Button>
            </div>
            {lastTx ? (
              <p className="mt-1 text-muted-foreground">
                rotated · {shortHex(lastTx)}
              </p>
            ) : null}
            {error ? <p className="mt-1 text-destructive">{error}</p> : null}
          </section>
        </div>
      )}
    </Card>
  );
}

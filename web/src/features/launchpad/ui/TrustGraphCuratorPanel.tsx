import { useState } from "react";

import { SignRecovery } from "@/features/identity/ui/SignRecovery";
import { KIND_SCORE_ROOT } from "@/shared/constants/kinds";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { Input } from "@/shared/ui/input";

import { encodeSetScoreRoot } from "../lib/trust-gate";
import {
  composeRootBundle,
  DEFAULT_PROGRAM,
  type RootBundle,
  scoreRootEventParts,
} from "../lib/trustgraph-root";
import { publishMirror } from "../use-launches";
import {
  resolveSender,
  SenderPickerControls,
  senderErrorMessage,
  useSenderPicker,
} from "./SenderPicker";

type PublishPhase = "idle" | "confirm" | "publishing" | "published";
type RotatePhase = "idle" | "confirm" | "sending" | "sent";

const SCORES_PLACEHOLDER = `[{"member": "0x0000000000000000000000000000000000000001", "score": 80}]`;

/**
 * The scoring-operator workspace (the `buzz trustgraph` flow, in the UI):
 * compose a scores set into its score root, publish the root for an epoch,
 * and rotate the onchain gate to it. Each publishing step is a two-step
 * confirm — a wrong root or a wrong gate is expensive to unwind — and every
 * failure keeps the action armed with its recovery affordance (never a dead
 * end, Review-Proven Rule 1).
 */
export function TrustGraphCuratorPanel() {
  // ── compose inputs ────────────────────────────────────────────────────────
  const [epoch, setEpoch] = useState("");
  const [scoresText, setScoresText] = useState("");
  const [indexerUrl, setIndexerUrl] = useState("");
  const [anchorBlock, setAnchorBlock] = useState("");
  const [program, setProgram] = useState(DEFAULT_PROGRAM);
  const [bundle, setBundle] = useState<RootBundle | null>(null);
  const [composeError, setComposeError] = useState<string | null>(null);
  const [composeStatus, setComposeStatus] = useState<string | null>(null);

  // ── publish machine ───────────────────────────────────────────────────────
  const [publishPhase, setPublishPhase] = useState<PublishPhase>("idle");
  const [publishStatus, setPublishStatus] = useState<string | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);

  // ── gate rotation machine ─────────────────────────────────────────────────
  const sender = useSenderPicker();
  const [gateRoot, setGateRoot] = useState("");
  const [hookAddress, setHookAddress] = useState("");
  const [minScore, setMinScore] = useState("0");
  const [rotatePhase, setRotatePhase] = useState<RotatePhase>("idle");
  const [rotateStatus, setRotateStatus] = useState<string | null>(null);
  const [rotateError, setRotateError] = useState<string | null>(null);

  const memberCount = bundle ? Object.keys(bundle.proofs).length : 0;

  const compose = () => {
    setComposeError(null);
    setComposeStatus(null);
    setBundle(null);
    setPublishPhase("idle");
    setPublishStatus(null);
    setPublishError(null);
    try {
      const raw: unknown = JSON.parse(scoresText);
      if (!Array.isArray(raw)) {
        throw new Error(
          "Scores must be a list of {member, score} pairs, like the example.",
        );
      }
      const scores = raw.map((row) => {
        const entry = row as { member?: unknown; score?: unknown };
        if (
          typeof entry.member !== "string" ||
          typeof entry.score !== "number"
        ) {
          throw new Error(
            "Scores must be a list of {member, score} pairs, like the example.",
          );
        }
        return { member: entry.member, score: entry.score };
      });
      const anchor =
        anchorBlock.trim() === "" ? null : Number(anchorBlock.trim());
      if (anchor !== null && !Number.isSafeInteger(anchor)) {
        throw new Error("The anchor block must be a whole block number.");
      }
      const built = composeRootBundle({
        scores,
        program,
        epoch: epoch.trim(),
        indexerUrl: indexerUrl.trim() === "" ? null : indexerUrl.trim(),
        anchorBlock: anchor,
      });
      setBundle(built);
      setGateRoot(built.root);
      setComposeStatus(
        `Score root composed for epoch ${built.epoch} — ${Object.keys(built.proofs).length} member${Object.keys(built.proofs).length === 1 ? "" : "s"}, every proof verified.`,
      );
    } catch (err) {
      setComposeError(
        err instanceof Error
          ? err.message
          : "The scores could not be composed.",
      );
    }
  };

  const publish = async () => {
    if (!bundle) return;
    setPublishPhase("publishing");
    setPublishError(null);
    setPublishStatus(null);
    try {
      const parts = scoreRootEventParts(bundle);
      await publishMirror({
        kind: KIND_SCORE_ROOT,
        tags: parts.extraTags,
        content: parts.content,
      });
      setPublishPhase("published");
      setPublishStatus(`Score root published for epoch ${bundle.epoch}.`);
    } catch (err) {
      // The record is replaceable per epoch — a retry replaces, never
      // duplicates, so the confirm stays armed with a way out.
      setPublishPhase("confirm");
      setPublishError(
        `${err instanceof Error ? err.message : "The score root was not published."} You can publish again — the record is replaced, not duplicated.`,
      );
    }
  };

  const rotate = async () => {
    setRotatePhase("sending");
    setRotateError(null);
    setRotateStatus(null);
    try {
      const data = encodeSetScoreRoot(gateRoot.trim(), BigInt(minScore.trim()));
      const call = { to: hookAddress.trim(), data, value: "0x0" };
      const result = await resolveSender(sender).sendCalls([call]);
      setRotatePhase("sent");
      setRotateStatus(
        `Gate rotated to ${gateRoot.trim().slice(0, 10)}… — transaction ${result.txHash}.`,
      );
    } catch (err) {
      setRotatePhase("confirm");
      setRotateError(
        `${senderErrorMessage(err, "The gate was not rotated.")} You can send the rotation again — check the gate address first.`,
      );
    }
  };

  const hookLooksValid = /^0x[0-9a-fA-F]{40}$/.test(hookAddress.trim());
  const minScoreLooksValid = /^\d+$/.test(minScore.trim());
  const rootLooksValid = /^0x[0-9a-fA-F]{64}$/.test(gateRoot.trim());

  return (
    <Card className="p-4" data-testid="trustgraph-curator">
      <h2 className="text-base font-semibold">TrustGraph scores</h2>
      <p className="mt-1 text-sm text-black/60 dark:text-white/60">
        Compose this community&apos;s score root from a scores set, publish it
        for an epoch, and rotate the onchain gate to the new root. Publishing
        writes a signed record; the gate rotation is an onchain action the gate
        owner confirms before it sends. Each step shows its result here.
      </p>

      {/* ── compose ──────────────────────────────────────────────────────── */}
      <div className="mt-3 flex flex-col gap-2">
        <div>
          <label className="text-sm font-medium" htmlFor="trustgraph-epoch">
            Epoch
          </label>
          <Input
            data-testid="trustgraph-epoch"
            id="trustgraph-epoch"
            onChange={(e) => setEpoch(e.target.value)}
            placeholder="12"
            value={epoch}
          />
        </div>
        <div>
          <label className="text-sm font-medium" htmlFor="trustgraph-scores">
            Scores
          </label>
          <textarea
            className="mt-1 min-h-24 w-full rounded-md border border-black/15 bg-transparent px-2 py-1.5 font-mono text-sm dark:border-white/15"
            data-testid="trustgraph-scores"
            id="trustgraph-scores"
            onChange={(e) => setScoresText(e.target.value)}
            placeholder={SCORES_PLACEHOLDER}
            value={scoresText}
          />
          <p className="mt-1 text-xs text-black/60 dark:text-white/60">
            One member and score per row, in the format shown. The scores stay
            private — only the proof-backed root is published.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="min-w-40 grow">
            <label className="text-sm font-medium" htmlFor="trustgraph-indexer">
              Proofs location (optional)
            </label>
            <Input
              data-testid="trustgraph-indexer"
              id="trustgraph-indexer"
              onChange={(e) => setIndexerUrl(e.target.value)}
              placeholder="https://…"
              value={indexerUrl}
            />
          </div>
          <div className="min-w-40 grow">
            <label className="text-sm font-medium" htmlFor="trustgraph-anchor">
              Anchor block (optional)
            </label>
            <Input
              data-testid="trustgraph-anchor"
              id="trustgraph-anchor"
              onChange={(e) => setAnchorBlock(e.target.value)}
              placeholder="192"
              value={anchorBlock}
            />
          </div>
        </div>
        <div>
          <Button
            data-testid="trustgraph-compose"
            disabled={epoch.trim() === "" || scoresText.trim() === ""}
            onClick={compose}
            size="sm"
            type="button"
          >
            Compose score root
          </Button>
        </div>
        {composeStatus ? (
          <p
            className="text-sm text-emerald-700 dark:text-emerald-400"
            role="status"
          >
            <span data-testid="trustgraph-compose-status">{composeStatus}</span>
          </p>
        ) : null}
        {composeError ? (
          <div role="alert">
            <SignRecovery
              message={composeError}
              messageTestId="trustgraph-error"
              testId="trustgraph-sign-recovery"
            />
          </div>
        ) : null}
      </div>

      {/* ── technical details ────────────────────────────────────────────── */}
      {bundle ? (
        <details
          className="mt-3 rounded-xl border border-black/15 px-3 py-2 dark:border-white/15"
          data-testid="trustgraph-technical"
        >
          <summary className="cursor-pointer text-sm font-medium select-none text-black dark:text-white">
            Technical details
          </summary>
          <div className="mt-2 flex flex-col gap-2 text-xs">
            <div>
              <label className="font-medium" htmlFor="trustgraph-program">
                Program
              </label>
              <Input
                data-testid="trustgraph-program"
                id="trustgraph-program"
                onChange={(e) => setProgram(e.target.value)}
                value={program}
              />
            </div>
            <p className="font-mono text-black/70 dark:text-white/70">
              root: {bundle.root}
            </p>
            <p className="text-black/60 dark:text-white/60">
              {memberCount} member proof{memberCount === 1 ? "" : "s"} —
              published as the score-root record (event 37006), replaceable per
              epoch.
            </p>
            <pre className="max-h-48 overflow-auto rounded-md border border-black/15 p-2 font-mono text-3xs dark:border-white/15">
              {JSON.stringify(bundle.proofs, null, 2)}
            </pre>
          </div>
        </details>
      ) : null}

      {/* ── publish ──────────────────────────────────────────────────────── */}
      {bundle ? (
        <div className="mt-3 flex flex-col gap-2">
          {publishPhase === "confirm" ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-black/70 dark:text-white/70">
                Publish this score root for epoch {bundle.epoch}?
              </span>
              <Button
                data-testid="trustgraph-publish-confirm"
                onClick={() => void publish()}
                size="sm"
                type="button"
              >
                Confirm publish
              </Button>
              <Button
                data-testid="trustgraph-publish-cancel"
                onClick={() => setPublishPhase("idle")}
                size="sm"
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
            </div>
          ) : (
            <div>
              <Button
                data-testid="trustgraph-publish"
                disabled={publishPhase === "publishing"}
                onClick={() => {
                  setPublishError(null);
                  setPublishPhase("confirm");
                }}
                size="sm"
                type="button"
              >
                Publish score root
              </Button>
            </div>
          )}
          {publishStatus ? (
            <p
              className="text-sm text-emerald-700 dark:text-emerald-400"
              role="status"
            >
              <span data-testid="trustgraph-publish-status">
                {publishStatus}
              </span>
            </p>
          ) : null}
          {publishError ? (
            <div role="alert">
              <SignRecovery
                message={publishError}
                messageTestId="trustgraph-error"
                testId="trustgraph-sign-recovery"
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ── gate rotation ───────────────────────────────────────────────── */}
      <div className="mt-4 border-t border-black/10 pt-3 dark:border-white/10">
        <h3 className="text-sm font-semibold">Gate rotation</h3>
        <p className="mt-1 text-xs text-black/60 dark:text-white/60">
          Rotating points the onchain gate at a new score root and minimum
          score. The gate owner&apos;s wallet sends this — you confirm before it
          goes.
        </p>
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <div className="min-w-40 grow">
              <label
                className="text-sm font-medium"
                htmlFor="trustgraph-gate-root"
              >
                Gate root
              </label>
              <Input
                data-testid="trustgraph-gate-root"
                id="trustgraph-gate-root"
                onChange={(e) => setGateRoot(e.target.value)}
                placeholder="0x + 64 hex — filled in when you compose"
                value={gateRoot}
              />
            </div>
            <div className="min-w-40 grow">
              <label
                className="text-sm font-medium"
                htmlFor="trustgraph-min-score"
              >
                Minimum score
              </label>
              <Input
                data-testid="trustgraph-min-score"
                id="trustgraph-min-score"
                onChange={(e) => setMinScore(e.target.value)}
                value={minScore}
              />
            </div>
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="trustgraph-hook">
              Gate contract address
            </label>
            <Input
              data-testid="trustgraph-hook"
              id="trustgraph-hook"
              onChange={(e) => setHookAddress(e.target.value)}
              placeholder="0x…"
              value={hookAddress}
            />
          </div>
          <SenderPickerControls state={sender} testIdPrefix="trustgraph-" />
          {rotatePhase === "confirm" ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-black/70 dark:text-white/70">
                Rotate the gate to {gateRoot.trim().slice(0, 10)}… at minimum
                score {minScore.trim()}?
              </span>
              <Button
                data-testid="trustgraph-rotate-confirm"
                onClick={() => void rotate()}
                size="sm"
                type="button"
              >
                Confirm rotation
              </Button>
              <Button
                data-testid="trustgraph-rotate-cancel"
                onClick={() => setRotatePhase("idle")}
                size="sm"
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
            </div>
          ) : (
            <div>
              <Button
                data-testid="trustgraph-rotate"
                disabled={
                  !hookLooksValid || !minScoreLooksValid || !rootLooksValid
                }
                onClick={() => {
                  setRotateError(null);
                  setRotatePhase("confirm");
                }}
                size="sm"
                type="button"
                variant="outline"
              >
                Rotate gate
              </Button>
            </div>
          )}
          {rotateStatus ? (
            <p
              className="text-sm text-emerald-700 dark:text-emerald-400"
              role="status"
            >
              <span data-testid="trustgraph-rotate-status">{rotateStatus}</span>
            </p>
          ) : null}
          {rotateError ? (
            <div role="alert">
              <SignRecovery
                message={rotateError}
                messageTestId="trustgraph-error"
                testId="trustgraph-sign-recovery"
              />
            </div>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

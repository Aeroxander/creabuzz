import * as React from "react";

import {
  BookOpen,
  Check,
  Copy,
  FileJson,
  Play,
  RefreshCw,
  Sparkles,
} from "lucide-react";

import { copyTextToClipboard } from "@/shared/lib/clipboard";
import { cn } from "@/shared/lib/cn";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { EmptyState } from "@/shared/ui/EmptyState";
import { Markdown } from "@/shared/ui/markdown";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/shared/ui/sheet";
import { Spinner } from "@/shared/ui/spinner";
import { Textarea } from "@/shared/ui/textarea";

import {
  useOrgNodesQuery,
  useTeamReflectMutation,
  useTeamRunMutation,
  useTeamRunsQuery,
  useTeamStrategiesQuery,
  useTeamTurnsQuery,
  type TeamReflectResult,
} from "../hooks";
import { relativeTimeLabel } from "../lib/dashboard";
import {
  groupTurnsByPhase,
  groupTurnsByRun,
  lineageLabel,
  strategyRevisions,
  type RunTranscriptRow,
  type TeamRun,
  type TeamStrategy,
  type TeamTurn,
} from "../lib/teamTypes";
import { OrgEntityPicker, type OrgPickerOption } from "./OrgEntityPicker";

/** Runs can take minutes — labeled honestly, never a bare spinner. */
const RUN_PROGRESS_LABEL =
  "Conducting the strategy's phases — this runs several LLM turns and can take a few minutes";

const SEED_HINT = "buzz team strategies seed-examples --publish";

type TranscriptTurn = {
  phase: number;
  agentSlot: string;
  content: string;
  tokens: number;
  pubkey: string | null;
};

function statusPillClass(status: string): string {
  // §5 color semantics: green = done/healthy, gray = neutral terminal.
  if (status === "complete") {
    return "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300";
  }
  return "bg-muted text-muted-foreground";
}

function ProblemSnippet({ problem }: { problem: string }) {
  const snippet = problem.length > 120 ? `${problem.slice(0, 120)}…` : problem;
  return (
    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
      {snippet}
    </span>
  );
}

function LineageChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-sm border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">
      <GitBranchIcon />
      {label}
    </span>
  );
}

function GitBranchIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-3 w-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M6 3v12" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

// ── Run strategy dialog ───────────────────────────────────────────────────

function RunStrategyDialog({
  open,
  onOpenChange,
  strategies,
  onPublished,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  strategies: TeamStrategy[];
  onPublished: (runId: string) => void;
}) {
  const [strategyId, setStrategyId] = React.useState<string | null>(null);
  const [problem, setProblem] = React.useState("");
  const [orgNode, setOrgNode] = React.useState<string | null>(null);
  const nodesQuery = useOrgNodesQuery(open);
  const runMutation = useTeamRunMutation();

  // Reset the form each time the dialog opens.
  React.useEffect(() => {
    if (open) {
      setStrategyId(null);
      setProblem("");
      setOrgNode(null);
    }
  }, [open]);

  const strategyOptions: OrgPickerOption[] = React.useMemo(
    () =>
      strategies
        .filter((strategy) => !strategy.parentStrategy)
        .map((strategy) => ({
          id: strategy.id,
          label: strategy.name || strategy.id,
          sub: strategy.id,
          kindBadge: `${strategy.phases} phase${strategy.phases === 1 ? "" : "s"}`,
        })),
    [strategies],
  );

  const nodeOptions: OrgPickerOption[] = React.useMemo(
    () =>
      (nodesQuery.data ?? []).map((node) => ({
        id: node.dtag,
        label: node.name,
        sub: node.dtag,
        kindBadge: node.kind,
      })),
    [nodesQuery.data],
  );

  const selectedStrategy = strategies.find((s) => s.id === strategyId) ?? null;
  const phaseCount = selectedStrategy?.phases ?? 0;

  const canSubmit =
    strategyId !== null && problem.trim().length > 0 && !runMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="org-run-dialog">
        <DialogHeader>
          <DialogTitle className="text-sm">Run strategy</DialogTitle>
          <DialogDescription className="text-xs">
            Publishes the run head only after every turn persisted — a failure
            publishes nothing.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium">Strategy</legend>
            <OrgEntityPicker
              disabled={runMutation.isPending}
              emptyMessage="No strategies — seed the bank first."
              mode="single"
              onChange={setStrategyId}
              options={strategyOptions}
              searchPlaceholder="Search strategies…"
              selected={strategyId}
              triggerLabel="Choose a strategy"
            />
          </fieldset>
          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <label className="text-xs font-medium" htmlFor="org-run-problem">
                Problem
              </label>
              <span className="text-2xs text-muted-foreground">
                {problem.length}/16384 chars
              </span>
            </div>
            <Textarea
              className="min-h-24 resize-y text-sm"
              data-testid="org-run-problem"
              disabled={runMutation.isPending}
              id="org-run-problem"
              onChange={(event) => setProblem(event.target.value)}
              placeholder="What should the team solve?"
              value={problem}
            />
          </div>
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium">
              Org node <span className="text-muted-foreground">(optional)</span>
            </legend>
            <OrgEntityPicker
              disabled={runMutation.isPending}
              emptyMessage="No org nodes yet."
              mode="single"
              onChange={setOrgNode}
              options={nodeOptions}
              searchPlaceholder="Search org nodes…"
              selected={orgNode}
              triggerLabel="Bind seats to an org node…"
            />
          </fieldset>
          {runMutation.isPending ? (
            <div
              className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2"
              data-testid="org-run-progress"
            >
              <Spinner aria-hidden="true" className="h-4 w-4" />
              <p className="text-xs text-muted-foreground">
                {phaseCount > 0
                  ? `Conducting ${phaseCount} phase${phaseCount === 1 ? "" : "s"} — ${RUN_PROGRESS_LABEL.toLowerCase()}`
                  : RUN_PROGRESS_LABEL}
              </p>
            </div>
          ) : null}
          {runMutation.isError ? (
            <p
              className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              data-testid="org-run-error"
            >
              {runMutation.error instanceof Error
                ? runMutation.error.message
                : "The run failed."}
            </p>
          ) : null}
        </div>
        <div className="flex justify-end gap-2">
          <Button
            onClick={() => onOpenChange(false)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Cancel
          </Button>
          <Button
            data-testid="org-run-submit"
            disabled={!canSubmit}
            onClick={() => {
              if (strategyId === null) return;
              runMutation.mutate(
                { strategyId, problem, orgNode },
                {
                  onSuccess: (result) => {
                    onOpenChange(false);
                    onPublished(result.runId);
                  },
                },
              );
            }}
            size="sm"
            type="button"
          >
            {runMutation.isPending ? (
              <>
                <RefreshCw
                  aria-hidden="true"
                  className="h-3.5 w-3.5 animate-spin"
                />
                Running…
              </>
            ) : (
              <>
                <Play aria-hidden="true" className="h-3.5 w-3.5" />
                Run strategy
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── New strategy (JSON paste, validate + CLI command) ─────────────────────

function validateStrategyJson(
  raw: string,
): { ok: true; id: string } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    errors.push(
      `Not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { ok: false, errors };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, errors: ["Strategy must be a JSON object."] };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== 1) errors.push("`v` must be 1.");
  if (typeof obj.name !== "string" || !obj.name.trim()) {
    errors.push("`name` is required.");
  }
  if (typeof obj.description !== "string") {
    errors.push("`description` must be a string.");
  }
  if (typeof obj.teamworkPrompt !== "string" || !obj.teamworkPrompt.trim()) {
    errors.push("`teamworkPrompt` is required.");
  }
  const roles = obj.roles;
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) {
    errors.push("`roles` must be an object keyed by roster slot.");
  } else {
    const entries = Object.entries(roles as Record<string, unknown>);
    if (entries.length < 1 || entries.length > 6) {
      errors.push("`roles` needs 1..=6 slots.");
    } else if (
      entries.some(([, prompt]) => typeof prompt !== "string" || !prompt.trim())
    ) {
      errors.push("Every role prompt must be a non-empty string.");
    }
  }
  const steps = obj.steps;
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 6) {
    errors.push("`steps` must be an array of 1..=6 phases.");
  }
  if (typeof obj.finalWriter !== "string" || !obj.finalWriter.trim()) {
    errors.push("`finalWriter` must be a roster slot.");
  }
  if (errors.length > 0) return { ok: false, errors };
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  // Light client-side id derivation for the CLI command — the CLI validates
  // strictly; this is just a suggestion.
  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return { ok: true, id: id || "my-strategy" };
}

function NewStrategyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [raw, setRaw] = React.useState("");
  const [result, setResult] = React.useState<
    { ok: true; id: string } | { ok: false; errors: string[] } | null
  >(null);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setRaw("");
      setResult(null);
      setCopied(false);
    }
  }, [open]);

  const cliCommand =
    result?.ok === true
      ? `buzz team strategy put --id ${result.id} --file strategy.json --publish`
      : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="org-new-strategy-dialog">
        <DialogHeader>
          <DialogTitle className="text-sm">New strategy</DialogTitle>
          <DialogDescription className="text-xs">
            Paste the strategy JSON. The CLI validates strictly and signs +
            publishes it under your key — this dialog only previews.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Textarea
            className="min-h-56 resize-y font-mono text-2xs"
            data-testid="org-new-strategy-json"
            onChange={(event) => setRaw(event.target.value)}
            placeholder={
              '{\n  "v": 1,\n  "name": "…",\n  "roles": { … },\n  "steps": [ … ],\n  "finalWriter": "…"\n}'
            }
            spellCheck={false}
            value={raw}
          />
          {result && !result.ok ? (
            <div
              className="space-y-1 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2"
              data-testid="org-new-strategy-errors"
            >
              {result.errors.map((error) => (
                <p className="text-xs text-destructive" key={error}>
                  {error}
                </p>
              ))}
            </div>
          ) : null}
          {result?.ok === true ? (
            <div
              className="space-y-2 rounded-md border border-border bg-muted/40 px-3 py-2"
              data-testid="org-new-strategy-command"
            >
              <p className="text-xs text-muted-foreground">
                Passes the light check. Publish with the CLI:
              </p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1 font-mono text-2xs">
                  {cliCommand}
                </code>
                <Button
                  aria-label="Copy publish command"
                  onClick={() => {
                    copyTextToClipboard(cliCommand, "Publish command copied");
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1500);
                  }}
                  size="icon"
                  variant="ghost"
                >
                  {copied ? (
                    <Check aria-hidden="true" className="h-3.5 w-3.5" />
                  ) : (
                    <Copy aria-hidden="true" className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
        <div className="flex justify-end gap-2">
          <Button
            onClick={() => onOpenChange(false)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Close
          </Button>
          <Button
            data-testid="org-new-strategy-validate"
            disabled={!raw.trim()}
            onClick={() => setResult(validateStrategyJson(raw))}
            size="sm"
            type="button"
          >
            <FileJson aria-hidden="true" className="h-3.5 w-3.5" />
            Validate
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Run detail sheet ──────────────────────────────────────────────────────

function TurnMarkdown({ content }: { content: string }) {
  return (
    <Markdown
      blockCode
      className="text-sm"
      content={content}
      hardLineBreaks={false}
      interactive={false}
    />
  );
}

function TurnRow({ turn }: { turn: TranscriptTurn }) {
  return (
    <div
      className="space-y-1.5 border-l-2 border-border pl-3"
      data-testid="org-run-turn"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-2xs">
          {turn.agentSlot}
        </span>
        {turn.pubkey ? (
          <span className="font-mono text-2xs text-muted-foreground">
            {truncatePubkey(turn.pubkey)}
          </span>
        ) : (
          <span className="text-2xs text-muted-foreground">unbound</span>
        )}
        <span className="ml-auto font-mono text-2xs text-muted-foreground">
          {turn.tokens > 0 ? `${turn.tokens.toLocaleString()} tokens` : ""}
        </span>
      </div>
      <div className="min-w-0">
        <TurnMarkdown content={turn.content} />
      </div>
    </div>
  );
}

function PhaseSection({
  phase,
  turns,
}: {
  phase: number;
  turns: TranscriptTurn[];
}) {
  return (
    <section className="space-y-2" data-testid="org-run-sheet-phase">
      <h3 className="text-2xs font-semibold uppercase tracking-widest text-muted-foreground">
        Phase {phase} · {turns.length} turn{turns.length === 1 ? "" : "s"}
      </h3>
      <div className="space-y-3">
        {turns.map((turn) => (
          <TurnRow
            key={`${phase}-${turn.agentSlot}-${turn.content.slice(0, 20)}`}
            turn={turn}
          />
        ))}
      </div>
    </section>
  );
}

function reflectName(result: TeamReflectResult): string {
  const name = result.revised?.name;
  return typeof name === "string" && name ? name : result.revisionD;
}

function reflectDescription(result: TeamReflectResult): string {
  const description = result.revised?.description;
  return typeof description === "string" && description ? description : "";
}

function reflectStats(result: TeamReflectResult): string {
  const roles = result.revised?.roles;
  const steps = result.revised?.steps;
  const roster =
    roles && typeof roles === "object" && !Array.isArray(roles)
      ? Object.keys(roles as Record<string, unknown>).length
      : 0;
  const phases = Array.isArray(steps) ? steps.length : 0;
  return `${phases} phase${phases === 1 ? "" : "s"} · ${roster} slot${roster === 1 ? "" : "s"}`;
}

function RunDetailSheet({
  run,
  strategyName,
  turnsByRun,
  onOpenChange,
  onReflectPublished,
}: {
  run: TeamRun | null;
  strategyName: string | null;
  turnsByRun: Map<string, TeamTurn[]>;
  onOpenChange: (open: boolean) => void;
  onReflectPublished: () => void;
}) {
  const reflectMutation = useTeamReflectMutation();
  const [reflectState, setReflectState] = React.useState<
    | { kind: "idle" }
    | { kind: "confirm" }
    | { kind: "running" }
    | { kind: "done"; result: TeamReflectResult }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  // Prefer the 44022 turns (the per-turn record); fall back to the run
  // head's embedded transcript (older runs or a relay that pruned turns).
  const turns: TranscriptTurn[] = React.useMemo(() => {
    if (!run) return [];
    const perRun = turnsByRun.get(run.id);
    if (perRun && perRun.length > 0) {
      return perRun.map((turn) => ({
        phase: turn.phase,
        agentSlot: turn.agentSlot,
        content: turn.content,
        tokens: turn.tokens,
        pubkey: turn.pubkey,
      }));
    }
    if (run.transcript.length > 0) {
      return run.transcript.map((row: RunTranscriptRow) => ({
        phase: row.phase,
        agentSlot: row.agentSlot,
        content: row.content,
        tokens: row.tokens,
        pubkey: row.pubkey,
      }));
    }
    return [];
  }, [run, turnsByRun]);

  const phases = React.useMemo(() => groupTurnsByPhase(turns), [turns]);

  const reflectError =
    reflectState.kind === "error" ? reflectState.message : null;

  return (
    <Sheet onOpenChange={onOpenChange} open={run !== null}>
      <SheetContent
        className="flex flex-col gap-0 overflow-y-auto p-0 sm:max-w-xl"
        data-testid="org-run-sheet"
      >
        <SheetHeader className="border-b px-5 py-4 text-left">
          <SheetTitle className="text-sm">
            {strategyName ?? run?.strategyId ?? ""}
          </SheetTitle>
          <SheetDescription className="text-2xs text-muted-foreground">
            {run
              ? `Run ${run.id} · ${run.status} · model ${run.model || "unknown"} · ${relativeTimeLabel(run.createdAt, Math.floor(Date.now() / 1000))}`
              : "Loading run…"}
          </SheetDescription>
        </SheetHeader>
        <div className="min-w-0 space-y-5 px-5 py-4">
          {run ? (
            <>
              <div className="space-y-2">
                <h3 className="text-2xs font-semibold uppercase tracking-widest text-muted-foreground">
                  Problem
                </h3>
                <p
                  className="whitespace-pre-wrap text-sm"
                  data-testid="org-run-problem-text"
                >
                  {run.problem}
                </p>
              </div>
              {run.orgNode ||
              (run.seats && Object.keys(run.seats).length > 0) ? (
                <div className="space-y-2">
                  <h3 className="text-2xs font-semibold uppercase tracking-widest text-muted-foreground">
                    Org binding
                  </h3>
                  <div className="flex flex-wrap items-center gap-2">
                    {run.orgNode ? (
                      <span className="rounded-sm border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-2xs">
                        node {run.orgNode}
                      </span>
                    ) : null}
                    {run.seats
                      ? Object.entries(run.seats).map(([slot, pubkey]) => (
                          <span
                            className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-2xs text-muted-foreground"
                            key={slot}
                          >
                            {slot} → {truncatePubkey(pubkey)}
                          </span>
                        ))
                      : null}
                  </div>
                </div>
              ) : null}
              {[...phases.entries()]
                .sort(([a], [b]) => a - b)
                .map(([phase, phaseTurns]) => (
                  <PhaseSection key={phase} phase={phase} turns={phaseTurns} />
                ))}
              <div
                className="space-y-2 rounded-lg border border-emerald-300/40 bg-emerald-50 p-3 dark:border-emerald-800/40 dark:bg-emerald-950/30"
                data-testid="org-run-final-answer"
              >
                <h3 className="text-2xs font-semibold uppercase tracking-widest text-emerald-700 dark:text-emerald-300">
                  Final answer
                </h3>
                <div className="min-w-0">
                  <TurnMarkdown content={run.finalAnswer} />
                </div>
                <p className="font-mono text-2xs text-muted-foreground">
                  {run.totalTokens.toLocaleString()} tokens total
                </p>
              </div>
              {/* Reflection affordance */}
              <div className="border-t border-border pt-4">
                {reflectState.kind === "idle" ? (
                  <Button
                    data-testid="org-reflect"
                    onClick={() => setReflectState({ kind: "confirm" })}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <Sparkles aria-hidden="true" className="h-3.5 w-3.5" />
                    Reflect on this run
                  </Button>
                ) : null}
                {reflectState.kind === "confirm" ? (
                  <div
                    className="flex flex-wrap items-center gap-2"
                    data-testid="org-reflect-confirm"
                  >
                    <p className="flex-1 text-xs text-muted-foreground">
                      Publishes a revised strategy as{" "}
                      <code className="font-mono text-2xs">
                        {run.strategyId}-revN
                      </code>{" "}
                      in the bank. Continue?
                    </p>
                    <Button
                      onClick={() => {
                        setReflectState({ kind: "running" });
                        reflectMutation.mutate(run.id, {
                          onSuccess: (result) =>
                            setReflectState({ kind: "done", result }),
                          onError: (error) =>
                            setReflectState({
                              kind: "error",
                              message:
                                error instanceof Error
                                  ? error.message
                                  : "Reflection failed.",
                            }),
                        });
                      }}
                      size="sm"
                      type="button"
                    >
                      Confirm reflection
                    </Button>
                    <Button
                      onClick={() => setReflectState({ kind: "idle" })}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      Cancel
                    </Button>
                  </div>
                ) : null}
                {reflectState.kind === "running" ? (
                  <div
                    className="flex items-center gap-2"
                    data-testid="org-reflect-progress"
                  >
                    <Spinner aria-hidden="true" className="h-4 w-4" />
                    <p className="text-xs text-muted-foreground">
                      Reflecting — one classifier call on the transcript and
                      certificate (up to ~2 minutes)
                    </p>
                  </div>
                ) : null}
                {reflectState.kind === "done" ? (
                  <div
                    className="space-y-2 rounded-md border border-border bg-muted/40 px-3 py-2"
                    data-testid="org-reflect-result"
                  >
                    <p className="text-xs">
                      <Check
                        aria-hidden="true"
                        className="mr-1 inline h-3.5 w-3.5 text-emerald-600"
                      />
                      Published{" "}
                      <code className="font-mono text-2xs">
                        {reflectState.result.revisionD}
                      </code>
                    </p>
                    <div className="space-y-0.5">
                      <p className="text-sm font-medium">
                        {reflectName(reflectState.result)}
                      </p>
                      <p className="line-clamp-2 text-xs text-muted-foreground">
                        {reflectDescription(reflectState.result)}
                      </p>
                      <p className="text-2xs text-muted-foreground">
                        {reflectStats(reflectState.result)} · lineaged from{" "}
                        <code className="font-mono text-2xs">
                          {run.strategyId}
                        </code>
                      </p>
                    </div>
                    <Button
                      data-testid="org-reflect-view-bank"
                      onClick={() => {
                        onOpenChange(false);
                        onReflectPublished();
                      }}
                      size="sm"
                      type="button"
                    >
                      View strategy bank
                    </Button>
                  </div>
                ) : null}
                {reflectError ? (
                  <p
                    className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                    data-testid="org-reflect-error"
                  >
                    {reflectError}
                  </p>
                ) : null}
              </div>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              {run === null ? "Loading run…" : "This run is no longer visible."}
            </p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── Teams view ────────────────────────────────────────────────────────────

export function OrgTeamsView() {
  const strategiesQuery = useTeamStrategiesQuery();
  const runsQuery = useTeamRunsQuery();
  const turnsQuery = useTeamTurnsQuery();
  const strategies = strategiesQuery.data ?? [];
  const runs = runsQuery.data ?? [];
  const turns = turnsQuery.data ?? [];

  const [runDialogOpen, setRunDialogOpen] = React.useState(false);
  const [newStrategyOpen, setNewStrategyOpen] = React.useState(false);
  const [selectedRunId, setSelectedRunId] = React.useState<string | null>(null);
  const bankRef = React.useRef<HTMLDivElement>(null);

  const turnsByRun = React.useMemo(() => groupTurnsByRun(turns), [turns]);
  const strategiesById = React.useMemo(
    () => new Map(strategies.map((strategy) => [strategy.id, strategy])),
    [strategies],
  );
  const runsById = React.useMemo(
    () => new Map(runs.map((run) => [run.id, run])),
    [runs],
  );
  const selectedRun = selectedRunId
    ? (runsById.get(selectedRunId) ?? null)
    : null;
  const selectedStrategyName = selectedRun
    ? (strategiesById.get(selectedRun.strategyId)?.name ?? null)
    : null;

  // Newest run per strategy → the "model" provenance on bank rows.
  const newestRunModelByStrategy = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const run of [...runs].sort((a, b) => b.createdAt - a.createdAt)) {
      if (!map.has(run.strategyId) && run.model) {
        map.set(run.strategyId, run.model);
      }
    }
    return map;
  }, [runs]);

  const anyPending =
    strategiesQuery.isPending || runsQuery.isPending || turnsQuery.isPending;
  const anyError =
    strategiesQuery.isError || runsQuery.isError || turnsQuery.isError;
  const retryAll = () => {
    void strategiesQuery.refetch();
    void runsQuery.refetch();
    void turnsQuery.refetch();
  };

  const scrollToBank = () => {
    bankRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  if (anyPending) {
    return (
      <div data-testid="org-teams-view">
        <EmptyState
          icon={<Spinner aria-hidden="true" className="h-6 w-6" />}
          testId="org-teams-loading"
          title="Loading teams…"
        />
      </div>
    );
  }

  if (anyError) {
    return (
      <div data-testid="org-teams-view">
        <EmptyState
          action={
            <Button onClick={retryAll} size="sm" variant="outline">
              Retry
            </Button>
          }
          description="The relay did not answer the team queries. Check the connection, then retry."
          testId="org-teams-error"
          title="Failed to load teams"
          variant="error"
        />
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="org-teams-view">
      {/* Bank */}
      <section
        ref={bankRef}
        className="scroll-mt-2"
        data-testid="org-strategy-bank"
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold">Strategy bank</h2>
          <div className="flex items-center gap-2">
            <Button
              data-testid="org-new-strategy"
              onClick={() => setNewStrategyOpen(true)}
              size="sm"
              type="button"
              variant="outline"
            >
              <FileJson aria-hidden="true" className="h-3.5 w-3.5" />
              New strategy
            </Button>
            <Button
              data-testid="org-open-run-dialog"
              disabled={strategies.length === 0}
              onClick={() => setRunDialogOpen(true)}
              size="sm"
              type="button"
            >
              <Play aria-hidden="true" className="h-3.5 w-3.5" />
              Run strategy
            </Button>
          </div>
        </div>
        {strategies.length === 0 ? (
          <EmptyState
            description={
              <>
                No strategies yet. Seed the bank or paste one below.{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-2xs">
                  {SEED_HINT}
                </code>
              </>
            }
            icon={<BookOpen aria-hidden="true" className="h-5 w-5" />}
            testId="org-bank-empty"
            title="No strategies in the bank"
          />
        ) : (
          <div className="space-y-2">
            {strategies.map((strategy) => {
              const revisions = strategyRevisions(strategies, strategy.id);
              const model = newestRunModelByStrategy.get(strategy.id);
              return (
                <Card
                  className="p-3"
                  data-testid="org-bank-row"
                  key={strategy.id}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <p className="truncate text-sm font-medium">
                          {strategy.name}
                        </p>
                        <code className="shrink-0 font-mono text-2xs text-muted-foreground">
                          {strategy.id}
                        </code>
                      </div>
                      {strategy.description ? (
                        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                          {strategy.description}
                        </p>
                      ) : null}
                    </div>
                    <Button
                      data-testid={`org-run-${strategy.id}`}
                      onClick={() => setRunDialogOpen(true)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      Run
                    </Button>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <LineageChip
                      label={`${strategy.phases} phase${strategy.phases === 1 ? "" : "s"} · ${strategy.roster.length} slots`}
                    />
                    {lineageLabel(strategy) ? (
                      <LineageChip label={lineageLabel(strategy) as string} />
                    ) : null}
                    {revisions.map((revision) => {
                      const label = lineageLabel(revision);
                      return label ? (
                        <LineageChip key={revision.id} label={label} />
                      ) : null;
                    })}
                    {model ? (
                      <span className="font-mono text-2xs text-muted-foreground">
                        {model}
                      </span>
                    ) : null}
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {/* Runs */}
      <section data-testid="org-runs-list">
        <h2 className="mb-2 text-base font-semibold">Runs</h2>
        {runs.length === 0 ? (
          <EmptyState
            description={
              strategies.length === 0
                ? "No runs yet — seed the strategy bank first."
                : "No runs yet — pick a strategy above to run it."
            }
            icon={<Play aria-hidden="true" className="h-5 w-5" />}
            testId="org-runs-empty"
            title="No runs yet"
          />
        ) : (
          <Card className="divide-y p-1" data-testid="org-runs-list">
            {runs.map((run) => {
              const name = strategiesById.get(run.strategyId)?.name;
              return (
                <button
                  aria-label={`Open run ${run.id}`}
                  className="flex w-full items-center gap-2 px-2 py-1.5 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
                  data-testid="org-run-row"
                  key={run.id}
                  onClick={() => setSelectedRunId(run.id)}
                  type="button"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">
                      {name ?? run.strategyId}
                    </span>
                    <ProblemSnippet problem={run.problem} />
                  </span>
                  <span
                    className={cn(
                      "shrink-0 rounded-sm px-1.5 py-0.5 text-2xs",
                      statusPillClass(run.status),
                    )}
                    data-testid="org-run-status"
                  >
                    {run.status}
                  </span>
                  <span className="shrink-0 font-mono text-2xs text-muted-foreground">
                    {run.totalTokens.toLocaleString()} tok
                  </span>
                  <span className="shrink-0 text-2xs text-muted-foreground">
                    {relativeTimeLabel(
                      run.createdAt,
                      Math.floor(Date.now() / 1000),
                    )}
                  </span>
                </button>
              );
            })}
          </Card>
        )}
      </section>

      <RunStrategyDialog
        onOpenChange={setRunDialogOpen}
        onPublished={(runId) => setSelectedRunId(runId)}
        open={runDialogOpen}
        strategies={strategies}
      />
      <NewStrategyDialog
        onOpenChange={setNewStrategyOpen}
        open={newStrategyOpen}
      />
      <RunDetailSheet
        key={selectedRunId ?? "closed"}
        onOpenChange={(open) => {
          if (!open) setSelectedRunId(null);
        }}
        onReflectPublished={scrollToBank}
        run={selectedRun}
        strategyName={selectedStrategyName}
        turnsByRun={turnsByRun}
      />
    </div>
  );
}

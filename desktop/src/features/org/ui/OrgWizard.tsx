import * as React from "react";
import {
  ArrowRight,
  ChevronRight,
  Gauge,
  GitBranch,
  type LucideIcon,
} from "lucide-react";

import { useIdentityQuery } from "@/shared/api/hooks";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { StepProgress } from "@/shared/ui/step-progress";

import {
  COMMUNITY_DEFAULT_SUBJECT,
  ENFORCEMENT_LABEL,
  budgetSubjectError,
  parseLimitField,
} from "../lib/budgetForm";
import { slugify } from "../lib/pickerOptions";
import {
  WIZARD_STEPS,
  canFinish,
  currentStepId,
  initialWizardState,
  positionOf,
  recordOutcome,
  reviewRows,
  skipStep,
  type OrgWizardState,
  type WizardOutcome,
  type WizardReviewRow,
} from "../lib/orgWizard";
import {
  useCreateOrgBudgetMutation,
  useCreateOrgGrantMutation,
  useCreateOrgNodeMutation,
} from "../hooks";
import type { OrgNode } from "../orgModels";
import { OrgEntityPicker } from "./OrgEntityPicker";
import { useBudgetSubjectOptions } from "./useBudgetSubjects";

type OrgWizardProps = {
  /**
   * True while the org chart has zero nodes. The wizard owns its own open
   * state: it opens when this flips true, and it does NOT re-close when the
   * root appears mid-walk (the strip must survive steps 2–5). It simply
   * stops auto-opening once a root exists — the honest empty-chart signal.
   */
  autoOpen: boolean;
  /** Current org nodes so step 2/4 pickers can preset from live data. */
  nodes: OrgNode[];
  /** Called when the user finishes the walk (land on the canvas). */
  onFinish: () => void;
  /** Called when a review row links to the canvas. */
  onOpenCanvas: (dtag: string) => void;
};

const WIZARD_TOTAL_STEPS = WIZARD_STEPS.length;
const KIND_OPTIONS = [
  { value: "role", label: "Role" },
  { value: "team", label: "Team" },
  { value: "agent_seat", label: "Agent Seat" },
] as const;
const VERB_PRESETS = [
  "read",
  "write",
  "admin",
  "task:create",
  "task:approve",
  "spend:10000",
];
const WINDOW_OPTIONS = [
  { value: "epoch", label: "Epoch" },
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
] as const;

function budgetLimitsText(input: {
  window: string;
  runs?: number;
  spendAmount?: number;
}): string {
  const limits = [
    input.runs !== undefined && `${input.runs} runs`,
    input.spendAmount !== undefined &&
      `${input.spendAmount} usd-cents (advisory)`,
  ]
    .filter(Boolean)
    .join(" + ");
  return `${limits || "no limits"} per ${input.window}`;
}

// ── Step bodies ────────────────────────────────────────────────────────────

type StepShellProps = {
  position: number;
  title: string;
  description: string;
  children: React.ReactNode;
};

function StepShell({ position, title, description, children }: StepShellProps) {
  return (
    <div className="space-y-4">
      <div>
        <p
          className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          data-testid="org-wizard-step-number"
        >
          Step {position}
        </p>
        <h2 className="mt-0.5 text-base font-semibold text-foreground">
          {title}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}

function InlineError({
  message,
  onRetry,
  pending,
}: {
  message: string;
  onRetry: () => void;
  pending: boolean;
}) {
  return (
    <div
      className="flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2"
      data-testid="org-wizard-step-error"
      role="alert"
    >
      <p className="min-w-0 text-sm text-destructive">{message}</p>
      <Button
        className="shrink-0 h-7 px-2 text-xs"
        disabled={pending}
        onClick={onRetry}
        size="sm"
        type="button"
        variant="outline"
      >
        Retry
      </Button>
    </div>
  );
}

type BudgetSubmitInput = {
  dtag: string;
  /** 64-hex agent pubkey, or "*" for the community default. */
  subject: string;
  subjectLabel: string;
  window: "epoch" | "day" | "week" | "month";
  runs?: number;
  spendAmount?: number;
};

function StepFooter({
  error,
  pending,
  onSkip,
  canSkip,
  submitLabel,
  submitDisabled,
  onSubmit,
}: {
  error: string | null;
  pending: boolean;
  onSkip: () => void;
  canSkip: boolean;
  submitLabel: string;
  submitDisabled: boolean;
  onSubmit: () => void;
}) {
  return (
    <div className="space-y-3">
      {error && (
        <InlineError
          message={error}
          // Retry re-runs this step's submit with the retained field values.
          onRetry={onSubmit}
          pending={pending}
        />
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {canSkip && (
          <Button
            disabled={pending}
            onClick={onSkip}
            type="button"
            variant="ghost"
          >
            Skip step
          </Button>
        )}
        <Button disabled={submitDisabled} onClick={onSubmit} type="button">
          {pending ? "Publishing…" : submitLabel}
        </Button>
      </div>
    </div>
  );
}

// Step 1 — name the org root (required, always publishes kind:37010 root).
function RootStep({
  disabled,
  error,
  pending,
  onSubmit,
}: {
  disabled: boolean;
  error: string | null;
  pending: boolean;
  onSubmit: (name: string, dtag: string) => void;
}) {
  const [name, setName] = React.useState("");
  const [dtag, setDtag] = React.useState("");
  const nameRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!disabled && !pending) nameRef.current?.focus();
  }, [disabled, pending]);

  const handleNameChange = (next: string) => {
    setName(next);
    setDtag((current) =>
      current === "" || current === slugify(name) ? slugify(next) : current,
    );
  };

  const canSubmit =
    name.trim().length > 0 && dtag.trim().length > 0 && !pending;
  const submit = () => {
    if (!canSubmit) return;
    onSubmit(name.trim(), dtag.trim());
  };

  return (
    <StepShell
      description="Creates the top of the org chart. Every role and agent seat hangs under it."
      position={positionOf("root")}
      title="Name the org root"
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <label
            className="text-sm font-medium text-foreground"
            htmlFor="org-wizard-root-name"
          >
            Root name
          </label>
          <Input
            disabled={disabled || pending}
            id="org-wizard-root-name"
            onChange={(event) => handleNameChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }}
            placeholder="e.g. Acme"
            ref={nameRef}
            value={name}
          />
        </div>
        <div className="space-y-1.5">
          <label
            className="text-sm font-medium text-foreground"
            htmlFor="org-wizard-root-dtag"
          >
            Org ID
          </label>
          <Input
            disabled={disabled || pending}
            id="org-wizard-root-dtag"
            onChange={(event) => setDtag(event.target.value)}
            placeholder="e.g. acme"
            value={dtag}
          />
          <p className="text-xs text-muted-foreground">
            Unique identifier, auto-slugged from the name; cannot be changed
            later.
          </p>
        </div>
        {error && (
          <InlineError message={error} onRetry={submit} pending={pending} />
        )}
        <div className="flex justify-end">
          <Button disabled={!canSubmit} onClick={submit} type="button">
            {pending ? "Publishing…" : "Create root"}
          </Button>
        </div>
      </div>
    </StepShell>
  );
}

// Step 2 — add a role or agent seat under the root (skippable).
function SeatStep({
  disabled,
  error,
  pending,
  parentDtag,
  parentName,
  onSubmit,
  onSkip,
}: {
  disabled: boolean;
  error: string | null;
  pending: boolean;
  parentDtag: string;
  parentName: string;
  onSubmit: (
    name: string,
    dtag: string,
    kind: "role" | "team" | "agent_seat",
  ) => void;
  onSkip: () => void;
}) {
  const [name, setName] = React.useState("");
  const [dtag, setDtag] = React.useState("");
  const [kind, setKind] = React.useState<"role" | "team" | "agent_seat">(
    "agent_seat",
  );
  const nameRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!disabled && !pending) nameRef.current?.focus();
  }, [disabled, pending]);

  const handleNameChange = (next: string) => {
    setName(next);
    setDtag((current) =>
      current === "" || current === slugify(name) ? slugify(next) : current,
    );
  };

  const canSubmit =
    name.trim().length > 0 && dtag.trim().length > 0 && !pending;
  const submit = () => {
    if (!canSubmit) return;
    onSubmit(name.trim(), dtag.trim(), kind);
  };

  return (
    <StepShell
      description={`Adds a role under ${parentName}. Budgets follow the agent in a seat, so a seat is budgeted once an agent occupies it.`}
      position={positionOf("seat")}
      title="Add a role or agent seat"
    >
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Parent preset:{" "}
          <span className="font-mono text-foreground">{parentDtag}</span>
        </p>
        <div className="space-y-1.5">
          <label
            className="text-sm font-medium text-foreground"
            htmlFor="org-wizard-seat-name"
          >
            Seat name
          </label>
          <Input
            disabled={disabled || pending}
            id="org-wizard-seat-name"
            onChange={(event) => handleNameChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }}
            placeholder="e.g. Ops Agent"
            ref={nameRef}
            value={name}
          />
        </div>
        <div className="space-y-1.5">
          <label
            className="text-sm font-medium text-foreground"
            htmlFor="org-wizard-seat-dtag"
          >
            ID
          </label>
          <Input
            disabled={disabled || pending}
            id="org-wizard-seat-dtag"
            onChange={(event) => setDtag(event.target.value)}
            placeholder="e.g. ops-agent"
            value={dtag}
          />
        </div>
        <fieldset
          aria-label="Seat kind"
          className="space-y-1.5 border-0 p-0 m-0"
        >
          <legend className="text-sm font-medium text-foreground">Kind</legend>
          <div className="flex gap-2">
            {KIND_OPTIONS.map((option) => (
              <Button
                aria-checked={kind === option.value}
                disabled={disabled || pending}
                key={option.value}
                onClick={() => setKind(option.value)}
                role="radio"
                size="sm"
                type="button"
                variant={kind === option.value ? "default" : "outline"}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </fieldset>
        <StepFooter
          canSkip={!pending}
          error={error}
          onSkip={onSkip}
          onSubmit={submit}
          pending={pending}
          submitDisabled={!canSubmit}
          submitLabel="Create seat"
        />
      </div>
    </StepShell>
  );
}

// Step 3 — first grant, preset to the root node’s holder (skippable).
function GrantStep({
  disabled,
  error,
  pending,
  grantee,
  viaDtag,
  viaName,
  onSubmit,
  onSkip,
}: {
  disabled: boolean;
  error: string | null;
  pending: boolean;
  grantee: string;
  viaDtag: string;
  viaName: string;
  onSubmit: (
    dtag: string,
    grantee: string,
    via: string,
    verbs: string[],
  ) => void;
  onSkip: () => void;
}) {
  const [dtag, setDtag] = React.useState("");
  const [verbs, setVerbs] = React.useState<string[]>(["read"]);
  const dtagRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!disabled && !pending) dtagRef.current?.focus();
  }, [disabled, pending]);

  const toggleVerb = (verb: string) => {
    setVerbs((current) =>
      current.includes(verb)
        ? current.filter((v) => v !== verb)
        : [...current, verb],
    );
  };

  const canSubmit = dtag.trim().length > 0 && verbs.length > 0 && !pending;
  const submit = () => {
    if (!canSubmit) return;
    onSubmit(dtag.trim(), grantee, viaDtag, verbs);
  };

  return (
    <StepShell
      description={`Delegates authority from ${viaName} to its holder. The first grant mints the chain your org’s attenuation rules will check.`}
      position={positionOf("grant")}
      title="First grant"
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <label
            className="text-sm font-medium text-foreground"
            htmlFor="org-wizard-grant-dtag"
          >
            Grant ID
          </label>
          <Input
            disabled={disabled || pending}
            id="org-wizard-grant-dtag"
            onChange={(event) => setDtag(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }}
            placeholder="e.g. grant-root-read"
            ref={dtagRef}
            value={dtag}
          />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <span className="text-xs font-medium text-foreground">
              Grantee (preset)
            </span>
            <p className="truncate font-mono text-2xs text-muted-foreground">
              {truncatePubkey(grantee)} · you
            </p>
          </div>
          <div className="space-y-1">
            <span className="text-xs font-medium text-foreground">
              Via (preset)
            </span>
            <p className="truncate font-mono text-2xs text-muted-foreground">
              {viaDtag}
            </p>
          </div>
        </div>
        <div className="space-y-1.5">
          <span className="text-sm font-medium text-foreground">Verbs</span>
          <div className="flex flex-wrap gap-1.5">
            {VERB_PRESETS.map((verb) => (
              <Button
                disabled={disabled || pending}
                key={verb}
                onClick={() => toggleVerb(verb)}
                size="sm"
                type="button"
                variant={verbs.includes(verb) ? "default" : "outline"}
              >
                {verb}
              </Button>
            ))}
          </div>
        </div>
        <StepFooter
          canSkip={!pending}
          error={error}
          onSkip={onSkip}
          onSubmit={submit}
          pending={pending}
          submitDisabled={!canSubmit}
          submitLabel="Create grant"
        />
      </div>
    </StepShell>
  );
}

// Step 4 — first budget (skippable). A budget covers an AGENT (its pubkey) or
// every agent by default ("*"); the relay rejects an org node id as subject.
function BudgetStep({
  disabled,
  error,
  pending,
  nodes,
  onSubmit,
  onSkip,
}: {
  disabled: boolean;
  error: string | null;
  pending: boolean;
  nodes: OrgNode[];
  onSubmit: (input: BudgetSubmitInput) => void;
  onSkip: () => void;
}) {
  const [dtag, setDtag] = React.useState("");
  const [subject, setSubject] = React.useState<string | null>(null);
  const [window, setWindow] = React.useState<
    "epoch" | "day" | "week" | "month"
  >("month");
  const [runs, setRuns] = React.useState("");
  const [spendAmount, setSpendAmount] = React.useState("");
  const dtagRef = React.useRef<HTMLInputElement>(null);
  const { options, communityDefaultAvailable } = useBudgetSubjectOptions(nodes);

  React.useEffect(() => {
    if (!disabled && !pending) dtagRef.current?.focus();
  }, [disabled, pending]);

  // The community default is the natural first budget (R2: budgets bind every
  // agent by default); pre-select it when it is offered and nothing else was
  // chosen. With no agents seated it is the only option.
  const defaultOffered = options.some(
    (option) => option.id === COMMUNITY_DEFAULT_SUBJECT,
  );
  React.useEffect(() => {
    if (defaultOffered) {
      setSubject((current) => current ?? COMMUNITY_DEFAULT_SUBJECT);
    }
  }, [defaultOffered]);

  const selected = options.find((option) => option.id === subject);
  const runsValue = parseLimitField(runs);
  const spendValue = parseLimitField(spendAmount);
  const canSubmit =
    dtag.trim().length > 0 &&
    budgetSubjectError(subject) === null &&
    (runs.trim() === "" || runsValue !== undefined) &&
    (spendAmount.trim() === "" || spendValue !== undefined) &&
    !pending;
  const submit = () => {
    if (!canSubmit || !subject) return;
    onSubmit({
      dtag: dtag.trim(),
      subject,
      subjectLabel: selected?.label ?? subject,
      window,
      runs: runsValue,
      spendAmount: spendValue,
    });
  };

  return (
    <StepShell
      description="Sets a budget for one agent, or for every agent without a budget of its own. Going over it asks for approval instead of silently stopping."
      position={positionOf("budget")}
      title="First budget"
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <OrgEntityPicker
            disabled={disabled || pending}
            emptyMessage="No agent is seated yet. A budget covers an agent's key, not an empty seat — skip this step and add one once an agent has joined."
            mode="single"
            onChange={setSubject}
            options={options}
            searchPlaceholder="Search agents..."
            selected={subject}
            triggerLabel="Subject"
          />
          {communityDefaultAvailable ? null : (
            <p className="text-xs text-muted-foreground">
              Only the community owner or an admin can set the default for all
              agents.
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <label
            className="text-sm font-medium text-foreground"
            htmlFor="org-wizard-budget-dtag"
          >
            Budget ID
          </label>
          <Input
            disabled={disabled || pending}
            id="org-wizard-budget-dtag"
            onChange={(event) => setDtag(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }}
            placeholder="e.g. budget-monthly-runs"
            ref={dtagRef}
            value={dtag}
          />
        </div>
        <fieldset
          aria-label="Budget window"
          className="space-y-1.5 border-0 p-0 m-0"
        >
          <legend className="text-sm font-medium text-foreground">
            Window
          </legend>
          <div className="flex gap-2">
            {WINDOW_OPTIONS.map((option) => (
              <Button
                aria-checked={window === option.value}
                disabled={disabled || pending}
                key={option.value}
                onClick={() => setWindow(option.value)}
                role="radio"
                size="sm"
                type="button"
                variant={window === option.value ? "default" : "outline"}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </fieldset>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor="org-wizard-budget-runs"
            >
              Max Runs
            </label>
            <Input
              aria-describedby="org-wizard-budget-runs-mode"
              disabled={disabled || pending}
              id="org-wizard-budget-runs"
              min="0"
              onChange={(event) => setRuns(event.target.value)}
              placeholder="e.g. 100"
              type="number"
              value={runs}
            />
            <p
              className="text-2xs text-muted-foreground"
              id="org-wizard-budget-runs-mode"
            >
              {ENFORCEMENT_LABEL.relay}
            </p>
          </div>
          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor="org-wizard-budget-spend"
            >
              Max Spend (cents)
            </label>
            <Input
              aria-describedby="org-wizard-budget-spend-mode"
              disabled={disabled || pending}
              id="org-wizard-budget-spend"
              min="0"
              onChange={(event) => setSpendAmount(event.target.value)}
              placeholder="e.g. 50000"
              type="number"
              value={spendAmount}
            />
            <p
              className="text-2xs text-muted-foreground"
              id="org-wizard-budget-spend-mode"
            >
              {ENFORCEMENT_LABEL.advisory} — only an on-chain allowance can stop
              spending.
            </p>
          </div>
        </div>
        <StepFooter
          canSkip={!pending}
          error={error}
          onSkip={onSkip}
          onSubmit={submit}
          pending={pending}
          submitDisabled={!canSubmit}
          submitLabel="Create budget"
        />
      </div>
    </StepShell>
  );
}

/** Kind icon per review row: node steps branch, grants flow, budgets meter. */
function stepIconFor(row: WizardReviewRow): LucideIcon {
  const outcome = row.outcome;
  if (!outcome) return GitBranch;
  if (outcome.step === "skipped") {
    if (outcome.skippedStep === "grant") return ArrowRight;
    if (outcome.skippedStep === "budget") return Gauge;
    return GitBranch;
  }
  if (outcome.kind === "node") return GitBranch;
  if (outcome.kind === "grant") return ArrowRight;
  return Gauge;
}

/** The created entity's kind badge; skipped rows have none (already marked). */
function stepKindBadge(row: WizardReviewRow): string | null {
  const outcome = row.outcome;
  if (!outcome || outcome.step === "skipped") return null;
  if (outcome.kind === "node") {
    return outcome.nodeKind === "role"
      ? "Role"
      : outcome.nodeKind === "team"
        ? "Team"
        : "Agent seat";
  }
  return outcome.kind === "grant" ? "Grant" : "Budget";
}

// Step 5 — review: what was actually created, what was skipped.
function ReviewStep({
  state,
  onOpenCanvas,
  onFinish,
  canFinishNow,
}: {
  state: OrgWizardState;
  onOpenCanvas: (dtag: string) => void;
  onFinish: () => void;
  canFinishNow: boolean;
}) {
  const rows = reviewRows(state);
  return (
    <StepShell
      description="Every step published a real event. Skipped steps are listed as skipped; nothing here is simulated."
      position={positionOf("review")}
      title="Review"
    >
      <ul className="space-y-2">
        {rows.map((row) => (
          <li
            className="flex items-start justify-between gap-3 rounded-md border px-3 py-2"
            data-testid={`org-wizard-review-row-${row.position}`}
            key={row.position}
          >
            <div className="flex min-w-0 items-start gap-2.5">
              <span
                aria-hidden="true"
                className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-2xs font-semibold text-muted-foreground"
              >
                {row.position}
              </span>
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-1.5">
                  {React.createElement(stepIconFor(row), {
                    "aria-hidden": true,
                    className: "h-3.5 w-3.5 shrink-0 text-muted-foreground",
                  })}
                  <p className="truncate text-xs font-medium text-foreground">
                    {row.title}
                  </p>
                  {stepKindBadge(row) && (
                    <span className="shrink-0 rounded-sm bg-muted px-1 py-0.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                      {stepKindBadge(row)}
                    </span>
                  )}
                </div>
                <ReviewSummaryRow row={row} />
              </div>
            </div>
            <ReviewRowAction row={row} onOpenCanvas={onOpenCanvas} />
          </li>
        ))}
      </ul>
      <div className="flex justify-end">
        <Button disabled={!canFinishNow} onClick={onFinish} type="button">
          Finish &amp; view org
          <ArrowRight aria-hidden="true" className="ml-1.5 h-3.5 w-3.5" />
        </Button>
      </div>
    </StepShell>
  );
}

function ReviewSummaryRow({ row }: { row: WizardReviewRow }) {
  const outcome = row.outcome;
  if (!outcome || outcome.step === "skipped") {
    return (
      <p className="mt-0.5 text-xs italic text-muted-foreground">skipped</p>
    );
  }
  if (outcome.kind === "node") {
    return (
      <p className="mt-0.5 truncate font-mono text-2xs text-muted-foreground">
        {outcome.name} · {outcome.dtag}
        {outcome.parent ? ` · child of ${outcome.parent}` : " · org root"}
      </p>
    );
  }
  if (outcome.kind === "grant") {
    return (
      <p className="mt-0.5 truncate font-mono text-2xs text-muted-foreground">
        {outcome.verbs.join(", ") || "no verbs"} →{" "}
        {truncatePubkey(outcome.grantee)}
      </p>
    );
  }
  return (
    <p className="mt-0.5 truncate font-mono text-2xs text-muted-foreground">
      {outcome.subjectLabel} · {outcome.window} · {outcome.limitsText}
    </p>
  );
}

function ReviewRowAction({
  row,
  onOpenCanvas,
}: {
  row: WizardReviewRow;
  onOpenCanvas: (dtag: string) => void;
}) {
  const outcome = row.outcome;
  if (!outcome || outcome.step === "skipped" || outcome.kind !== "node") {
    return null;
  }
  return (
    <Button
      aria-label={`View ${outcome.name} on the canvas`}
      className="h-6 shrink-0 gap-0.5 px-2 text-2xs text-muted-foreground"
      onClick={() => onOpenCanvas(outcome.dtag)}
      type="button"
      variant="ghost"
    >
      View on canvas
      <ChevronRight aria-hidden="true" className="h-3 w-3" />
    </Button>
  );
}

// ── OrgWizard ──────────────────────────────────────────────────────────────

export function OrgWizard({
  autoOpen,
  nodes,
  onFinish,
  onOpenCanvas,
}: OrgWizardProps) {
  const [open, setOpen] = React.useState(autoOpen);
  const [wizard, setWizard] = React.useState<OrgWizardState>(() =>
    initialWizardState(),
  );
  const [stepError, setStepError] = React.useState<string | null>(null);
  const createNodeMutation = useCreateOrgNodeMutation();
  const createGrantMutation = useCreateOrgGrantMutation();
  const createBudgetMutation = useCreateOrgBudgetMutation();
  const identityQuery = useIdentityQuery();

  // The empty-chart signal re-offers the wizard. Root deleted → autoOpen
  // flips true → reopen with a fresh walk (no stale outcomes).
  React.useEffect(() => {
    if (autoOpen) {
      setWizard(initialWizardState());
      setOpen(true);
    }
  }, [autoOpen]);

  const step = currentStepId(wizard);
  const rootOutcome = wizard.outcomes.root;
  const madeEntity = (outcome: WizardOutcome | undefined) =>
    outcome && outcome.step !== "skipped" ? outcome : undefined;
  const rootMade = madeEntity(rootOutcome);
  const rootNodeOutcome = rootMade?.kind === "node" ? rootMade : undefined;
  const rootDtag = rootNodeOutcome?.dtag ?? nodes[0]?.dtag ?? "";
  const rootName = rootNodeOutcome?.name ?? nodes[0]?.name ?? "";
  const granteePubkey = identityQuery.data?.pubkey ?? "";
  const busy =
    createNodeMutation.isPending ||
    createGrantMutation.isPending ||
    createBudgetMutation.isPending;

  const publishNode = React.useCallback(
    async (
      input: {
        dtag: string;
        name: string;
        kind: "role" | "team" | "agent_seat";
        parent?: string;
      },
      stepId: "root" | "seat",
    ) => {
      setStepError(null);
      try {
        await createNodeMutation.mutateAsync(input);
        const outcome: WizardOutcome = {
          step: stepId,
          kind: "node",
          dtag: input.dtag,
          name: input.name,
          nodeKind: input.kind,
          ...(input.parent ? { parent: input.parent } : {}),
        };
        setWizard((current) => recordOutcome(current, stepId, outcome));
        setStepError(null);
      } catch (error) {
        setStepError(
          error instanceof Error
            ? error.message
            : "Failed to publish the org node.",
        );
      }
    },
    [createNodeMutation],
  );

  const publishGrant = React.useCallback(
    async (dtag: string, grantee: string, via: string, verbs: string[]) => {
      setStepError(null);
      try {
        await createGrantMutation.mutateAsync({ dtag, grantee, via, verbs });
        const outcome: WizardOutcome = {
          step: "grant",
          kind: "grant",
          dtag,
          grantee,
          via,
          verbs,
        };
        setWizard((current) => recordOutcome(current, "grant", outcome));
        setStepError(null);
      } catch (error) {
        setStepError(
          error instanceof Error
            ? error.message
            : "Failed to publish the grant.",
        );
      }
    },
    [createGrantMutation],
  );

  const publishBudget = React.useCallback(
    async (input: BudgetSubmitInput) => {
      setStepError(null);
      try {
        await createBudgetMutation.mutateAsync({
          dtag: input.dtag,
          subject: input.subject,
          window: input.window,
          limits: { runs: input.runs, spend: input.spendAmount },
        });
        const outcome: WizardOutcome = {
          step: "budget",
          kind: "budget",
          dtag: input.dtag,
          subject: input.subject,
          subjectLabel: input.subjectLabel,
          window: input.window,
          limitsText: budgetLimitsText(input),
        };
        setWizard((current) => recordOutcome(current, "budget", outcome));
        setStepError(null);
      } catch (error) {
        setStepError(
          error instanceof Error
            ? error.message
            : "Failed to publish the budget.",
        );
      }
    },
    [createBudgetMutation],
  );

  const handleSkip = React.useCallback((id: "seat" | "grant" | "budget") => {
    setStepError(null);
    setWizard((current) => skipStep(current, id));
  }, []);

  const handleFinish = React.useCallback(() => {
    if (!canFinish(wizard)) return;
    setOpen(false);
    onFinish();
  }, [wizard, onFinish]);

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!nextOpen && busy) return;
        setOpen(nextOpen);
      }}
      open={open}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create your org</DialogTitle>
          <DialogDescription>
            Five quick steps publish real org events on this community’s relay.
            Skipped steps stay listed as skipped in the review.
          </DialogDescription>
        </DialogHeader>
        <div className="px-1 pb-1 pt-2">
          <StepProgress
            currentStep={wizard.position}
            totalSteps={WIZARD_TOTAL_STEPS}
          />
        </div>
        <div className="max-h-[60vh] overflow-y-auto pr-1">
          {step === "root" && (
            <RootStep
              disabled={nodes.some((node) => !node.revoked)}
              error={stepError}
              onSubmit={(name, dtag) =>
                void publishNode({ dtag, name, kind: "role" }, "root")
              }
              pending={createNodeMutation.isPending}
            />
          )}
          {step === "seat" && (
            <SeatStep
              disabled={!rootDtag}
              error={stepError}
              onSkip={() => handleSkip("seat")}
              onSubmit={(name, dtag, kind) =>
                void publishNode({ dtag, name, kind, parent: rootDtag }, "seat")
              }
              parentDtag={rootDtag}
              parentName={rootName}
              pending={createNodeMutation.isPending}
            />
          )}
          {step === "grant" && (
            <GrantStep
              disabled={!rootDtag || !granteePubkey}
              error={stepError}
              grantee={granteePubkey}
              onSkip={() => handleSkip("grant")}
              onSubmit={(dtag, grantee, via, verbs) =>
                void publishGrant(dtag, grantee, via, verbs)
              }
              pending={createGrantMutation.isPending}
              viaDtag={rootDtag}
              viaName={rootName}
            />
          )}
          {step === "budget" && (
            <BudgetStep
              disabled={!rootDtag}
              error={stepError}
              onSkip={() => handleSkip("budget")}
              onSubmit={(input) => void publishBudget(input)}
              nodes={nodes}
              pending={createBudgetMutation.isPending}
            />
          )}
          {step === "review" && (
            <ReviewStep
              canFinishNow={canFinish(wizard)}
              onFinish={handleFinish}
              onOpenCanvas={onOpenCanvas}
              state={wizard}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

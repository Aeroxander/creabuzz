import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/shared/ui/dialog";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { useCreateOrgBudgetMutation } from "../hooks";
import {
  BUDGET_LIMIT_FIELDS,
  ENFORCEMENT_LABEL,
  budgetSubjectError,
  isLimitFieldValid,
  parseLimitField,
  type BudgetEnforcement,
  type BudgetLimitField,
  type BudgetLimitInput,
  type BudgetLimitKey,
} from "../lib/budgetForm";
import { OrgEntityPicker } from "./OrgEntityPicker";
import { useBudgetSubjectOptions } from "./useBudgetSubjects";
import type { OrgNode } from "../orgModels";

type OrgBudgetFormProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nodes: OrgNode[];
};

const WINDOW_OPTIONS = [
  { value: "epoch", label: "Epoch" },
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
] as const;

type LimitDrafts = Record<BudgetLimitKey, string>;

const EMPTY_DRAFTS: LimitDrafts = {
  runs: "",
  messages: "",
  llmCalls: "",
  llmCostCents: "",
  taskCreate: "",
  proposals: "",
  taskApprove: "",
  spend: "",
};

const GROUPS: readonly {
  enforcement: BudgetEnforcement;
  hint: string;
}[] = [
  {
    enforcement: "relay",
    hint: "The relay counts these and turns an overrun into an approval request.",
  },
  {
    enforcement: "advisory",
    hint: "Recorded and shown, but the relay cannot stop them.",
  },
];

function draftsToInput(drafts: LimitDrafts): BudgetLimitInput {
  const input: BudgetLimitInput = {};
  for (const field of BUDGET_LIMIT_FIELDS) {
    const value = parseLimitField(drafts[field.key]);
    if (value !== undefined) input[field.key] = value;
  }
  return input;
}

export function OrgBudgetForm({
  open,
  onOpenChange,
  nodes,
}: OrgBudgetFormProps) {
  const moveWindowSelection = (step: number) => {
    setWindow((prev) => {
      const index = WINDOW_OPTIONS.findIndex((opt) => opt.value === prev);
      const next =
        WINDOW_OPTIONS[
          (index + step + WINDOW_OPTIONS.length) % WINDOW_OPTIONS.length
        ];
      return next.value;
    });
  };

  const [dtag, setDtag] = React.useState("");
  const [subject, setSubject] = React.useState<string | null>(null);
  const [window, setWindow] = React.useState<
    "epoch" | "day" | "week" | "month"
  >("month");
  const [drafts, setDrafts] = React.useState<LimitDrafts>(EMPTY_DRAFTS);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const dtagRef = React.useRef<HTMLInputElement>(null);
  const createMutation = useCreateOrgBudgetMutation();
  const { options: subjectOptions, communityDefaultAvailable } =
    useBudgetSubjectOptions(nodes);

  React.useEffect(() => {
    if (!open) return;
    setDtag("");
    setSubject(null);
    setWindow("month");
    setDrafts(EMPTY_DRAFTS);
    setErrorMessage(null);
    const timerId = globalThis.setTimeout(() => {
      dtagRef.current?.focus();
    }, 50);
    return () => globalThis.clearTimeout(timerId);
  }, [open]);

  const limitsValid = BUDGET_LIMIT_FIELDS.every((field) =>
    isLimitFieldValid(drafts[field.key]),
  );
  const canSubmit =
    dtag.trim().length > 0 &&
    budgetSubjectError(subject) === null &&
    limitsValid &&
    !createMutation.isPending;

  const handleSubmit = React.useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!canSubmit) return;
      setErrorMessage(null);
      void (async () => {
        try {
          await createMutation.mutateAsync({
            dtag: dtag.trim(),
            subject: subject ?? "",
            window,
            limits: draftsToInput(drafts),
          });
          onOpenChange(false);
        } catch (error) {
          setErrorMessage(
            error instanceof Error ? error.message : "Failed to create budget.",
          );
        }
      })();
    },
    [dtag, subject, window, drafts, canSubmit, createMutation, onOpenChange],
  );

  const renderLimit = (field: BudgetLimitField) => {
    const inputId = `org-budget-limit-${field.key}`;
    const noteId = `${inputId}-note`;
    return (
      <div className="space-y-1.5" key={field.key}>
        <label
          className="text-sm font-medium text-foreground"
          htmlFor={inputId}
        >
          {field.label}
        </label>
        <Input
          aria-describedby={field.note ? noteId : undefined}
          disabled={createMutation.isPending}
          id={inputId}
          min="0"
          onChange={(event) =>
            setDrafts((current) => ({
              ...current,
              [field.key]: event.target.value,
            }))
          }
          placeholder={field.placeholder}
          step="1"
          type="number"
          value={drafts[field.key]}
        />
        {field.note ? (
          <p className="text-2xs text-muted-foreground" id={noteId}>
            {field.note}
          </p>
        ) : null}
      </div>
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && createMutation.isPending) return;
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create Budget</DialogTitle>
          <DialogDescription>
            Bound what one agent — or every agent by default — may do in a
            window.
          </DialogDescription>
        </DialogHeader>
        <form
          id="org-budget-form"
          onSubmit={handleSubmit}
          className="max-h-[60vh] space-y-4 overflow-y-auto pr-1"
        >
          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor="org-budget-dtag"
            >
              Budget ID
            </label>
            <Input
              disabled={createMutation.isPending}
              id="org-budget-dtag"
              onChange={(event) => setDtag(event.target.value)}
              placeholder="e.g. budget-monthly-runs"
              ref={dtagRef}
              value={dtag}
            />
          </div>
          <div className="space-y-1.5">
            <OrgEntityPicker
              disabled={createMutation.isPending}
              emptyMessage="No agents are seated in the org yet. Put an agent in a seat first."
              mode="single"
              onChange={setSubject}
              options={subjectOptions}
              searchPlaceholder="Search agents..."
              selected={subject}
              triggerLabel="Subject"
            />
            {communityDefaultAvailable ? null : (
              <p className="text-2xs text-muted-foreground">
                Only the community owner or an admin can set the default budget
                for all agents.
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <span
              className="text-sm font-medium text-foreground"
              id="org-budget-window-label"
            >
              Window
            </span>
            <div
              aria-labelledby="org-budget-window-label"
              className="flex gap-2"
              onKeyDown={(event) => {
                if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                  event.preventDefault();
                  moveWindowSelection(1);
                } else if (
                  event.key === "ArrowLeft" ||
                  event.key === "ArrowUp"
                ) {
                  event.preventDefault();
                  moveWindowSelection(-1);
                }
              }}
              role="radiogroup"
            >
              {WINDOW_OPTIONS.map((opt) => (
                <Button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={window === opt.value}
                  tabIndex={window === opt.value ? 0 : -1}
                  variant={window === opt.value ? "default" : "outline"}
                  size="sm"
                  disabled={createMutation.isPending}
                  onClick={() => setWindow(opt.value)}
                >
                  {opt.label}
                </Button>
              ))}
            </div>
          </div>
          {GROUPS.map((group) => (
            <fieldset
              className="m-0 space-y-2 rounded-md border border-border/60 p-3"
              data-testid={`org-budget-group-${group.enforcement}`}
              key={group.enforcement}
            >
              <legend className="px-1 text-xs font-semibold text-foreground">
                {ENFORCEMENT_LABEL[group.enforcement]}
              </legend>
              <p className="text-2xs text-muted-foreground">{group.hint}</p>
              <div className="grid grid-cols-2 gap-3">
                {BUDGET_LIMIT_FIELDS.filter(
                  (field) => field.enforcement === group.enforcement,
                ).map(renderLimit)}
              </div>
            </fieldset>
          ))}
          {limitsValid ? null : (
            <p className="text-sm text-destructive" role="alert">
              Limits must be whole numbers, 0 or more.
            </p>
          )}
          {errorMessage ? (
            <p className="text-sm text-destructive" role="alert">
              {errorMessage}
            </p>
          ) : null}
        </form>
        <DialogFooter>
          <Button disabled={!canSubmit} form="org-budget-form" type="submit">
            {createMutation.isPending ? "Creating..." : "Create Budget"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

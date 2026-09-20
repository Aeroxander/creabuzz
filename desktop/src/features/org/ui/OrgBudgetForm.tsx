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
import { OrgEntityPicker, type OrgPickerOption } from "./OrgEntityPicker";
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
  const [spendAmount, setSpendAmount] = React.useState("");
  const [runs, setRuns] = React.useState("");
  const [taskCreate, setTaskCreate] = React.useState("");
  const [taskApprove, setTaskApprove] = React.useState("");
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const dtagRef = React.useRef<HTMLInputElement>(null);
  const createMutation = useCreateOrgBudgetMutation();

  React.useEffect(() => {
    if (!open) return;
    setDtag("");
    setSubject("");
    setWindow("month");
    setSpendAmount("");
    setRuns("");
    setTaskCreate("");
    setTaskApprove("");
    setErrorMessage(null);
    const timerId = globalThis.setTimeout(() => {
      dtagRef.current?.focus();
    }, 50);
    return () => globalThis.clearTimeout(timerId);
  }, [open]);

  const subjectOptions = React.useMemo<OrgPickerOption[]>(
    () =>
      nodes.map((node) => ({
        id: node.dtag,
        label: node.name,
        kindBadge: node.kind,
      })),
    [nodes],
  );

  const canSubmit =
    dtag.trim().length > 0 &&
    subject !== null &&
    subject.trim().length > 0 &&
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
            subject: (subject ?? "").trim(),
            window,
            spendAmount: spendAmount
              ? Number.parseInt(spendAmount, 10)
              : undefined,
            runs: runs ? Number.parseInt(runs, 10) : undefined,
            taskCreate: taskCreate
              ? Number.parseInt(taskCreate, 10)
              : undefined,
            taskApprove: taskApprove
              ? Number.parseInt(taskApprove, 10)
              : undefined,
          });
          onOpenChange(false);
        } catch (error) {
          setErrorMessage(
            error instanceof Error ? error.message : "Failed to create budget.",
          );
        }
      })();
    },
    [
      dtag,
      subject,
      window,
      spendAmount,
      runs,
      taskCreate,
      taskApprove,
      canSubmit,
      createMutation,
      onOpenChange,
    ],
  );

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
            Set spending, run, or task limits for an agent or node.
          </DialogDescription>
        </DialogHeader>
        <form
          id="org-budget-form"
          onSubmit={handleSubmit}
          className="space-y-4"
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
          <OrgEntityPicker
            disabled={createMutation.isPending}
            emptyMessage="No org nodes yet. Create a node first."
            mode="single"
            onChange={setSubject}
            options={subjectOptions}
            searchPlaceholder="Search nodes..."
            selected={subject}
            triggerLabel="Subject"
          />
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
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label
                className="text-sm font-medium text-foreground"
                htmlFor="org-budget-runs"
              >
                Max Runs
              </label>
              <Input
                disabled={createMutation.isPending}
                id="org-budget-runs"
                onChange={(event) => setRuns(event.target.value)}
                placeholder="e.g. 100"
                type="number"
                min="0"
                value={runs}
              />
            </div>
            <div className="space-y-1.5">
              <label
                className="text-sm font-medium text-foreground"
                htmlFor="org-budget-spend"
              >
                Max Spend (cents)
              </label>
              <Input
                disabled={createMutation.isPending}
                id="org-budget-spend"
                onChange={(event) => setSpendAmount(event.target.value)}
                placeholder="e.g. 50000"
                type="number"
                min="0"
                value={spendAmount}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label
                className="text-sm font-medium text-foreground"
                htmlFor="org-budget-task-create"
              >
                Task Create Limit
              </label>
              <Input
                disabled={createMutation.isPending}
                id="org-budget-task-create"
                onChange={(event) => setTaskCreate(event.target.value)}
                placeholder="e.g. 10"
                type="number"
                min="0"
                value={taskCreate}
              />
            </div>
            <div className="space-y-1.5">
              <label
                className="text-sm font-medium text-foreground"
                htmlFor="org-budget-task-approve"
              >
                Task Approve Limit
              </label>
              <Input
                disabled={createMutation.isPending}
                id="org-budget-task-approve"
                onChange={(event) => setTaskApprove(event.target.value)}
                placeholder="e.g. 5"
                type="number"
                min="0"
                value={taskApprove}
              />
            </div>
          </div>
          {errorMessage ? (
            <p className="text-sm text-destructive">{errorMessage}</p>
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

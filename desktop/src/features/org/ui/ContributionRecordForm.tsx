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
import { Textarea } from "@/shared/ui/textarea";
import { signRelayEvent } from "@/shared/api/tauri";
import { relayClient } from "@/shared/api/relayClient";
import { KIND_CONTRIBUTION_RECORD } from "@/shared/constants/kinds";
import { useQueryClient } from "@tanstack/react-query";
import {
  orgQueryKey,
  useAgentTasksQuery,
  useContributionRecordsQuery,
} from "../hooks";
import { OrgEntityPicker, type OrgPickerOption } from "./OrgEntityPicker";

type ContributionRecordFormProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type DimensionRow = { key: string; value: string; id: string };

let nextDimId = 0;
const makeDimId = () => `dim-${++nextDimId}`;

export function ContributionRecordForm({
  open,
  onOpenChange,
}: ContributionRecordFormProps) {
  const queryClient = useQueryClient();
  const [dtag, setDtag] = React.useState("");
  const [action, setAction] = React.useState("");
  const [dimensions, setDimensions] = React.useState<DimensionRow[]>([
    { key: "", value: "", id: makeDimId() },
  ]);
  const [humanPct, setHumanPct] = React.useState("100");
  const [aiPct, setAiPct] = React.useState("0");
  const [evidence, setEvidence] = React.useState<string[]>([]);
  const [informedBy, setInformedBy] = React.useState<string[]>([]);
  const [pasteOpen, setPasteOpen] = React.useState(false);
  const [pasteText, setPasteText] = React.useState("");
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [isCreating, setIsCreating] = React.useState(false);
  const dtagRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!open) return;
    setDtag("");
    setAction("");
    setDimensions([{ key: "", value: "", id: makeDimId() }]);
    setHumanPct("100");
    setAiPct("0");
    setEvidence([]);
    setInformedBy([]);
    setPasteOpen(false);
    setPasteText("");
    setErrorMessage(null);
    const timerId = globalThis.setTimeout(() => {
      dtagRef.current?.focus();
    }, 50);
    return () => globalThis.clearTimeout(timerId);
  }, [open]);

  const recordsQuery = useContributionRecordsQuery();
  const tasksQuery = useAgentTasksQuery();

  const informedByOptions = React.useMemo<OrgPickerOption[]>(
    () =>
      (recordsQuery.data ?? []).map((record) => ({
        id: record.dtag,
        label: record.action,
        sub: new Date(record.createdAt * 1000).toISOString().slice(0, 10),
      })),
    [recordsQuery.data],
  );

  const evidenceOptions = React.useMemo<OrgPickerOption[]>(
    () =>
      (tasksQuery.data ?? []).map((task) => ({
        id: task.eventId,
        label: task.status ? `${task.title} (${task.status})` : task.title,
        sub: task.dtag || undefined,
      })),
    [tasksQuery.data],
  );

  const addPastedEvidence = () => {
    const ids = pasteText
      .split(/[\s,]+/)
      .map((id) => id.trim())
      .filter(Boolean);
    if (ids.length === 0) return;
    setEvidence((prev) => [...new Set([...prev, ...ids])]);
    setPasteText("");
    setPasteOpen(false);
  };

  const canSubmit =
    dtag.trim().length > 0 && action.trim().length > 0 && !isCreating;

  const addDimension = () => {
    setDimensions((prev) => [...prev, { key: "", value: "", id: makeDimId() }]);
  };

  const updateDimension = (
    index: number,
    field: "key" | "value",
    value: string,
  ) => {
    setDimensions((prev) =>
      prev.map((d, i) => (i === index ? { ...d, [field]: value } : d)),
    );
  };

  const removeDimension = (index: number) => {
    setDimensions((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = React.useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!canSubmit) return;
      setErrorMessage(null);
      setIsCreating(true);
      void (async () => {
        try {
          const dims: Record<string, number> = {};
          for (const d of dimensions) {
            const k = d.key.trim();
            const v = Number.parseFloat(d.value);
            if (k && !Number.isNaN(v)) {
              dims[k] = v;
            }
          }
          const evidenceLinks = evidence;
          const informedByRefs = informedBy;
          const content = JSON.stringify({
            v: 1,
            action: action.trim(),
            dimensions: dims,
            evidence: evidenceLinks,
            humanVsAi: {
              human: Number.parseFloat(humanPct) / 100,
              ai: Number.parseFloat(aiPct) / 100,
            },
            informedBy: informedByRefs,
            reviewStatus: "pending",
            appealHistory: [],
          });
          const tags: string[][] = [["d", dtag.trim()]];
          for (const e of evidenceLinks) {
            tags.push(["e", e]);
          }
          for (const a of informedByRefs) {
            tags.push(["a", a]);
          }
          const event = await signRelayEvent({
            kind: KIND_CONTRIBUTION_RECORD,
            content,
            tags,
          });
          await relayClient.publishEvent(
            event,
            "Timed out creating contribution record.",
            "Failed to create contribution record.",
          );
          await queryClient.invalidateQueries({
            queryKey: [...orgQueryKey, "contributions"],
          });
          await queryClient.invalidateQueries({
            queryKey: [...orgQueryKey, "chart"],
          });
          onOpenChange(false);
        } catch (error) {
          setErrorMessage(
            error instanceof Error
              ? error.message
              : "Failed to create contribution record.",
          );
        } finally {
          setIsCreating(false);
        }
      })();
    },
    [
      dtag,
      action,
      dimensions,
      humanPct,
      aiPct,
      evidence,
      informedBy,
      canSubmit,
      queryClient,
      onOpenChange,
    ],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && isCreating) return;
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create Contribution Record</DialogTitle>
          <DialogDescription>
            Record a contribution with multi-dimensional scoring and human/AI
            attribution.
          </DialogDescription>
        </DialogHeader>
        <form
          id="contribution-record-form"
          onSubmit={handleSubmit}
          className="space-y-4"
        >
          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor="cr-dtag"
            >
              Record ID
            </label>
            <Input
              disabled={isCreating}
              id="cr-dtag"
              onChange={(event) => setDtag(event.target.value)}
              placeholder="e.g. cr-feature-build-001"
              ref={dtagRef}
              value={dtag}
            />
          </div>
          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor="cr-action"
            >
              Action Description
            </label>
            <Input
              disabled={isCreating}
              id="cr-action"
              onChange={(event) => setAction(event.target.value)}
              placeholder="e.g. Built the org chart feature"
              value={action}
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span
                className="text-sm font-medium text-foreground"
                id="cr-dimensions-label"
              >
                Dimensions
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 text-xs"
                disabled={isCreating}
                onClick={addDimension}
              >
                + Add
              </Button>
            </div>
            {dimensions.map((dim, index) => (
              <div key={dim.id} className="flex gap-2">
                <Input
                  disabled={isCreating}
                  onChange={(event) =>
                    updateDimension(index, "key", event.target.value)
                  }
                  placeholder="e.g. build"
                  value={dim.key}
                />
                <Input
                  disabled={isCreating}
                  onChange={(event) =>
                    updateDimension(index, "value", event.target.value)
                  }
                  placeholder="0.0–1.0"
                  type="number"
                  min="0"
                  max="1"
                  step="0.1"
                  value={dim.value}
                />
                {dimensions.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="shrink-0 px-2 text-destructive"
                    disabled={isCreating}
                    onClick={() => removeDimension(index)}
                  >
                    ×
                  </Button>
                )}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label
                className="text-sm font-medium text-foreground"
                htmlFor="cr-human-pct"
              >
                Human %
              </label>
              <Input
                disabled={isCreating}
                id="cr-human-pct"
                onChange={(event) => setHumanPct(event.target.value)}
                type="number"
                min="0"
                max="100"
                value={humanPct}
              />
            </div>
            <div className="space-y-1.5">
              <label
                className="text-sm font-medium text-foreground"
                htmlFor="cr-ai-pct"
              >
                AI %
              </label>
              <Input
                disabled={isCreating}
                id="cr-ai-pct"
                onChange={(event) => setAiPct(event.target.value)}
                type="number"
                min="0"
                max="100"
                value={aiPct}
              />
            </div>
          </div>
          <OrgEntityPicker
            disabled={isCreating}
            emptyMessage={
              tasksQuery.data?.length
                ? undefined
                : "No agent tasks found. Paste event IDs below or run some tasks first."
            }
            mode="multi"
            onChange={setEvidence}
            options={evidenceOptions}
            searchPlaceholder="Search agent tasks..."
            selected={evidence}
            triggerLabel="Evidence"
          />
          <div className="space-y-1.5">
            <Button
              aria-expanded={pasteOpen}
              className="h-6 px-0 text-xs"
              disabled={isCreating}
              onClick={() => setPasteOpen((prev) => !prev)}
              size="sm"
              type="button"
              variant="ghost"
            >
              {pasteOpen ? "− Hide paste IDs" : "+ Paste IDs"}
            </Button>
            {pasteOpen ? (
              <div className="space-y-1.5">
                <Textarea
                  aria-label="Paste evidence event IDs or URLs"
                  disabled={isCreating}
                  onChange={(event) => setPasteText(event.target.value)}
                  placeholder="One event ID or URL per line (or comma-separated)"
                  rows={3}
                  value={pasteText}
                />
                <Button
                  disabled={isCreating || !pasteText.trim()}
                  onClick={addPastedEvidence}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Add to Evidence
                </Button>
              </div>
            ) : null}
          </div>
          <OrgEntityPicker
            disabled={isCreating}
            emptyMessage={
              informedByOptions.length > 0
                ? undefined
                : "No contribution records yet. Create one first."
            }
            mode="multi"
            onChange={setInformedBy}
            options={informedByOptions}
            searchPlaceholder="Search contribution records..."
            selected={informedBy}
            triggerLabel="Informed By"
          />
          {errorMessage ? (
            <p className="text-sm text-destructive">{errorMessage}</p>
          ) : null}
        </form>
        <DialogFooter>
          <Button
            disabled={!canSubmit}
            form="contribution-record-form"
            type="submit"
          >
            {isCreating ? "Creating..." : "Create Record"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

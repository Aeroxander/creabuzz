import * as React from "react";
import { Braces, RefreshCw, Save } from "lucide-react";

import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Spinner } from "@/shared/ui/spinner";
import { Textarea } from "@/shared/ui/textarea";

import {
  defaultStrategyState,
  parseStrategyJsonText,
  strategyStateFromJson,
  suggestStrategyId,
  toStrategyJson,
  validateStrategyState,
  type StrategyFormState,
} from "../lib/strategyForm";
import { useStrategyPutMutation } from "../strategyHooks";
import { StrategyForm } from "./StrategyForm";

export type StrategyFormInitial = {
  /** The strategy's `d` tag — fixed in edit mode. */
  id: string;
  /** The existing kind:44020 content object. */
  content: Record<string, unknown>;
};

type StrategyFormDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = create mode; set = edit mode (publish replaces this head). */
  initial?: StrategyFormInitial | null;
};

function prettyJson(state: StrategyFormState): string {
  return JSON.stringify(toStrategyJson(state), null, 2);
}

export function StrategyFormDialog({
  open,
  onOpenChange,
  initial = null,
}: StrategyFormDialogProps) {
  const editing = initial !== null;
  const [state, setState] = React.useState<StrategyFormState>(() =>
    initial
      ? strategyStateFromJson(initial.content, { id: initial.id })
      : defaultStrategyState(),
  );
  const [revealed, setRevealed] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [idTouched, setIdTouched] = React.useState(false);
  const [view, setView] = React.useState<"form" | "json">("form");
  const [jsonText, setJsonText] = React.useState("");
  const [jsonError, setJsonError] = React.useState<string | null>(null);
  const putMutation = useStrategyPutMutation();

  // Reset the form each time the dialog opens (create vs edit seed).
  React.useEffect(() => {
    if (!open) return;
    setState(
      initial
        ? strategyStateFromJson(initial.content, { id: initial.id })
        : defaultStrategyState(),
    );
    setRevealed(new Set());
    setIdTouched(false);
    setView("form");
    setJsonText("");
    setJsonError(null);
  }, [open, initial]);

  const errors = React.useMemo(() => validateStrategyState(state), [state]);
  const errorKeys = Object.keys(errors);
  const hasErrors = errorKeys.length > 0;

  const applyState = (next: StrategyFormState) => {
    if (next.id !== state.id) setIdTouched(true);
    // Slug-sync the id from the name until the user edits it (create mode).
    if (!idTouched && !editing && next.name !== state.name) {
      setState({ ...next, id: suggestStrategyId(next.name) });
      return;
    }
    setState(next);
  };

  const toggleJsonView = () => {
    if (view === "json") {
      setView("form");
      return;
    }
    // Regenerate from state unless unparsed edits are pending — those must
    // not be silently discarded (the strip keeps the Reset affordance).
    if (jsonError === null) {
      setJsonText(prettyJson(state));
    }
    setView("json");
  };

  const resetJson = () => {
    setJsonText(prettyJson(state));
    setJsonError(null);
  };

  const onJsonChange = (text: string) => {
    setJsonText(text);
    const result = parseStrategyJsonText(text, { id: state.id });
    if (result.ok) {
      setJsonError(null);
      setState(result.state);
    } else {
      setJsonError(result.error);
    }
  };

  const blocked = hasErrors || jsonError !== null;
  const canSubmit = !blocked && !putMutation.isPending;

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setRevealed((prev) => new Set([...prev, ...errorKeys]));
    if (!canSubmit) return;
    putMutation.mutate(
      { id: state.id.trim(), content: toStrategyJson(state) },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!nextOpen && putMutation.isPending) return;
        onOpenChange(nextOpen);
      }}
      open={open}
    >
      <DialogContent className="max-w-xl" data-testid="org-strategy-dialog">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {editing ? `Edit strategy ${initial.id}` : "New strategy"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {editing
              ? "Publishing signs the revision with your key and replaces this strategy's latest head (newest wins)."
              : "Publishing signs the strategy with your key and adds it to the shared strategy bank."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between gap-2">
          <p className="text-2xs text-muted-foreground">
            {view === "json"
              ? "Editing raw JSON — the form tracks it"
              : "Fill the fields, or switch to raw JSON"}
          </p>
          <Button
            aria-pressed={view === "json"}
            data-testid="org-strategy-json-toggle"
            disabled={putMutation.isPending}
            onClick={toggleJsonView}
            size="sm"
            type="button"
            variant={view === "json" ? "secondary" : "ghost"}
          >
            <Braces aria-hidden="true" className="h-3.5 w-3.5" />
            Advanced JSON
          </Button>
        </div>

        {jsonError !== null ? (
          <div
            className="space-y-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2"
            data-testid="org-strategy-json-error"
          >
            <p className="text-xs text-destructive" role="alert">
              {jsonError} — fix the JSON or reset it to the last valid state.
            </p>
            <Button
              data-testid="org-strategy-json-reset"
              disabled={putMutation.isPending}
              onClick={resetJson}
              size="sm"
              type="button"
              variant="outline"
            >
              <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
              Reset JSON
            </Button>
          </div>
        ) : null}

        <form
          className="max-h-[65vh] space-y-4 overflow-y-auto pr-1"
          id="org-strategy-form"
          onSubmit={handleSubmit}
        >
          {view === "json" ? (
            <div className="space-y-1.5">
              <label
                className="text-xs font-medium"
                htmlFor="org-strategy-json"
              >
                Strategy (JSON)
              </label>
              <Textarea
                className="min-h-72 resize-y font-mono text-2xs"
                data-testid="org-strategy-json"
                disabled={putMutation.isPending}
                id="org-strategy-json"
                onChange={(event) => onJsonChange(event.target.value)}
                spellCheck={false}
                value={jsonText}
              />
            </div>
          ) : (
            <StrategyForm
              disabled={putMutation.isPending}
              errors={errors}
              idReadOnly={editing}
              onChange={applyState}
              onReveal={(key) => setRevealed((prev) => new Set([...prev, key]))}
              revealed={revealed}
              state={state}
            />
          )}
        </form>

        {putMutation.isPending ? (
          <div
            className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2"
            data-testid="org-strategy-publish-progress"
          >
            <Spinner aria-hidden="true" className="h-4 w-4" />
            <p className="text-xs text-muted-foreground">
              Signing and publishing the strategy…
            </p>
          </div>
        ) : null}
        {putMutation.isError ? (
          <p
            className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            data-testid="org-strategy-publish-error"
            role="alert"
          >
            {putMutation.error instanceof Error
              ? putMutation.error.message
              : "Publishing failed."}
          </p>
        ) : null}

        <DialogFooter>
          <p
            className="mr-auto self-center text-2xs text-muted-foreground"
            role="status"
          >
            {blocked && jsonError === null && hasErrors
              ? `${errorKeys.length} field${errorKeys.length === 1 ? "" : "s"} to fix before publishing`
              : ""}
          </p>
          <Button
            data-testid="org-strategy-publish"
            disabled={!canSubmit}
            form="org-strategy-form"
            type="submit"
          >
            {putMutation.isPending ? (
              <>
                <RefreshCw
                  aria-hidden="true"
                  className="h-3.5 w-3.5 animate-spin"
                />
                Publishing…
              </>
            ) : (
              <>
                <Save aria-hidden="true" className="h-3.5 w-3.5" />
                Publish strategy
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

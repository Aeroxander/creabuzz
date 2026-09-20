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
import { useCreateOrgGrantMutation } from "../hooks";
import { OrgEntityPicker, type OrgPickerOption } from "./OrgEntityPicker";
import type { OrgNode } from "../orgModels";

type OrgGrantFormProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nodes: OrgNode[];
};

const VERB_PRESETS = [
  "read",
  "write",
  "admin",
  "task:create",
  "task:approve",
  "spend:10000",
];

export function OrgGrantForm({ open, onOpenChange, nodes }: OrgGrantFormProps) {
  const [dtag, setDtag] = React.useState("");
  const [grantee, setGrantee] = React.useState<string | null>(null);
  const [via, setVia] = React.useState("");
  const [verbs, setVerbs] = React.useState<string[]>([]);
  const [customVerb, setCustomVerb] = React.useState("");
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const dtagRef = React.useRef<HTMLInputElement>(null);
  const createMutation = useCreateOrgGrantMutation();

  React.useEffect(() => {
    if (!open) return;
    setDtag("");
    setGrantee("");
    setVia("");
    setVerbs([]);
    setCustomVerb("");
    setErrorMessage(null);
    const timerId = globalThis.setTimeout(() => {
      dtagRef.current?.focus();
    }, 50);
    return () => globalThis.clearTimeout(timerId);
  }, [open]);

  const granteeOptions = React.useMemo<OrgPickerOption[]>(() => {
    const seen = new Map<string, OrgPickerOption>();
    for (const node of nodes) {
      for (const pubkey of [...node.holders, ...node.agentSeats]) {
        if (seen.has(pubkey)) continue;
        seen.set(pubkey, {
          id: pubkey,
          label: node.name,
          sub: node.kind,
          pubkey,
        });
      }
    }
    return [...seen.values()];
  }, [nodes]);

  const canSubmit =
    dtag.trim().length > 0 &&
    grantee !== null &&
    grantee.trim().length === 64 &&
    via.trim().length > 0 &&
    verbs.length > 0 &&
    !createMutation.isPending;

  const addVerb = React.useCallback(
    (verb: string) => {
      const trimmed = verb.trim();
      if (trimmed && !verbs.includes(trimmed)) {
        setVerbs((prev) => [...prev, trimmed]);
      }
    },
    [verbs],
  );

  const removeVerb = React.useCallback((verb: string) => {
    setVerbs((prev) => prev.filter((v) => v !== verb));
  }, []);

  const handleSubmit = React.useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!canSubmit) return;
      setErrorMessage(null);
      void (async () => {
        try {
          await createMutation.mutateAsync({
            dtag: dtag.trim(),
            grantee: (grantee ?? "").trim(),
            via: via.trim(),
            verbs,
          });
          onOpenChange(false);
        } catch (error) {
          setErrorMessage(
            error instanceof Error ? error.message : "Failed to create grant.",
          );
        }
      })();
    },
    [dtag, grantee, via, verbs, canSubmit, createMutation, onOpenChange],
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
          <DialogTitle>Create Grant</DialogTitle>
          <DialogDescription>
            Delegate authority from a node to a grantee with specific verb
            scopes.
          </DialogDescription>
        </DialogHeader>
        <form id="org-grant-form" onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor="org-grant-dtag"
            >
              Grant ID
            </label>
            <Input
              disabled={createMutation.isPending}
              id="org-grant-dtag"
              onChange={(event) => setDtag(event.target.value)}
              placeholder="e.g. grant-leadership-read"
              ref={dtagRef}
              value={dtag}
            />
          </div>
          <OrgEntityPicker
            disabled={createMutation.isPending}
            emptyMessage="No seat holders yet. Add a node with holders first."
            mode="single"
            onChange={setGrantee}
            options={granteeOptions}
            searchPlaceholder="Search holders and agent seats..."
            selected={grantee}
            triggerLabel="Grantee"
          />
          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor="org-grant-via"
            >
              Via (node ID)
            </label>
            <select
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              disabled={createMutation.isPending}
              id="org-grant-via"
              onChange={(event) => setVia(event.target.value)}
              value={via}
            >
              <option value="">Select a node...</option>
              {nodes
                .filter((n) => !n.revoked)
                .map((node) => (
                  <option key={node.dtag} value={node.dtag}>
                    {node.name} ({node.dtag})
                  </option>
                ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <span
              className="text-sm font-medium text-foreground"
              id="org-grant-verbs-label"
            >
              Verbs
            </span>
            <fieldset
              aria-labelledby="org-grant-verbs-label"
              className="flex flex-wrap gap-1.5 border-0 p-0 m-0"
            >
              {VERB_PRESETS.map((verb) => (
                <Button
                  key={verb}
                  type="button"
                  variant={verbs.includes(verb) ? "default" : "outline"}
                  size="sm"
                  className="h-7 text-xs"
                  disabled={createMutation.isPending}
                  onClick={() =>
                    verbs.includes(verb) ? removeVerb(verb) : addVerb(verb)
                  }
                >
                  {verb}
                </Button>
              ))}
            </fieldset>
            <div className="flex gap-1.5">
              <Input
                disabled={createMutation.isPending}
                onChange={(event) => setCustomVerb(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addVerb(customVerb);
                    setCustomVerb("");
                  }
                }}
                placeholder="Custom verb..."
                value={customVerb}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={createMutation.isPending || !customVerb.trim()}
                onClick={() => {
                  addVerb(customVerb);
                  setCustomVerb("");
                }}
              >
                Add
              </Button>
            </div>
            {verbs.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {verbs.map((verb) => (
                  <span
                    key={verb}
                    className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-xs text-primary"
                  >
                    {verb}
                    <button
                      className="ml-0.5 text-primary/60 hover:text-primary"
                      onClick={() => removeVerb(verb)}
                      type="button"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
          {errorMessage ? (
            <p className="text-sm text-destructive">{errorMessage}</p>
          ) : null}
        </form>
        <DialogFooter>
          <Button disabled={!canSubmit} form="org-grant-form" type="submit">
            {createMutation.isPending ? "Creating..." : "Create Grant"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

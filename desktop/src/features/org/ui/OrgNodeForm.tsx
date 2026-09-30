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
import { useCreateOrgNodeMutation } from "../hooks";
import { OrgEntityPicker, type OrgPickerOption } from "./OrgEntityPicker";
import { slugify } from "../lib/pickerOptions";
import { buildOrgTree } from "../lib/tree";
import type { OrgNode } from "../orgModels";

type OrgNodeFormProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Preset parent (used by the "Add Child" action). */
  parentDtag?: string;
  editNode?: OrgNode;
  nodes: OrgNode[];
};

export function OrgNodeForm({
  open,
  onOpenChange,
  parentDtag,
  editNode,
  nodes,
}: OrgNodeFormProps) {
  const [name, setName] = React.useState("");
  const [dtag, setDtag] = React.useState("");
  const [parent, setParent] = React.useState<string | null>(null);
  const [kind, setKind] = React.useState<"role" | "team" | "agent_seat">(
    "role",
  );
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const nameRef = React.useRef<HTMLInputElement>(null);
  const createMutation = useCreateOrgNodeMutation();

  React.useEffect(() => {
    if (!open) return;
    if (editNode) {
      setName(editNode.name);
      setDtag(editNode.dtag);
      setKind(editNode.kind);
      setParent(editNode.parent ?? null);
    } else {
      setName("");
      setDtag("");
      setKind("role");
      setParent(parentDtag ?? null);
    }
    setErrorMessage(null);
    const timerId = globalThis.setTimeout(() => {
      nameRef.current?.focus();
    }, 50);
    return () => globalThis.clearTimeout(timerId);
  }, [open, editNode, parentDtag]);

  const handleNameChange = (nextName: string) => {
    const previousName = name;
    setName(nextName);
    if (editNode) return;
    // Auto-slug the d tag from the name until the user edits it directly.
    setDtag((previousDtag) =>
      previousDtag === "" || previousDtag === slugify(previousName)
        ? slugify(nextName)
        : previousDtag,
    );
  };

  const parentOptions = React.useMemo<OrgPickerOption[]>(() => {
    const depths = new Map<string, number>();
    const tree = buildOrgTree(nodes);
    for (const [, entry] of tree.byDtag)
      depths.set(entry.node.dtag, entry.depth);
    return nodes
      .filter((node) => node.dtag !== editNode?.dtag)
      .map((node) => ({
        id: node.dtag,
        label: "— ".repeat(depths.get(node.dtag) ?? 0) + node.name,
        kindBadge: node.kind,
      }));
  }, [nodes, editNode]);

  const canSubmit =
    name.trim().length > 0 &&
    dtag.trim().length > 0 &&
    !createMutation.isPending;

  const handleSubmit = React.useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmedName = name.trim();
      const trimmedDtag = dtag.trim();
      if (!trimmedName || !trimmedDtag) return;
      setErrorMessage(null);
      void (async () => {
        try {
          await createMutation.mutateAsync({
            dtag: trimmedDtag,
            name: trimmedName,
            kind,
            parent: parent ?? undefined,
          });
          onOpenChange(false);
        } catch (error) {
          setErrorMessage(
            error instanceof Error ? error.message : "Failed to create node.",
          );
        }
      })();
    },
    [name, dtag, kind, parent, createMutation, onOpenChange],
  );

  const kindOptions = [
    { value: "role", label: "Role" },
    { value: "team", label: "Team" },
    { value: "agent_seat", label: "Agent Seat" },
  ] as const;

  const moveKindSelection = (step: number) => {
    const index = kindOptions.findIndex((opt) => opt.value === kind);
    const next =
      kindOptions[(index + step + kindOptions.length) % kindOptions.length];
    setKind(next.value);
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
          <DialogTitle>
            {editNode ? "Edit Node" : "Create Org Node"}
          </DialogTitle>
          <DialogDescription>
            {editNode
              ? "Update this role, team, or agent seat."
              : "Add a role, team, or agent seat to your org hierarchy."}
          </DialogDescription>
        </DialogHeader>
        <form id="org-node-form" onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor="org-node-name"
            >
              Name
            </label>
            <Input
              disabled={createMutation.isPending}
              id="org-node-name"
              onChange={(event) => handleNameChange(event.target.value)}
              placeholder="e.g. Leadership"
              ref={nameRef}
              value={name}
            />
          </div>
          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor="org-node-dtag"
            >
              ID
            </label>
            <Input
              disabled={createMutation.isPending || !!editNode}
              id="org-node-dtag"
              onChange={(event) => setDtag(event.target.value)}
              placeholder="e.g. leadership"
              value={dtag}
            />
            <p className="text-xs text-muted-foreground">
              Unique identifier (cannot be changed later)
            </p>
          </div>
          <div className="space-y-1.5">
            <span
              className="text-sm font-medium text-foreground"
              id="org-node-kind-label"
            >
              Kind
            </span>
            <div
              aria-labelledby="org-node-kind-label"
              className="flex gap-2"
              onKeyDown={(event) => {
                if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                  event.preventDefault();
                  moveKindSelection(1);
                } else if (
                  event.key === "ArrowLeft" ||
                  event.key === "ArrowUp"
                ) {
                  event.preventDefault();
                  moveKindSelection(-1);
                }
              }}
              role="radiogroup"
            >
              {kindOptions.map((opt) => (
                <Button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={kind === opt.value}
                  tabIndex={kind === opt.value ? 0 : -1}
                  variant={kind === opt.value ? "default" : "outline"}
                  size="sm"
                  disabled={createMutation.isPending}
                  onClick={() => setKind(opt.value)}
                >
                  {opt.label}
                </Button>
              ))}
            </div>
          </div>
          <OrgEntityPicker
            disabled={createMutation.isPending}
            emptyMessage="No other nodes yet. Leave the parent empty for a root node."
            mode="single"
            onChange={setParent}
            options={parentOptions}
            searchPlaceholder="Search nodes..."
            selected={parent}
            triggerLabel="Parent"
          />
          {errorMessage ? (
            <p className="text-sm text-destructive">{errorMessage}</p>
          ) : null}
        </form>
        <DialogFooter>
          <Button disabled={!canSubmit} form="org-node-form" type="submit">
            {createMutation.isPending
              ? "Creating..."
              : editNode
                ? "Save Changes"
                : "Create Node"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A board's rules, shown above its posts so everyone reads the same ones the moderators go by. The board's owners and
 * admins (and the community's) can write or change them; the server keeps them and says who changed them in the board's
 * moderation log.
 */

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/shared/ui/button";

import { BOARD_RULES_MAX_CHARS } from "../lib/board-moderation";
import { BoardMarkdown } from "./BoardMarkdown";

export function BoardRules({
  rules,
  canEdit,
  onSave,
}: {
  rules: string;
  canEdit: boolean;
  onSave: (rules: string) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(rules);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (rules === "" && !canEdit) return null;

  const save = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await onSave(draft);
      setEditing(false);
      toast.success(draft.trim() === "" ? "Rules cleared." : "Rules saved.");
    } catch (error) {
      setProblem(
        error instanceof Error && error.message
          ? error.message
          : "Couldn't save the rules. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <form
        className="flex flex-col gap-2 rounded-xl border bg-card p-3"
        data-testid="board-rules-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="text-sm font-semibold" htmlFor="board-rules-box">
          Board rules
        </label>
        <p className="text-xs text-muted-foreground">
          What is welcome here and what is not. Moderators go by these, and
          everyone sees them above the posts.
        </p>
        <textarea
          className="min-h-28 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
          data-testid="board-rules-box"
          disabled={busy}
          id="board-rules-box"
          maxLength={BOARD_RULES_MAX_CHARS}
          onChange={(event) => setDraft(event.target.value)}
          value={draft}
        />
        {problem ? (
          <p className="text-xs text-destructive" role="alert">
            {problem}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button
            data-testid="board-rules-save"
            disabled={busy}
            size="sm"
            type="submit"
          >
            {busy ? "Saving…" : "Save rules"}
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              setDraft(rules);
              setEditing(false);
            }}
            size="sm"
            type="button"
            variant="ghost"
          >
            Cancel
          </Button>
        </div>
      </form>
    );
  }

  if (rules === "") {
    return (
      <div className="rounded-xl border border-dashed p-3 text-xs text-muted-foreground">
        This board has no rules yet.{" "}
        <button
          className="underline"
          data-testid="board-rules-write"
          onClick={() => {
            setDraft("");
            setEditing(true);
          }}
          type="button"
        >
          Write them
        </button>
      </div>
    );
  }

  return (
    <details
      className="rounded-xl border bg-card p-3 text-sm"
      data-testid="board-rules"
    >
      <summary className="cursor-pointer font-semibold">Board rules</summary>
      <div className="mt-2">
        <BoardMarkdown text={rules} />
      </div>
      {canEdit ? (
        <button
          className="mt-2 text-xs underline"
          data-testid="board-rules-edit"
          onClick={() => {
            setDraft(rules);
            setEditing(true);
          }}
          type="button"
        >
          Change the rules
        </button>
      ) : null}
    </details>
  );
}

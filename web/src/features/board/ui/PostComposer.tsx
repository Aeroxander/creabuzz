/**
 * The form for a new post: a title and, below it, whatever else there is to
 * say. Problems are said next to the form in plain words and never lose the
 * draft.
 */

import { useState } from "react";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

import { draftProblem, TITLE_MAX } from "../lib/post-text";

export function PostComposer({
  onSubmit,
  onCancel,
  initialTitle = "",
  initialBody = "",
  submitLabel = "Post",
  hint,
}: {
  onSubmit: (title: string, body: string) => Promise<void>;
  onCancel: () => void;
  initialTitle?: string;
  initialBody?: string;
  submitLabel?: string;
  /** A line under the form, for example who will see this. */
  hint?: string;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState(initialBody);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const found = draftProblem(title, body);
    if (found) {
      setProblem(found);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await onSubmit(title, body);
    } catch (error) {
      setProblem(
        error instanceof Error && error.message
          ? error.message
          : "Couldn't post that. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-2 rounded-xl border p-3"
      data-testid="board-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label className="sr-only" htmlFor="board-post-title">
        Title
      </label>
      <Input
        autoFocus
        id="board-post-title"
        maxLength={TITLE_MAX + 40}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Title"
        value={title}
      />
      <label className="sr-only" htmlFor="board-post-body">
        Details (optional)
      </label>
      <textarea
        className="min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
        id="board-post-body"
        onChange={(event) => setBody(event.target.value)}
        placeholder="Add details (optional). You can use Markdown."
        value={body}
      />
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {problem ? (
        <p
          className="text-xs text-destructive"
          data-testid="board-composer-problem"
          role="alert"
        >
          {problem}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          data-testid="board-composer-submit"
          disabled={busy}
          size="sm"
          type="submit"
        >
          {busy ? "Posting…" : submitLabel}
        </Button>
        <Button
          disabled={busy}
          onClick={onCancel}
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

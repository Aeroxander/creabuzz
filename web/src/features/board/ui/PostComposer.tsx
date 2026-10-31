/**
 * The form for a new post: a title and, below it, whatever else there is to
 * say. Problems are said next to the form in plain words and never lose the
 * draft.
 */

import { ImagePlus } from "lucide-react";
import { useRef, useState } from "react";

import { uploadFailureWords } from "@/shared/lib/media-refusal";
import type { FailureWords } from "@/shared/lib/readable-error";
import { uploadBlob } from "@/shared/lib/upload-blob";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { TechnicalDetails } from "@/shared/ui/technical-details";

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
  const [problem, setProblem] = useState<FailureWords | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  /** Upload a picture to the server and add it to the text, where the post's list card picks it up as its thumbnail. */
  const addPicture = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setProblem(null);
    try {
      const uploaded = await uploadBlob(file);
      setBody((text) => {
        const before = text.trimEnd();
        return `${before}${before ? "\n\n" : ""}![](${uploaded.url})\n`;
      });
    } catch (error) {
      setProblem(
        uploadFailureWords(
          error,
          "That picture didn't upload. Try again, or paste a link to a picture.",
        ),
      );
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const submit = async () => {
    const found = draftProblem(title, body);
    if (found) {
      setProblem({ text: found, detail: null });
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await onSubmit(title, body);
    } catch (error) {
      setProblem({
        text:
          error instanceof Error && error.message
            ? error.message
            : "Couldn't post that. Try again.",
        detail: null,
      });
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
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder="Add details (optional)"
        value={body}
      />
      <div>
        <input
          accept="image/png,image/jpeg,image/gif,image/webp"
          aria-label="Add a picture"
          className="sr-only"
          data-testid="board-composer-file"
          id="board-post-picture"
          onChange={(event) => void addPicture(event.target.files?.[0])}
          ref={fileInput}
          tabIndex={-1}
          type="file"
        />
        <Button
          data-testid="board-composer-picture"
          disabled={busy || uploading}
          onClick={() => fileInput.current?.click()}
          size="sm"
          type="button"
          variant="ghost"
        >
          <ImagePlus aria-hidden className="mr-1 h-4 w-4" />
          {uploading ? "Uploading…" : "Add a picture"}
        </Button>
        <span className="text-xs text-muted-foreground">
          {" "}
          Or paste a link to a picture in the text.
        </span>
      </div>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {problem ? (
        <>
          <p
            className="text-xs text-destructive"
            data-testid="board-composer-problem"
            role="alert"
          >
            {problem.text}
          </p>
          <TechnicalDetails
            detail={problem.detail}
            testId="board-composer-problem-details"
          />
        </>
      ) : null}
      <div className="flex gap-2">
        <Button
          data-testid="board-composer-submit"
          disabled={busy || uploading}
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

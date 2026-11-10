/**
 * Small pieces the task cards share: a failed send with "Try again", a person's name as a link, the work someone
 * handed in, and the one box every step is written in (a few words, and for some steps a date, links or files).
 *
 * A box keeps what was typed until its send goes through: a send that fails leaves the words where they are.
 */

import { Link } from "@tanstack/react-router";
import { type ReactNode, useId, useState } from "react";

import { uploadBlob } from "@/shared/lib/upload-blob";
import { Button } from "@/shared/ui/button";

import {
  readLinks,
  TASK_LIMITS,
  type TaskEvidence,
  type TaskFile,
  validDate,
} from "../lib/tasks";

export const FIELD_CLASS =
  "mt-1 w-full rounded-lg border border-black/15 bg-transparent px-2 py-1.5 text-sm text-black dark:border-white/15 dark:text-white";

export const day = (at: number) => new Date(at * 1000).toLocaleDateString();
/** A `YYYY-MM-DD` date as the reader's own calendar writes it. */
export const dateWords = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString();
export const todayDate = () => new Date().toISOString().slice(0, 10);

/** A send that did not go through: said where it happened, with a way to send it again. */
export function SendFailed({
  children,
  onRetry,
  testId,
}: {
  children: ReactNode;
  onRetry: () => void;
  testId: string;
}) {
  return (
    <p
      className="mt-2 flex flex-wrap items-center gap-2 text-sm text-red-700 dark:text-red-300"
      data-testid={testId}
      role="alert"
    >
      <span>{children}</span>
      <Button onClick={onRetry} size="sm" type="button" variant="outline">
        Try again
      </Button>
    </p>
  );
}

export function PersonLink({ pubkey, name }: { pubkey: string; name: string }) {
  return (
    <Link
      className="font-semibold text-foreground underline"
      params={{ pubkey }}
      to="/u/$pubkey"
    >
      {name}
    </Link>
  );
}

/** The links and files of one piece of handed-in work. A link is shown as written, so people see where it goes. */
export function EvidenceLinks({
  links,
  files,
}: {
  links: readonly string[];
  files: readonly TaskFile[];
}) {
  if (links.length + files.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-sm" data-testid="task-evidence-links">
      {links.map((link) => (
        <li className="break-all" key={link}>
          <a
            className="text-foreground underline"
            href={link}
            rel="noopener noreferrer nofollow"
            target="_blank"
          >
            {link}
          </a>
        </li>
      ))}
      {files.map((file) => (
        <li className="break-all" key={file.hash}>
          {file.url ? (
            <a
              className="text-foreground underline"
              href={file.url}
              rel="noopener noreferrer nofollow"
              target="_blank"
            >
              {file.name || "File"}
            </a>
          ) : (
            <span>{file.name || "File"}</span>
          )}{" "}
          <span className="text-xs text-muted-foreground">
            (fingerprint <code>{file.hash}</code>)
          </span>
        </li>
      ))}
    </ul>
  );
}

/** One piece of handed-in work: when, the words, the links and files, and what the team said about it. */
export function EvidencePiece({
  piece,
  names,
  heading,
}: {
  piece: TaskEvidence;
  names: (pubkey: string) => string;
  heading: string;
}) {
  return (
    <div
      className="rounded-lg border border-border bg-background/70 p-2"
      data-testid="task-evidence"
    >
      <p className="text-xs text-muted-foreground">
        {heading} · {day(piece.at)}
      </p>
      {piece.note ? (
        <p className="mt-1 whitespace-pre-wrap break-words text-sm">
          {piece.note}
        </p>
      ) : null}
      <EvidenceLinks files={piece.files} links={piece.links} />
      {piece.sentBack.map((back) => (
        <p
          className="mt-1 break-words text-sm"
          data-testid="task-sent-back-reason"
          key={back.id}
        >
          <span className="text-xs text-muted-foreground">
            Sent back by {names(back.by)} on {day(back.at)}:
          </span>{" "}
          {back.note}
        </p>
      ))}
      {piece.confirmed.length > 0 && piece.sentBack.length > 0 ? (
        <p className="mt-1 text-sm" data-testid="task-disagreement">
          {piece.confirmed.map((c) => names(c.by)).join(", ")} confirmed this
          and {piece.sentBack.map((s) => names(s.by)).join(", ")} sent it back.
          The answers disagree, so it is not counted as accepted.
        </p>
      ) : null}
    </div>
  );
}

export interface StepDraft {
  note: string;
  date: string;
  links: string[];
  files: TaskFile[];
}

/**
 * The box a step is written in. `note` is always there; a date, links and files are asked for when the step takes
 * them. Send is refused, with the reason beside the field, until what is required is filled in.
 */
export function StepBox({
  testId,
  title,
  hint,
  note,
  date,
  evidence = false,
  send,
  sending,
  busy,
  failed,
  onSend,
  onCancel,
  children,
}: {
  testId: string;
  /** What the box is for, as its group name. */
  title: string;
  hint?: string;
  note: { label: string; placeholder?: string; required?: string };
  /** A date field: its label, the earliest date, what to start with, and what to say when it is required and empty. */
  date?: { label: string; min: string; initial?: string; required?: string };
  /** Links and files can be handed in, and at least one of words, a link or a file is needed. */
  evidence?: boolean;
  send: string;
  sending: string;
  busy: boolean;
  /** What to say when the last send failed, or null. */
  failed: string | null;
  onSend: (draft: StepDraft) => void;
  onCancel: () => void;
  children?: ReactNode;
}) {
  const id = useId();
  const [words, setWords] = useState("");
  const [when, setWhen] = useState(date?.initial ?? "");
  const [linkText, setLinkText] = useState("");
  const [files, setFiles] = useState<TaskFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = () => {
    if (busy || uploading) return;
    const { links, bad } = readLinks(linkText);
    if (note.required && words.trim() === "") return setProblem(note.required);
    if (date) {
      if (when === "" && date.required) return setProblem(date.required);
      if (when !== "" && (!validDate(when) || when < date.min))
        return setProblem("Pick a date that has not passed.");
    }
    if (evidence) {
      if (bad.length > 0)
        return setProblem(
          `This is not a web link: ${bad[0]}. A link starts with https://`,
        );
      if (links.length > TASK_LIMITS.links)
        return setProblem(`Add at most ${TASK_LIMITS.links} links.`);
      if (words.trim() === "" && links.length === 0 && files.length === 0)
        return setProblem("Add what you did: a few words, a link, or a file.");
    }
    setProblem(null);
    onSend({ note: words, date: when, links, files });
  };

  const addFile = async (file: File) => {
    setUploadError(null);
    if (files.length >= TASK_LIMITS.files) {
      setUploadError(`Add at most ${TASK_LIMITS.files} files.`);
      return;
    }
    setUploading(true);
    try {
      const blob = await uploadBlob(file);
      setFiles((list) =>
        list.some((f) => f.hash === blob.sha256)
          ? list
          : [...list, { hash: blob.sha256, name: file.name, url: blob.url }],
      );
    } catch (error) {
      setUploadError(
        `The file was not added${error instanceof Error && error.message ? `: ${error.message}` : "."} Pick it again to retry.`,
      );
    } finally {
      setUploading(false);
    }
  };

  return (
    <form
      aria-label={title}
      className="mt-2 rounded-lg border border-border bg-background/70 p-2"
      data-testid={testId}
      onKeyDown={(e) => {
        // Escape puts the box away, as Cancel does. Not while a send is on its way: its result needs somewhere to land.
        if (e.key !== "Escape" || busy) return;
        e.stopPropagation();
        onCancel();
      }}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {hint ? (
        <p className="text-xs text-muted-foreground" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      {children}
      <label className="text-sm font-medium" htmlFor={`${id}-note`}>
        {note.label}
      </label>
      <textarea
        aria-describedby={hint ? `${id}-hint` : undefined}
        // biome-ignore lint/a11y/noAutofocus: the box opens because the person asked for it; typing starts in it
        autoFocus
        className={FIELD_CLASS}
        id={`${id}-note`}
        maxLength={TASK_LIMITS.note}
        onChange={(e) => setWords(e.target.value)}
        placeholder={note.placeholder}
        rows={2}
        value={words}
      />
      {evidence ? (
        <>
          <label
            className="mt-2 block text-sm font-medium"
            htmlFor={`${id}-links`}
          >
            Links (optional, one per line)
          </label>
          <textarea
            className={FIELD_CLASS}
            id={`${id}-links`}
            onChange={(e) => setLinkText(e.target.value)}
            placeholder="https://"
            rows={2}
            value={linkText}
          />
          <label
            className="mt-2 block text-sm font-medium"
            htmlFor={`${id}-file`}
          >
            Add a file (optional)
          </label>
          <input
            className="mt-1 block w-full text-sm"
            disabled={uploading || busy}
            id={`${id}-file`}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void addFile(file);
            }}
            type="file"
          />
          {uploading ? (
            <p className="mt-1 text-xs text-muted-foreground" role="status">
              Adding the file…
            </p>
          ) : null}
          {uploadError ? (
            <p
              className="mt-1 text-sm text-red-700 dark:text-red-300"
              role="alert"
            >
              {uploadError}
            </p>
          ) : null}
          {files.length > 0 ? (
            <ul className="mt-1 space-y-0.5 text-sm">
              {files.map((file) => (
                <li
                  className="flex flex-wrap items-center gap-2 break-all"
                  key={file.hash}
                >
                  <span>{file.name || "File"}</span>
                  <Button
                    aria-label={`Remove ${file.name || "file"}`}
                    onClick={() =>
                      setFiles((list) =>
                        list.filter((f) => f.hash !== file.hash),
                      )
                    }
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
      {date ? (
        <>
          <label
            className="mt-2 block text-sm font-medium"
            htmlFor={`${id}-date`}
          >
            {date.label}
          </label>
          <input
            className={FIELD_CLASS}
            id={`${id}-date`}
            min={date.min}
            onChange={(e) => setWhen(e.target.value)}
            type="date"
            value={when}
          />
        </>
      ) : null}
      {problem ? (
        <p
          className="mt-1 text-sm text-red-700 dark:text-red-300"
          data-testid={`${testId}-problem`}
          role="alert"
        >
          {problem}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button disabled={busy || uploading} size="sm" type="submit">
          {busy ? sending : send}
        </Button>
        <Button
          disabled={busy}
          onClick={onCancel}
          size="sm"
          type="button"
          variant="outline"
        >
          Cancel
        </Button>
      </div>
      {failed ? (
        <SendFailed onRetry={submit} testId={`${testId}-failed`}>
          {failed}
        </SendFailed>
      ) : null}
    </form>
  );
}

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
  checkFile,
  type FileCheck,
  fileCheckLine,
  linkHost,
} from "../lib/file-check";
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

/** One handed-in file: its name (the helper's word), where it is, its stated fingerprint, and a way to check it. */
function FileRow({ file }: { file: TaskFile }) {
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<FileCheck | null>(null);
  const host = file.url ? linkHost(file.url) : null;
  const run = async () => {
    setChecking(true);
    setCheck(null);
    const result = await checkFile(file.url, file.hash, {
      fetch: (url) =>
        fetch(url, { credentials: "omit", referrerPolicy: "no-referrer" }),
      digest: (bytes) =>
        crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
    });
    setCheck(result);
    setChecking(false);
  };
  return (
    <li className="break-all" data-testid="task-file">
      <span className="text-xs text-muted-foreground">
        File, named by the helper:
      </span>{" "}
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
      )}
      {host ? (
        <span className="text-xs text-muted-foreground"> (at {host})</span>
      ) : null}
      <span className="block text-xs text-muted-foreground">
        Fingerprint stated by the helper, not checked here:{" "}
        <code>{file.hash}</code>
      </span>
      {file.url ? (
        <Button
          aria-label={`Check this file: ${file.name || "file"}`}
          className="mt-1"
          disabled={checking}
          onClick={() => void run()}
          size="sm"
          type="button"
          variant="outline"
        >
          {checking ? "Checking…" : "Check this file"}
        </Button>
      ) : (
        <span className="block text-xs text-muted-foreground">
          No address was given, so it cannot be checked here.
        </span>
      )}
      {check ? (
        <span
          className="mt-1 block text-sm"
          data-result={check.result}
          data-testid="task-file-check"
          role="status"
        >
          {fileCheckLine(check)}
        </span>
      ) : null}
    </li>
  );
}

/**
 * The links and files of one piece of handed-in work. A link is shown as written with the site it goes to beside
 * it, so people see where it leads before they follow it.
 */
export function EvidenceLinks({
  links,
  files,
}: {
  links: readonly string[];
  files: readonly TaskFile[];
}) {
  if (links.length + files.length === 0) return null;
  return (
    <ul className="mt-1 space-y-1 text-sm" data-testid="task-evidence-links">
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
          <span
            className="text-xs text-muted-foreground"
            data-testid="task-link-host"
          >
            {" "}
            (goes to {linkHost(link) ?? "an address that could not be read"})
          </span>
        </li>
      ))}
      {files.map((file) => (
        <FileRow file={file} key={file.hash} />
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
      data-evidence={piece.id}
      data-testid="task-evidence"
    >
      <p className="text-xs text-muted-foreground">
        {heading} · dated {day(piece.at)} by the helper
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
            Sent back by {names(back.by)}:
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
      {piece.outside.map((other) => (
        <p
          className="mt-1 break-words text-xs text-muted-foreground"
          data-testid="task-outside-answer"
          key={other.id}
        >
          {other.part === "confirm" ? "Confirmed" : "Sent back"} by{" "}
          {names(other.by)}, who is not on this project's team now. It is not
          counted.{other.note ? ` They wrote: ${other.note}` : ""}
        </p>
      ))}
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
  const [problem, setProblemText] = useState<string | null>(null);
  /** Which field the problem is about, so it is marked and the reason is read with it. */
  const [badField, setBadField] = useState<"note" | "date" | "links" | null>(
    null,
  );
  const setProblem = (
    text: string | null,
    field: "note" | "date" | "links" | null = null,
  ) => {
    setProblemText(text);
    setBadField(field);
    // The keyboard goes to the field that needs fixing.
    if (field)
      document
        .getElementById(`${id}-${field}`)
        ?.focus({ preventScroll: false });
  };
  const errorId = `${id}-problem`;
  const describedBy = (field: "note" | "date" | "links", ...more: string[]) =>
    [...more, ...(badField === field ? [errorId] : [])].join(" ") || undefined;

  const submit = () => {
    if (busy || uploading) return;
    const { links, bad } = readLinks(linkText);
    if (note.required && words.trim() === "")
      return setProblem(note.required, "note");
    if (date) {
      if (when === "" && date.required)
        return setProblem(date.required, "date");
      if (when !== "" && (!validDate(when) || when < date.min))
        return setProblem("Pick a date that has not passed.", "date");
    }
    if (evidence) {
      if (bad.length > 0)
        return setProblem(
          `This is not a web link: ${bad[0]}. A link starts with https://`,
          "links",
        );
      if (links.length > TASK_LIMITS.links)
        return setProblem(`Add at most ${TASK_LIMITS.links} links.`, "links");
      if (words.trim() === "" && links.length === 0 && files.length === 0)
        return setProblem(
          "Add what you did: a few words, a link, or a file.",
          "note",
        );
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
      // The reasons are said here, beside the field they are about, not in the browser's own bubble.
      noValidate
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
        aria-describedby={describedBy("note", ...(hint ? [`${id}-hint`] : []))}
        aria-invalid={badField === "note" || undefined}
        aria-required={note.required ? "true" : undefined}
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
            aria-describedby={describedBy("links")}
            aria-invalid={badField === "links" || undefined}
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
            aria-describedby={describedBy("date")}
            aria-invalid={badField === "date" || undefined}
            className={FIELD_CLASS}
            id={`${id}-date`}
            min={date.min}
            onChange={(e) => setWhen(e.target.value)}
            required={Boolean(date.required)}
            type="date"
            value={when}
          />
        </>
      ) : null}
      {problem ? (
        <p
          className="mt-1 text-sm text-red-700 dark:text-red-300"
          data-testid={`${testId}-problem`}
          id={errorId}
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

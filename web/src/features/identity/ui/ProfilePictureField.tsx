/**
 * A profile picture: choose one from this device (it is uploaded to the community's server), or paste a link to one.
 * Used by both profile editors, the account menu's and the profile page's, so they offer the same thing.
 */

import { useEffect, useRef, useState } from "react";
import { ImagePlus, UserRound } from "lucide-react";

import { isSigningBlockedError } from "@/shared/lib/nostr-signer";
import { requestLimitText } from "@/shared/lib/refusal-text";
import { uploadBlob } from "@/shared/lib/upload-blob";
import { ServerImage } from "@/shared/ui/ServerImage";

import {
  PICTURE_TYPES,
  pictureFileProblem,
  pictureLinkProblem,
} from "../lib/picture-check";
import { SignRecovery } from "./SignRecovery";

type Problem =
  | { kind: "text"; text: string; detail: string | null }
  /** The upload could not be signed: the passkey is locked. Offered with its unlock, which retries this file. */
  | { kind: "locked"; text: string; file: File };

export function ProfilePictureField({
  value,
  saved,
  onChange,
  onUploadingChange,
  idPrefix,
}: {
  /** The picture's address, as it will be saved. Empty for none. */
  value: string;
  /** The address the profile has now, which is never refused as a link. */
  saved?: string | null;
  onChange: (url: string) => void;
  /** Told while an upload is under way, so the editor does not save half a change. */
  onUploadingChange?: (uploading: boolean) => void;
  idPrefix: string;
}) {
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  // Only the newest upload may set the picture: a later choice, a typed link or closing the editor supersedes it.
  const generation = useRef(0);
  const reportUploading = useRef(onUploadingChange);
  reportUploading.current = onUploadingChange;

  const setBusy = (busy: boolean) => {
    setUploading(busy);
    reportUploading.current?.(busy);
  };

  useEffect(
    () => () => {
      generation.current += 1;
      reportUploading.current?.(false);
    },
    [],
  );

  const upload = async (file: File) => {
    const mine = ++generation.current;
    setProblem(null);
    const refused = pictureFileProblem(file);
    if (refused) {
      setBusy(false);
      setProblem({ kind: "text", text: refused, detail: null });
      return;
    }
    setBusy(true);
    try {
      const uploaded = await uploadBlob(file);
      if (mine !== generation.current) return;
      onChange(uploaded.url);
    } catch (error) {
      if (mine !== generation.current) return;
      const message = error instanceof Error ? error.message : String(error);
      setProblem(
        isSigningBlockedError(error)
          ? { kind: "locked", text: message, file }
          : {
              kind: "text",
              text:
                requestLimitText(message) ??
                "Couldn't upload the picture. Try again, or paste a link to one instead.",
              detail: message,
            },
      );
    } finally {
      if (mine === generation.current) setBusy(false);
    }
  };

  const linkProblem = pictureLinkProblem(value, saved);
  const shown = value.trim() && !linkProblem ? value.trim() : null;
  const linkId = `${idPrefix}-link`;
  const statusId = `${idPrefix}-status`;

  return (
    <div className="space-y-2" data-testid={idPrefix}>
      <div className="flex items-center gap-3">
        <span className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-full bg-secondary">
          {shown ? (
            <ServerImage
              alt="Your picture"
              className="h-12 w-12 rounded-full object-cover"
              data-testid={`${idPrefix}-preview`}
              key={shown}
              src={shown}
              unavailable="icon"
            />
          ) : (
            <UserRound aria-hidden className="h-6 w-6 text-muted-foreground" />
          )}
        </span>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <button
            aria-describedby={uploading ? statusId : undefined}
            className="inline-flex items-center gap-1.5 rounded-full border border-input bg-background px-3 py-1 text-xs font-medium disabled:opacity-50"
            data-testid={`${idPrefix}-choose`}
            disabled={uploading}
            onClick={() => fileInput.current?.click()}
            type="button"
          >
            <ImagePlus aria-hidden className="h-3.5 w-3.5" />
            Choose a picture
          </button>
          {value.trim() ? (
            <button
              className="rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:text-foreground"
              data-testid={`${idPrefix}-remove`}
              onClick={() => {
                generation.current += 1;
                setBusy(false);
                setProblem(null);
                onChange("");
              }}
              type="button"
            >
              Remove
            </button>
          ) : null}
        </div>
        <input
          accept={PICTURE_TYPES.join(",")}
          aria-hidden
          className="hidden"
          data-testid={`${idPrefix}-file`}
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Cleared so choosing the same file again (after a failure) still fires.
            event.target.value = "";
            if (file) void upload(file);
          }}
          ref={fileInput}
          tabIndex={-1}
          type="file"
        />
      </div>
      {uploading ? (
        <p
          className="text-xs text-muted-foreground"
          id={statusId}
          role="status"
        >
          Uploading your picture…
        </p>
      ) : null}
      {problem?.kind === "locked" ? (
        <SignRecovery
          message={problem.text}
          onUnlocked={() => void upload(problem.file)}
          testId={`${idPrefix}-recovery`}
        />
      ) : problem ? (
        <div className="text-xs" data-testid={`${idPrefix}-problem`}>
          <p className="text-red-600 dark:text-red-400" role="alert">
            {problem.text}
          </p>
          {problem.detail ? (
            <details className="mt-1 text-muted-foreground">
              <summary className="cursor-pointer">Technical details</summary>
              <p className="mt-1 break-words font-mono">{problem.detail}</p>
            </details>
          ) : null}
        </div>
      ) : null}
      <label className="block text-xs text-muted-foreground" htmlFor={linkId}>
        Or paste a link to a picture
        <input
          aria-describedby={linkProblem ? `${linkId}-problem` : undefined}
          aria-invalid={linkProblem ? true : undefined}
          className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
          data-testid={linkId}
          id={linkId}
          inputMode="url"
          onChange={(event) => {
            generation.current += 1;
            setBusy(false);
            setProblem(null);
            onChange(event.target.value);
          }}
          placeholder="https://"
          value={value}
        />
      </label>
      {linkProblem ? (
        <p
          className="text-xs text-red-600 dark:text-red-400"
          id={`${linkId}-problem`}
          role="alert"
        >
          {linkProblem}
        </p>
      ) : null}
    </div>
  );
}

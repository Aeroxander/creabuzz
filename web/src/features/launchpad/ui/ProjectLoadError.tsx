/**
 * What a project page shows when its read failed. An invite-only server turning the reader away says so in plain words,
 * who to ask for an invite, and offers Sign in first; any other failure keeps "Try again". The words come from
 * `lib/refusal-copy.ts`; the server decides who may read.
 *
 * Some invite-only servers let anyone read a project's public record. So when the reader was turned away and the
 * address names a project (its scorecard or its page), the server is asked once for that record: when it answers,
 * the record is shown read only with one line about invites (`PublicRecord`); when it does not, the reader sees the
 * invite sentence exactly as before.
 */

import { useMemo } from "react";

import { SIGN_IN_EVENT } from "@/features/identity/lib/account-copy";
import { existingUserPubkey } from "@/shared/lib/identity";
import { Button } from "@/shared/ui/button";
import { projectAtAddress } from "../lib/public-record";
import { projectLoadFailure } from "../lib/refusal-copy";
import { usePublicRecord } from "../use-public-record";
import { PublicRecord } from "./PublicRecord";

export function ProjectLoadError({
  error,
  onRetry,
  testId = "project-load-error",
}: {
  error: unknown;
  onRetry: () => void;
  testId?: string;
}) {
  const signedIn = existingUserPubkey() !== null;
  const failure = projectLoadFailure(error, signedIn);
  const turnedAway = failure.kind === "invite-only";
  const address = useMemo(
    () =>
      turnedAway
        ? projectAtAddress(window.location.pathname, window.location.search)
        : null,
    [turnedAway],
  );
  const open = usePublicRecord(address);
  if (address && open.isLoading)
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Opening the project…
      </p>
    );
  if (open.data) return <PublicRecord signedIn={signedIn} view={open.data} />;
  return (
    <div
      className="flex flex-col items-start gap-2 text-sm"
      data-outcome={failure.kind}
      data-testid={testId}
      role="alert"
    >
      <p className="font-medium">{failure.title}</p>
      {failure.lines.map((line) => (
        <p className="text-muted-foreground" key={line}>
          {line}
        </p>
      ))}
      {failure.signIn ? (
        <Button
          onClick={() => window.dispatchEvent(new Event(SIGN_IN_EVENT))}
          size="sm"
          type="button"
        >
          Sign in
        </Button>
      ) : null}
      {failure.retry ? (
        <Button onClick={onRetry} size="sm" type="button" variant="outline">
          Try again
        </Button>
      ) : null}
    </div>
  );
}

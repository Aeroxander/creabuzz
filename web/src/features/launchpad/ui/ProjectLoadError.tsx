/**
 * What a project page shows when its read failed. An invite-only server turning the reader away says so in plain words,
 * who to ask for an invite, and offers Sign in first; any other failure keeps "Try again". The words come from
 * `lib/refusal-copy.ts`; the server decides who may read.
 */

import { SIGN_IN_EVENT } from "@/features/identity/lib/account-copy";
import { existingUserPubkey } from "@/shared/lib/identity";
import { Button } from "@/shared/ui/button";
import { projectLoadFailure } from "../lib/refusal-copy";

export function ProjectLoadError({
  error,
  onRetry,
  testId = "project-load-error",
}: {
  error: unknown;
  onRetry: () => void;
  testId?: string;
}) {
  const failure = projectLoadFailure(error, existingUserPubkey() !== null);
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

/**
 * "Ask to join": the one green button a signed-in person who is not on a project's team sees on its public link. One
 * press, no field: it sends one signed record (`lib/join.ts`) and the founder is told. After it, the button gives way to
 * "Asked to join. The founder has been told.", also after a reload (the person's own ask is read back).
 *
 * Signed out, the press opens the sign-up dialog (`SIGN_UP_EVENT`), and the person lands back on this page to press it
 * again. Nothing is sent before they are signed in.
 */

import { useState } from "react";

import { SIGN_UP_EVENT } from "@/features/identity/lib/account-copy";
import { existingUserPubkey } from "@/shared/lib/identity";
import { type FailureWords, failureWords } from "@/shared/lib/readable-error";
import { Button } from "@/shared/ui/button";
import { FailureNote } from "@/shared/ui/failure-note";

import { ASKED_WORDS } from "../lib/join";
import type { LaunchRecord } from "../models";
import { useAskToJoin, useMyAsk } from "../use-join";

export function JoinAskButton({
  project,
  quiet = false,
}: {
  project: LaunchRecord;
  /** Another green button is on the page already (Follow on an idea, a sale's button): this one is an outline. */
  quiet?: boolean;
}) {
  const me = existingUserPubkey();
  const mine = useMyAsk(project);
  const ask = useAskToJoin(project);
  const [sent, setSent] = useState(false);
  const [failure, setFailure] = useState<FailureWords | null>(null);

  // The founder and the team have nothing to ask for.
  if (
    me !== null &&
    (me === project.author || project.team.some((m) => m.pubkey === me))
  )
    return null;
  if (sent || mine.waiting)
    return (
      <p className="text-sm" data-testid="join-asked" role="status">
        {ASKED_WORDS}
      </p>
    );

  const press = async () => {
    if (existingUserPubkey() === null) {
      window.dispatchEvent(new Event(SIGN_UP_EVENT));
      return;
    }
    setFailure(null);
    try {
      await ask.mutateAsync();
      setSent(true);
    } catch (cause) {
      setFailure(
        failureWords(
          cause,
          "Your ask was not sent. Press Ask to join to try again.",
        ),
      );
    }
  };

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        className="max-sm:h-11"
        data-testid="join-ask"
        disabled={!mine.ready || ask.isPending}
        onClick={() => void press()}
        type="button"
        variant={quiet ? "outline" : "default"}
      >
        Ask to join
      </Button>
      {failure ? (
        <FailureNote failure={failure} testId="join-ask-failed" />
      ) : null}
    </div>
  );
}

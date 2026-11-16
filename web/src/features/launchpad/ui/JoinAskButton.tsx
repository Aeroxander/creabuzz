/**
 * "Ask to join": the one green button a signed-in person who is not on a project's team sees on its public link. One
 * press, no field: it sends one signed record (`lib/join.ts`). Nobody is sent a message: the ask waits on the founder's
 * Team card and in their Notifications. After it, the button gives way to `ASKED_WORDS`, which says only that, also
 * after a reload (the person's own ask is read back).
 *
 * Signed out, the press opens the sign-up dialog (`SIGN_UP_EVENT`) and remembers the press (`markAskAfterSignUp`): once
 * the account exists and the person is back on this page, the ask is sent with no second press. Nothing is sent before
 * they are signed in, and a remembered press for another project, or one older than ten minutes, sends nothing.
 */

import { useEffect, useRef, useState } from "react";

import { SIGN_UP_EVENT } from "@/features/identity/lib/account-copy";
import { existingUserPubkey } from "@/shared/lib/identity";
import { type FailureWords, failureWords } from "@/shared/lib/readable-error";
import { Button } from "@/shared/ui/button";
import { FailureNote } from "@/shared/ui/failure-note";

import {
  ASKED_WORDS,
  askAfterSignUpWaiting,
  clearAskAfterSignUp,
  markAskAfterSignUp,
  takeAskAfterSignUp,
} from "../lib/join";
import { launchCoordinate, type LaunchRecord } from "../models";
import { useAskToJoin, useMyAsk } from "../use-join";

const sessionStore = () => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

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
  const coordinate = launchCoordinate(project.author, project.id);
  const onTeam =
    me !== null &&
    (me === project.author || project.team.some((m) => m.pubkey === me));

  const send = async () => {
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

  // The account now exists and Ask to join was waiting for it: send it, once. The press is used up before sending, so a
  // reload or a second announcement of the same account finds nothing waiting. It waits for the read of the person's
  // own asks, as a press would, so a person who asked already is not asked for twice.
  const sendNow = useRef(send);
  sendNow.current = send;
  const alreadyAsked = mine.waiting;
  useEffect(() => {
    if (me === null || !mine.ready || onTeam) return;
    if (!askAfterSignUpWaiting(sessionStore(), coordinate)) return;
    if (!takeAskAfterSignUp(sessionStore(), coordinate)) return;
    if (!alreadyAsked) void sendNow.current();
  }, [me, mine.ready, onTeam, alreadyAsked, coordinate]);

  // The founder and the team have nothing to ask for.
  if (onTeam) return null;
  if (sent || mine.waiting)
    return (
      <p className="text-sm" data-testid="join-asked" role="status">
        {ASKED_WORDS}
      </p>
    );

  const press = async () => {
    if (existingUserPubkey() === null) {
      markAskAfterSignUp(sessionStore(), coordinate);
      window.dispatchEvent(new Event(SIGN_UP_EVENT));
      return;
    }
    // Pressing the button is the press: one waiting for an account is no longer needed.
    clearAskAfterSignUp(sessionStore());
    await send();
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

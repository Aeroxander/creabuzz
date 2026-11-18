/**
 * What a project page shows when it has no project to show: still reading, a read that failed, or a read that worked
 * and found nothing. Only the last says "not found". A failed read (signed out on an invite-only server, a passkey not
 * unlocked this session, the server refusing or not answering) says what happened, offers the sign-in or unlock beside
 * it and a Try again, and reloads itself after an unlock; someone sent a link to a project they were invited to must
 * never be told it is gone because this browser could not read it.
 */

import { SignRecovery } from "@/features/identity/ui/SignRecovery";
import { LAUNCHPAD_EVENT_KINDS } from "@/shared/constants/kinds";
import { existingUserPubkey } from "@/shared/lib/identity";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { QueryError, errorMessage } from "@/shared/ui/query-error";

const QUIET = "text-sm text-black/60 dark:text-white/60";

export function LaunchMissing({
  loading,
  error,
  onRetry,
}: {
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  if (loading)
    return (
      <p
        className={`mx-auto w-full max-w-5xl px-4 py-16 text-center ${QUIET}`}
        data-testid="launch-loading"
      >
        Loading the project…
      </p>
    );
  if (error)
    return (
      <div className="mx-auto w-full max-w-5xl px-4 py-8">
        <QueryError
          description="The server didn't respond, so this project can't be shown."
          error={error}
          kinds={LAUNCHPAD_EVENT_KINDS}
          message={errorMessage(error)}
          onRetry={onRetry}
          recovery={(onUnlocked) => (
            <SignRecovery
              autoResume
              onUnlocked={onUnlocked}
              showHeadline={false}
            />
          )}
          relayUrl={relayWsUrl()}
          testId="launch-load-error"
          title="Couldn't load this project"
        />
        {existingUserPubkey() === null ? (
          <p
            className={`mx-auto max-w-md text-center ${QUIET}`}
            data-testid="launch-load-signed-out"
          >
            This browser isn&apos;t signed in. If you have an account, sign in
            from your account menu, then press Try again.
          </p>
        ) : null}
      </div>
    );
  return (
    <div
      className={`mx-auto flex w-full max-w-5xl flex-col items-center gap-1 px-4 py-16 text-center ${QUIET}`}
      data-testid="launch-not-found"
    >
      <p className="font-medium text-black dark:text-white">
        This project wasn&apos;t found.
      </p>
      <p>
        Its founder may have taken it off the list, or the link may be
        incomplete. Ask whoever sent it.
      </p>
    </div>
  );
}

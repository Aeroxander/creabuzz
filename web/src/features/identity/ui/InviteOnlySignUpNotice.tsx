import { Lock } from "lucide-react";

import { useCommunityAccess } from "@/features/communities/use-access";

/**
 * Said before someone makes an account on an invite-only server without an invite link: the account would be made, and
 * then every page would refuse it. The invite page makes its own account, so this is never shown there. A server that
 * does not say who may join shows nothing; sign-up is not blocked either way.
 *
 * On the Start page (`where="start"`) it sits at the top of the form for someone with no account, and says what that
 * means for starting a project, so the requirement is read before anything is typed.
 */
export function InviteOnlySignUpNotice({
  where = "dialog",
}: {
  where?: "dialog" | "start";
} = {}) {
  const access = useCommunityAccess();
  if (access.data !== "invite_only") return null;
  const onStart = where === "start";
  return (
    <div
      className={`${onStart ? "" : "mt-3 "}flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-100`}
      data-testid={onStart ? "start-invite-only" : "onboarding-invite-only"}
      role="note"
    >
      <Lock aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      {onStart ? (
        <p>
          This server is invite-only. To start a project here, open the invite
          link you were sent first: it makes your account and lets you in. An
          account made without one can't read or post.
        </p>
      ) : (
        <p>
          This server is invite-only. Open the invite link you were sent: it
          makes your account and lets you in. An account made here without one
          can't read or post.
        </p>
      )}
    </div>
  );
}

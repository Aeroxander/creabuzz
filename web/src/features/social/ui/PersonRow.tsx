import { Link } from "@tanstack/react-router";

import type { ProfileMetadata } from "@/features/profiles/lib/index-profiles";
import {
  resolveUserName,
  resolveUserSecondaryName,
} from "@/features/profiles/use-profiles";
import { UserAvatar } from "@/shared/ui/UserAvatar";

import { FollowButton } from "../../feed/ui/FollowButton";

/** A person: avatar, name, handle, optional bio and a follow button. */
export function PersonRow({
  pubkey,
  profile,
  detail,
  showBio = false,
}: {
  pubkey: string;
  profile?: ProfileMetadata;
  detail?: string;
  showBio?: boolean;
}) {
  const name = resolveUserName(profile, pubkey);
  return (
    <div
      className="relative flex items-start gap-3 px-4 py-3 transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
      data-testid="social-person"
    >
      <UserAvatar
        avatarUrl={profile?.picture ?? null}
        className="h-10 w-10"
        displayName={name}
      />
      <div className="min-w-0 flex-1">
        <Link
          className="block truncate text-sm font-bold text-black after:absolute after:inset-0 hover:underline dark:text-white"
          params={{ pubkey }}
          to="/u/$pubkey"
        >
          {name}
        </Link>
        <p className="truncate text-sm text-black/60 dark:text-white/60">
          {resolveUserSecondaryName(profile, pubkey)}
          {detail ? ` · ${detail}` : ""}
        </p>
        {showBio && profile?.about ? (
          <p className="mt-1 line-clamp-2 text-sm text-black/80 dark:text-white/80">
            {profile.about}
          </p>
        ) : null}
      </div>
      <div className="relative z-10">
        <FollowButton label={name} person={pubkey} testId="social-follow" />
      </div>
    </div>
  );
}

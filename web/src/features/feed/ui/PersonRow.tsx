import { Link } from "@tanstack/react-router";

import { truncatePubkey } from "@/shared/lib/pubkey";
import type { Profile } from "../feed-model";
import { Avatar, displayNameOf } from "./Avatar";
import { FollowButton } from "./FollowButton";

/** Avatar, name, handle and an optional follow button — used in suggestions and search. */
export function PersonRow({
  pubkey,
  profile,
  viewer,
  detail,
  showBio = false,
}: {
  pubkey: string;
  profile?: Profile;
  viewer: string | null;
  detail?: string;
  showBio?: boolean;
}) {
  return (
    <div className="relative flex items-start gap-3 px-4 py-3 transition-colors hover:bg-foreground/[0.04]">
      <Avatar pubkey={pubkey} profile={profile} />
      <div className="min-w-0 flex-1 leading-5">
        <Link
          to="/p/$id"
          params={{ id: pubkey }}
          className="block truncate font-bold after:absolute after:inset-0 hover:underline"
        >
          {displayNameOf(pubkey, profile)}
        </Link>
        <div className="truncate text-[15px] text-muted-foreground">
          {profile?.name ? `@${profile.name}` : truncatePubkey(pubkey)}
          {detail && <span> · {detail}</span>}
        </div>
        {showBio && profile?.about && (
          <p className="mt-1 line-clamp-2 text-[15px]">{profile.about}</p>
        )}
      </div>
      {viewer && viewer !== pubkey && (
        <div className="relative z-10">
          <FollowButton viewer={viewer} target={pubkey} size="sm" />
        </div>
      )}
    </div>
  );
}

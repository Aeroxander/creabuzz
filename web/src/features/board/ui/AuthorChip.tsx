import { UserAvatar } from "@/shared/ui/UserAvatar";
import {
  type Profile,
  resolveUserName,
} from "@/features/profiles/use-profiles";

/** A person's picture and name, as the rest of the app shows them. */
export function AuthorChip({
  pubkey,
  profile,
}: {
  pubkey: string;
  profile: Profile | undefined;
}) {
  const name = resolveUserName(profile, pubkey);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <UserAvatar
        avatarUrl={profile?.picture ?? null}
        displayName={name}
        size="xs"
      />
      <span className="truncate font-medium text-foreground">{name}</span>
    </span>
  );
}

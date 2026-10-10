import { UserAvatar } from "@/shared/ui/UserAvatar";
import {
  type Profile,
  resolveUserName,
} from "@/features/profiles/use-profiles";

/** A person's picture and name, as the rest of the app shows them. */
export function AuthorChip({
  pubkey,
  profile,
  badge,
}: {
  pubkey: string;
  profile: Profile | undefined;
  /** A short fact about the person to show beside their name, such as how much of a DAO they hold. */
  badge?: string;
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
      {badge ? (
        <span
          className="shrink-0 rounded-full bg-secondary px-1.5 py-0.5 text-2xs font-medium text-muted-foreground"
          data-testid="author-badge"
        >
          {badge}
        </span>
      ) : null}
    </span>
  );
}

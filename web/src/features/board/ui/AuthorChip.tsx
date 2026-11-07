import { UserAvatar } from "@/shared/ui/UserAvatar";
import type { Profile } from "@/features/profiles/use-profiles";
import { avatarName, bylineName } from "@/features/social/lib/person-name";

/**
 * A person's picture and name, as the rest of the app shows them. Boards show the picture large, the way a forum
 * does, so the people in a discussion are easy to tell apart at a glance. Until their profile is read (or when they
 * never chose a name) they are "Someone", never a short key.
 */
export function AuthorChip({
  profile,
  badge,
  size = "xs",
}: {
  /** Whose chip it is. The label comes from their profile alone, so a key is never shown in its place. */
  pubkey: string;
  profile: Profile | undefined;
  /** A short fact about the person to show beside their name, such as how much of a DAO they hold. */
  badge?: string;
  size?: "xs" | "md" | "xl";
}) {
  const name = bylineName(profile);
  return (
    <span
      className={`inline-flex min-w-0 items-center ${size === "xs" ? "gap-1.5" : "gap-2.5"}`}
    >
      <UserAvatar
        avatarUrl={profile?.picture ?? null}
        displayName={avatarName(profile)}
        size={size}
      />
      <span
        className={`truncate font-medium text-foreground ${size === "xs" ? "" : "text-sm font-semibold"}`}
      >
        {name}
      </span>
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

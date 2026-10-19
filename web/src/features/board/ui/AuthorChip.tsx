import { UserAvatar } from "@/shared/ui/UserAvatar";
import {
  type Profile,
  resolveUserName,
} from "@/features/profiles/use-profiles";

/**
 * A person's picture and name, as the rest of the app shows them. Boards show the picture large, the way a forum
 * does, so the people in a discussion are easy to tell apart at a glance.
 */
export function AuthorChip({
  pubkey,
  profile,
  badge,
  size = "xs",
}: {
  pubkey: string;
  profile: Profile | undefined;
  /** A short fact about the person to show beside their name, such as how much of a DAO they hold. */
  badge?: string;
  size?: "xs" | "md" | "xl";
}) {
  const name = resolveUserName(profile, pubkey);
  return (
    <span
      className={`inline-flex min-w-0 items-center ${size === "xs" ? "gap-1.5" : "gap-2.5"}`}
    >
      <UserAvatar
        avatarUrl={profile?.picture ?? null}
        displayName={name}
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

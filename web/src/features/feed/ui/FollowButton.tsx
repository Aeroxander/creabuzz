import { toast } from "sonner";

import { existingUserPubkey } from "@/shared/lib/identity";
import { Button } from "@/shared/ui/button";

import { followedLaunches, followedPeople } from "../lib/lists";
import { type FollowTarget, useFollowChanges, useMyLists } from "../use-feed";

/**
 * Follow a person (NIP-02 contact list) or a launch (NIP-51 bookmarks). The
 * button waits for the current list before it can be used, and every change
 * goes through one shared queue that re-reads the newest list first
 * (`useFollowChanges`), so following two people quickly keeps both. While a
 * change waits the button shows where it is going; a refused change says so
 * and the button goes back to what is stored.
 */
export function FollowButton({
  person,
  launchCoord,
  label,
  testId = "follow",
}: {
  person?: string;
  launchCoord?: string;
  /** Who or what is followed, for the accessible name. */
  label: string;
  testId?: string;
}) {
  const me = existingUserPubkey();
  const lists = useMyLists();
  const { pendingFor, change } = useFollowChanges();

  if (!me || (person && person === me)) return null;
  const what: FollowTarget | null = person
    ? { person }
    : launchCoord
      ? { launchCoord }
      : null;
  if (!what) return null;

  const stored =
    "person" in what
      ? followedPeople(lists.data?.contacts ?? null).has(
          what.person.toLowerCase(),
        )
      : followedLaunches(lists.data?.bookmarks ?? null).has(what.launchCoord);
  const pending = pendingFor(what);
  const following = pending ?? stored;

  const toggle = () => {
    if (!lists.isSuccess || pending !== undefined) return;
    const follow = !stored;
    change({ ...what, follow }).catch((error: unknown) =>
      toast.error(
        `Couldn't ${follow ? "follow" : "unfollow"} ${label}. ${
          error instanceof Error
            ? error.message
            : "Check your connection and try again."
        }`,
      ),
    );
  };

  return (
    <Button
      aria-busy={pending !== undefined}
      aria-label={`${following ? "Unfollow" : "Follow"} ${label}`}
      aria-pressed={following}
      data-pending={pending !== undefined ? "true" : undefined}
      data-testid={testId}
      disabled={!lists.isSuccess || pending !== undefined}
      onClick={toggle}
      size="sm"
      type="button"
      variant={following ? "outline" : "default"}
    >
      {following ? "Following" : "Follow"}
    </Button>
  );
}

import { toast } from "sonner";

import { existingUserPubkey } from "@/shared/lib/identity";
import { Button } from "@/shared/ui/button";

import {
  followedLaunches,
  followedPeople,
  withLaunch,
  withPerson,
} from "../lib/lists";
import { useMyLists, usePublishFeedEvent } from "../use-feed";

/**
 * Follow a person (NIP-02 contact list) or a launch (NIP-51 bookmarks). The
 * button waits for the current list before it can be used, so a follow never
 * republishes an empty list over one it has not read yet.
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
  const publish = usePublishFeedEvent();

  if (!me || (person && person === me)) return null;

  const following = person
    ? followedPeople(lists.data?.contacts ?? null).has(person.toLowerCase())
    : launchCoord
      ? followedLaunches(lists.data?.bookmarks ?? null).has(launchCoord)
      : false;

  const toggle = () => {
    if (!lists.isSuccess) return;
    const template = person
      ? withPerson(lists.data.contacts, person, !following)
      : withLaunch(lists.data.bookmarks, launchCoord as string, !following);
    publish.mutate(template, {
      onError: (error) =>
        toast.error(
          error instanceof Error ? error.message : "Could not update follows.",
        ),
    });
  };

  return (
    <Button
      aria-label={`${following ? "Unfollow" : "Follow"} ${label}`}
      aria-pressed={following}
      data-testid={testId}
      disabled={!lists.isSuccess || publish.isPending}
      onClick={toggle}
      size="sm"
      type="button"
      variant={following ? "outline" : "default"}
    >
      {following ? "Following" : "Follow"}
    </Button>
  );
}

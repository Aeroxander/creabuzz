import { useProfiles } from "../../lib/profiles";
import { PostCard } from "./PostCard";
import { engagementOf, type SignedEvent, useEngagement } from "./use-posts";

/** Posts one under another, each with the author's name and its counts (one read of each for the whole list). */
export function PostList({
  events,
  testId,
}: {
  events: readonly SignedEvent[];
  testId?: string;
}) {
  const profiles = useProfiles(events.map((event) => event.pubkey)).data;
  const engagement = useEngagement(events.map((event) => event.id)).data;
  return (
    <div className="flex flex-col gap-3" data-testid={testId}>
      {events.map((event) => (
        <PostCard
          engagement={engagementOf(engagement, event.id)}
          event={event}
          key={event.id}
          profiles={profiles}
        />
      ))}
    </div>
  );
}

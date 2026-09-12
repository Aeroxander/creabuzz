import { SearchX } from "lucide-react";

import type { Channel } from "@/features/channels/use-channels";
import { eventChannelId, eventText, useSearch } from "../use-search";
import {
  profileDisplayName,
  useProfiles,
} from "@/features/profiles/use-profiles";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { relativeTime } from "@/shared/lib/relative-time";
import { QueryError } from "@/shared/ui/query-error";

export function SearchResults({
  term,
  channels,
  onOpenChannel,
}: {
  term: string;
  channels: Channel[];
  onOpenChannel: (channelId: string) => void;
}) {
  const channelIds = channels.map((c) => c.id);
  const { data, isLoading, error, refetch } = useSearch(term, channelIds);
  const authors = [...new Set((data ?? []).map((e) => e.pubkey))];
  const { data: profiles } = useProfiles(authors);
  const profileByPubkey = new Map(Object.entries(profiles ?? {}));
  const channelById = new Map(channels.map((c) => [c.id, c]));

  if (isLoading) {
    return (
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {["a", "b", "c"].map((k) => (
          <div
            key={k}
            className="h-14 animate-pulse rounded-md bg-black/5 dark:bg-white/10"
          />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        <QueryError
          description="The relay did not answer the search query."
          message={error.message}
          onRetry={() => void refetch()}
          testId="search-error"
          title="Search failed"
        />
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center p-8 text-center">
        <SearchX className="h-7 w-7 text-black/60 dark:text-white/60" />
        <p className="mt-2 text-sm text-black/60 dark:text-white/60">
          No results for “{term}”.
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <p className="mb-2 text-xs text-black/60 dark:text-white/60">
        {data.length} result{data.length === 1 ? "" : "s"} for “{term}”
      </p>
      <div className="divide-y divide-black/5 dark:divide-white/5">
        {data.map((event) => {
          const channelId = eventChannelId(event);
          const channel = channelId ? channelById.get(channelId) : undefined;
          return (
            <button
              key={event.id}
              type="button"
              onClick={() => channelId && onOpenChannel(channelId)}
              className="block w-full py-2 text-left hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
              data-testid="search-result"
            >
              <div className="flex items-baseline gap-2 text-xs text-black/60 dark:text-white/60">
                <span className="font-medium text-black/70 dark:text-white/70">
                  {channel ? `#${channel.name}` : "message"}
                </span>
                <span>
                  {profileDisplayName(
                    profileByPubkey.get(event.pubkey),
                    event.pubkey,
                  )}
                </span>
                <span>{truncatePubkey(event.pubkey)}</span>
                <span className="ml-auto">
                  {/* `relativeTime` takes seconds, like every other call site:
                      a millisecond value reads as a timestamp far in the future
                      and renders as "just now" for every result. */}
                  {relativeTime(event.created_at)}
                </span>
              </div>
              <p className="mt-0.5 line-clamp-2 text-sm text-black/80 dark:text-white/80">
                {eventText(event).slice(0, 300)}
              </p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

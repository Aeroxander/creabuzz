import { ArrowLeft, SearchX, X } from "lucide-react";
import type { ReactNode } from "react";

import type { Channel } from "@/features/channels/use-channels";
import { hitParts, hitTarget } from "../lib/search-hits";
import { eventChannelId, useSearch } from "../use-search";
import { resolveUserName, useProfiles } from "@/features/profiles/use-profiles";
import { relativeTime } from "@/shared/lib/relative-time";
import { QueryError } from "@/shared/ui/query-error";
import { SignRecovery } from "@/features/identity/ui/SignRecovery";
import { relayWsUrl } from "@/shared/lib/relay-url";

/**
 * The search box over the results, on narrow screens only: there the sidebar's box is in the closed slide-over, so
 * without this the results had no query to change and no way back.
 */
function PhoneSearchBar({
  typed,
  onTermChange,
  onClear,
}: {
  typed: string;
  onTermChange?: (term: string) => void;
  onClear?: () => void;
}) {
  if (!onTermChange || !onClear) return null;
  return (
    <div
      className="flex items-center gap-1 border-b border-black/10 px-2 py-2 lg:hidden dark:border-white/10"
      data-testid="search-phone-bar"
    >
      <button
        aria-label="Back"
        className="rounded-md p-1.5 text-black/60 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10"
        data-testid="search-back"
        onClick={onClear}
        type="button"
      >
        <ArrowLeft aria-hidden className="h-4 w-4" />
      </button>
      <input
        aria-label="Search this community"
        className="min-w-0 flex-1 rounded-md border border-black/10 bg-white px-2 py-1.5 text-sm text-black outline-none dark:border-white/10 dark:bg-white/5 dark:text-white"
        data-testid="search-phone-input"
        onChange={(event) => onTermChange(event.target.value)}
        type="search"
        value={typed}
      />
      <button
        aria-label="Clear search"
        className="rounded-md p-1.5 text-black/60 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10"
        data-testid="search-clear"
        onClick={onClear}
        type="button"
      >
        <X aria-hidden className="h-4 w-4" />
      </button>
    </div>
  );
}

export function SearchResults({
  term,
  typed = term,
  channels,
  onOpenChannel,
  onOpenKnowledge,
  onOpenPost,
  onTermChange,
  onClear,
}: {
  term: string;
  /** What is in the box as typed (the search runs on `term`, trimmed). */
  typed?: string;
  channels: Channel[];
  onOpenChannel: (channelId: string) => void;
  /** Open a wiki page or the work board from a hit. */
  onOpenKnowledge?: (target: { view: "wiki" | "work"; id?: string }) => void;
  /** Open a board post (from a hit on it or on one of its replies). */
  onOpenPost?: (boardId: string, postId: string) => void;
  /** Change the search from the results (narrow screens). */
  onTermChange?: (term: string) => void;
  /** Leave the results. */
  onClear?: () => void;
}) {
  const bar = (
    <PhoneSearchBar
      onClear={onClear}
      onTermChange={onTermChange}
      typed={typed}
    />
  );
  const withBar = (body: ReactNode) => (
    <div className="flex min-h-0 flex-1 flex-col">
      {bar}
      {body}
    </div>
  );
  const channelIds = channels.map((c) => c.id);
  const { data, isLoading, error, refetch } = useSearch(term, channelIds);
  const authors = [...new Set((data ?? []).map((e) => e.pubkey))];
  const { data: profiles } = useProfiles(authors);
  const profileByPubkey = new Map(Object.entries(profiles ?? {}));
  const channelById = new Map(channels.map((c) => [c.id, c]));

  if (isLoading) {
    return withBar(
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {["a", "b", "c"].map((k) => (
          <div
            key={k}
            className="h-14 animate-pulse rounded-md bg-black/5 dark:bg-white/10"
          />
        ))}
      </div>,
    );
  }

  if (error) {
    return withBar(
      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        <QueryError
          description="The server did not answer, so there are no results to show."
          error={error}
          message={error.message}
          onRetry={() => void refetch()}
          recovery={(onUnlocked) => (
            <SignRecovery
              autoResume
              onUnlocked={onUnlocked}
              showHeadline={false}
            />
          )}
          relayUrl={relayWsUrl()}
          testId="search-error"
          title="Couldn't search"
        />
      </div>,
    );
  }

  if (!data || data.length === 0) {
    return withBar(
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center p-8 text-center">
        <SearchX className="h-7 w-7 text-black/60 dark:text-white/60" />
        <p className="mt-2 text-sm text-black/60 dark:text-white/60">
          Nothing matches “{term}”. Try different words.
        </p>
      </div>,
    );
  }

  return withBar(
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <p className="mb-2 text-xs text-black/60 dark:text-white/60">
        {data.length} result{data.length === 1 ? "" : "s"} for “{term}”
      </p>
      <div className="divide-y divide-black/5 dark:divide-white/5">
        {data.map((event) => {
          const channelId = eventChannelId(event);
          const channel = channelId ? channelById.get(channelId) : undefined;
          const target = hitTarget(event);
          const parts = hitParts(event);
          const open = () => {
            if (target.view) {
              onOpenKnowledge?.({ view: target.view, id: target.id });
              return;
            }
            if (channelId && target.post && onOpenPost) {
              onOpenPost(channelId, target.post);
              return;
            }
            if (channelId) onOpenChannel(channelId);
          };
          return (
            <button
              key={event.id}
              type="button"
              onClick={open}
              className="block w-full py-2 text-left hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
              data-testid="search-result"
            >
              {/* Where and who as one line of text that wraps, the time at the right; then the title on its own line
                  and a short excerpt. */}
              <div className="flex items-baseline gap-2 text-xs text-black/60 dark:text-white/60">
                <p className="min-w-0 flex-1 break-words">
                  <span className="font-medium text-black/70 dark:text-white/70">
                    {channel
                      ? channel.type === "forum"
                        ? `${channel.name} · ${target.label}`
                        : `#${channel.name}`
                      : target.label}
                  </span>
                  {" · "}
                  {resolveUserName(
                    profileByPubkey.get(event.pubkey),
                    event.pubkey,
                  )}
                </p>
                <span className="shrink-0">
                  {/* `relativeTime` takes seconds, like every other call site:
                      a millisecond value reads as a timestamp far in the future
                      and renders as "just now" for every result. */}
                  {relativeTime(event.created_at)}
                </span>
              </div>
              {parts.title ? (
                <p className="mt-0.5 line-clamp-2 text-sm font-semibold text-black dark:text-white">
                  {parts.title}
                </p>
              ) : null}
              {parts.excerpt ? (
                <p
                  className={`mt-0.5 text-sm text-black/80 dark:text-white/80 ${parts.title ? "line-clamp-1" : "line-clamp-2"}`}
                >
                  {parts.excerpt.slice(0, 300)}
                </p>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>,
  );
}

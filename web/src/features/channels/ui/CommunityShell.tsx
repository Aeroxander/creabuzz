import { Search } from "lucide-react";
import { useMemo, useState } from "react";

import type { Channel } from "../use-channels";
import { ChannelSidebar } from "./ChannelSidebar";
import { ChannelTimeline } from "./ChannelTimeline";
import { SearchResults } from "@/features/search/ui/SearchResults";

/**
 * In-community shell: channel sidebar, full-text search across open
 * channels, and the selected channel's live timeline.
 */
export function CommunityShell({
  channels,
  initialChannelId,
}: {
  channels: Channel[];
  initialChannelId?: string;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(
    () => initialChannelId ?? null,
  );
  const [searchTerm, setSearchTerm] = useState("");

  const activeChannel = useMemo(
    () => channels.find((c) => c.id === selectedId) ?? null,
    [channels, selectedId],
  );

  const searching = searchTerm.trim().length >= 2;

  return (
    <div className="flex h-full min-h-0 w-full flex-1">
      <div className="flex w-60 shrink-0 flex-col border-r border-black/10 bg-[#F8F8F8] dark:border-white/10 dark:bg-[#1B1B1B]">
        <div className="px-3 pb-2 pt-3">
          <div className="flex items-center gap-2 rounded-md border border-black/10 bg-white px-2 py-1.5 dark:border-white/10 dark:bg-white/5">
            <Search className="h-3.5 w-3.5 shrink-0 text-black/40 dark:text-white/40" />
            <input
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search messages…"
              className="w-full bg-transparent text-sm text-black outline-none placeholder:text-black/40 dark:text-white dark:placeholder:text-white/40"
              data-testid="search-input"
            />
          </div>
        </div>
        <ChannelSidebar
          channels={channels}
          selectedId={activeChannel?.id ?? null}
          onSelect={(id) => {
            setSelectedId(id);
            setSearchTerm("");
          }}
        />
      </div>

      {searching ? (
        <SearchResults
          term={searchTerm.trim()}
          channels={channels}
          onOpenChannel={(channelId) => {
            setSelectedId(channelId);
            setSearchTerm("");
          }}
        />
      ) : activeChannel ? (
        <ChannelTimeline channel={activeChannel} />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-black/45 dark:text-white/45">
          Select a channel to start reading.
        </div>
      )}
    </div>
  );
}

import { ArrowLeft, BookOpen, Bot, Search, Zap } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import type { Channel } from "../use-channels";
import { ChannelSidebar } from "./ChannelSidebar";
import { ChannelTimeline } from "./ChannelTimeline";
import { SearchResults } from "@/features/search/ui/SearchResults";
import { WikiView } from "@/features/wiki/ui/WikiView";
import { FleetView } from "@/features/fleet/ui/FleetView";

/**
 * In-community shell: channel sidebar, full-text search across open
 * channels, and the selected channel's live timeline.
 */
export function CommunityShell({
  channels,
  initialChannelId,
  host,
}: {
  channels: Channel[];
  initialChannelId?: string;
  host: string;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(
    () => initialChannelId ?? null,
  );
  const [searchTerm, setSearchTerm] = useState("");
  const [showingWiki, setShowingWiki] = useState(false);
  const [showingFleet, setShowingFleet] = useState(false);

  const activeChannel = useMemo(
    () => channels.find((c) => c.id === selectedId) ?? null,
    [channels, selectedId],
  );

  const searching = searchTerm.trim().length >= 2;

  return (
    <div className="flex h-full min-h-0 w-full flex-1">
      <div className="flex w-60 shrink-0 flex-col border-r border-black/10 bg-[#F8F8F8] dark:border-white/10 dark:bg-[#1B1B1B]">
        <div className="flex items-center gap-2 px-3 pt-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-black/5 dark:bg-white/10">
            <Zap className="h-4 w-4 text-black/60 dark:text-white/60" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-black dark:text-white">
              Buzz
            </p>
            <p className="truncate text-[10px] text-black/45 dark:text-white/45">
              {host}
            </p>
          </div>
          <Link
            to="/"
            className="ml-auto shrink-0 rounded-md p-1.5 text-black/40 hover:bg-black/5 hover:text-black dark:text-white/40 dark:hover:bg-white/10 dark:hover:text-white"
            aria-label="Back to all communities"
            title="All communities"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </div>
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
        <button
          type="button"
          onClick={() => {
            setShowingFleet(false);
            setShowingWiki((v) => !v);
            setSearchTerm("");
          }}
          className={`mx-3 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm ${
            showingWiki
              ? "bg-black/10 text-black dark:bg-white/15 dark:text-white"
              : "text-black/60 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/5"
          }`}
          data-testid="wiki-toggle"
        >
          <BookOpen className="h-3.5 w-3.5" />
          {showingWiki ? "Chat" : "Wiki"}
        </button>
        <button
          type="button"
          onClick={() => {
            setShowingWiki(false);
            setShowingFleet((v) => !v);
            setSearchTerm("");
          }}
          className={`mx-3 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm ${
            showingFleet
              ? "bg-black/10 text-black dark:bg-white/15 dark:text-white"
              : "text-black/60 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10"
          }`}
          data-testid="fleet-toggle"
        >
          <Bot className="h-3.5 w-3.5" />
          {showingFleet ? "Chat" : "Agents"}
        </button>
        <ChannelSidebar
          channels={channels}
          selectedId={activeChannel?.id ?? null}
          onSelect={(id) => {
            setSelectedId(id);
            setSearchTerm("");
            setShowingWiki(false);
            setShowingFleet(false);
          }}
        />
      </div>

      {showingFleet ? (
        <FleetView channels={channels} />
      ) : showingWiki ? (
        <WikiView />
      ) : searching ? (
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

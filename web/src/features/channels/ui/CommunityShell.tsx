import {
  ArrowLeft,
  BookOpen,
  Bot,
  ListChecks,
  Search,
  Users,
  Zap,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import type { Channel } from "../use-channels";
import { ChannelSidebar } from "./ChannelSidebar";
import { ChannelTimeline } from "./ChannelTimeline";
import { SearchResults } from "@/features/search/ui/SearchResults";
import { WikiView } from "@/features/wiki/ui/WikiView";
import { FleetView } from "@/features/fleet/ui/FleetView";
import { OrgView } from "@/features/fleet/ui/OrgView";
import { WorkBoard } from "@/features/fleet/ui/WorkBoard";
import { ProfileMenu } from "@/features/identity/ui/ProfileMenu";
import { PasskeyUnlockGate } from "@/features/identity/ui/PasskeyUnlockGate";

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
  const [showingWork, setShowingWork] = useState(false);
  const [showingOrg, setShowingOrg] = useState(false);

  const activeChannel = useMemo(
    () => channels.find((c) => c.id === selectedId) ?? null,
    [channels, selectedId],
  );

  const searching = searchTerm.trim().length >= 2;

  /** Exactly one sidebar view is on at a time (or none → chat). */
  const setView = (view: "wiki" | "fleet" | "work" | "org") => {
    const active =
      view === "wiki"
        ? showingWiki
        : view === "fleet"
          ? showingFleet
          : view === "work"
            ? showingWork
            : showingOrg;
    setShowingWiki(view === "wiki" && !active);
    setShowingFleet(view === "fleet" && !active);
    setShowingWork(view === "work" && !active);
    setShowingOrg(view === "org" && !active);
  };

  return (
    <PasskeyUnlockGate>
      <div className="flex h-full min-h-0 w-full flex-1">
        <div className="flex w-60 shrink-0 flex-col">
          <div className="flex items-center gap-2 px-3 pt-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[#43e296]/15 dark:bg-[#43e296]/20">
              <Zap className="h-4 w-4 text-[#0e9f66] dark:text-[#43e296]" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-black dark:text-white">
                Creaton
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
              setSearchTerm("");
              setView("wiki");
            }}
            className={`mx-3 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm ${
              showingWiki
                ? "bg-black/10 text-black dark:bg-white/15 dark:text-white"
                : "text-black/60 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/5"
            }`}
            data-testid="wiki-toggle"
          >
            <BookOpen className="h-3.5 w-3.5" />
            Wiki
          </button>
          <button
            type="button"
            onClick={() => {
              setSearchTerm("");
              setView("fleet");
            }}
            className={`mx-3 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm ${
              showingFleet
                ? "bg-black/10 text-black dark:bg-white/15 dark:text-white"
                : "text-black/60 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10"
            }`}
            data-testid="fleet-toggle"
          >
            <Bot className="h-3.5 w-3.5" />
            Agents
          </button>
          <button
            type="button"
            onClick={() => {
              setSearchTerm("");
              setView("work");
            }}
            className={`mx-3 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm ${
              showingWork
                ? "bg-black/10 text-black dark:bg-white/15 dark:text-white"
                : "text-black/60 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10"
            }`}
            data-testid="work-toggle"
          >
            <ListChecks className="h-3.5 w-3.5" />
            Work
          </button>
          <button
            type="button"
            onClick={() => {
              setSearchTerm("");
              setView("org");
            }}
            className={`mx-3 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm ${
              showingOrg
                ? "bg-black/10 text-black dark:bg-white/15 dark:text-white"
                : "text-black/60 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10"
            }`}
            data-testid="org-toggle"
          >
            <Users className="h-3.5 w-3.5" />
            Org
          </button>
          <ChannelSidebar
            channels={channels}
            selectedId={activeChannel?.id ?? null}
            onSelect={(id) => {
              setSelectedId(id);
              setSearchTerm("");
              setShowingWiki(false);
              setShowingFleet(false);
              setShowingWork(false);
              setShowingOrg(false);
            }}
          />
          <div className="mt-auto border-t border-black/10 px-3 py-2.5 dark:border-white/10">
            <ProfileMenu />
          </div>
        </div>

        <div className="buzz-content-card mb-2 mr-2 mt-1 flex min-h-0 flex-1 flex-col">
          {showingOrg ? (
            <OrgView />
          ) : showingWork ? (
            <WorkBoard channels={channels} />
          ) : showingFleet ? (
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
            <ChannelTimeline
              channel={activeChannel}
              onShowFleet={() => {
                setShowingWiki(false);
                setShowingFleet(true);
                setShowingWork(false);
              }}
              onShowWork={() => {
                setShowingWiki(false);
                setShowingFleet(false);
                setShowingWork(true);
              }}
            />
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-black/45 dark:text-white/45">
              Select a channel to start reading.
            </div>
          )}
        </div>
      </div>
    </PasskeyUnlockGate>
  );
}

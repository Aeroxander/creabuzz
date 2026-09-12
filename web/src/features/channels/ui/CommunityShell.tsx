import {
  ArrowLeft,
  BookOpen,
  Bot,
  ListChecks,
  Menu,
  Search,
  Users,
  Zap,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useNavigate } from "@tanstack/react-router";
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";

import type { Channel } from "../use-channels";
import { ChannelSidebar } from "./ChannelSidebar";
import { ChannelTimeline } from "./ChannelTimeline";
import { ProfileMenu } from "@/features/identity/ui/ProfileMenu";
import { PasskeyUnlockGate } from "@/features/identity/ui/PasskeyUnlockGate";
import { NotificationBell } from "@/features/notifications/ui/NotificationBell";
import { ViewLoadingFallback } from "@/shared/ui/ViewLoadingFallback";

// Sidebar panels load on first use. The wiki alone pulls TipTap, Yjs and the
// P2P transport; the fleet views pull the kanban and roster, and search pulls
// the index client. None of it is needed to read a channel, which is what the
// first load is for.
const WikiView = lazy(() =>
  import("@/features/wiki/ui/WikiView").then((m) => ({ default: m.WikiView })),
);
const FleetView = lazy(() =>
  import("@/features/fleet/ui/FleetView").then((m) => ({
    default: m.FleetView,
  })),
);
const OrgView = lazy(() =>
  import("@/features/fleet/ui/OrgView").then((m) => ({ default: m.OrgView })),
);
const WorkBoard = lazy(() =>
  import("@/features/fleet/ui/WorkBoard").then((m) => ({
    default: m.WorkBoard,
  })),
);
const SearchResults = lazy(() =>
  import("@/features/search/ui/SearchResults").then((m) => ({
    default: m.SearchResults,
  })),
);

/**
 * In-community shell: channel sidebar, full-text search across open
 * channels, and the selected channel's live timeline.
 */
export function CommunityShell({
  channels,
  initialChannelId,
  initialMessageId,
  initialView,
  initialPage,
  initialWorkId,
  host,
  hasMoreChannels = false,
  loadingMoreChannels = false,
  moreChannelsError = null,
  onLoadMoreChannels,
}: {
  channels: Channel[];
  initialChannelId?: string;
  /** Message permalink target: scrolled to and highlighted, then released. */
  initialMessageId?: string;
  /** Surface from the URL: `wiki`, `work`, `org`, `fleet`, or channels. */
  initialView?: "wiki" | "work" | "org" | "fleet";
  /** Wiki page slug from the URL. */
  initialPage?: string;
  /** Work-item id from the URL. */
  initialWorkId?: string;
  host: string;
  /** Paging for a community with more channels than one relay page. */
  hasMoreChannels?: boolean;
  loadingMoreChannels?: boolean;
  moreChannelsError?: unknown;
  onLoadMoreChannels?: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(
    () => initialChannelId ?? null,
  );
  const [searchTerm, setSearchTerm] = useState("");
  const [highlightedMessage, setHighlightedMessage] = useState<string | null>(
    () => initialMessageId ?? null,
  );

  // The highlight is a one-shot cue: drop it so the row does not stay lit for
  // the rest of the session.
  useEffect(() => {
    if (!highlightedMessage) return;
    const timer = setTimeout(() => setHighlightedMessage(null), 4000);
    return () => clearTimeout(timer);
  }, [highlightedMessage]);
  // The surface comes from the URL, so a knowledge object can be linked to and
  // a reload returns to the same place.
  const [showingWiki, setShowingWiki] = useState(initialView === "wiki");
  const [showingFleet, setShowingFleet] = useState(initialView === "fleet");
  const [showingWork, setShowingWork] = useState(initialView === "work");
  const [showingOrg, setShowingOrg] = useState(initialView === "org");
  /**
   * Slide-over channel list. Below `lg` the panel is off-canvas, so this is the
   * only way to reach it; at `lg` and up it is a static column and this state
   * no longer affects the layout.
   */
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Search shortcut, matching the desktop client. On narrow screens the field
  // lives in the slide-over, so the shortcut opens it before focusing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== "k"
      ) {
        return;
      }
      event.preventDefault();
      setSidebarOpen(true);
      const input = searchInputRef.current;
      input?.focus();
      input?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Escape closes the slide-over, matching every other dismissible surface.
  useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSidebarOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidebarOpen]);

  // Tied to this route so a search-only update keeps the type of its schema.
  const navigate = useNavigate({ from: "/c/$host" });

  const activeChannel = useMemo(
    () => channels.find((c) => c.id === selectedId) ?? null,
    [channels, selectedId],
  );

  /**
   * Select a channel and keep the URL in step.
   *
   * The deep link already *reads* `?channel=`, so a channel the reader picked
   * belongs in the address bar too: that is what makes it linkable and
   * bookmarkable, and what lets anything else — a test, a bug report, a
   * teammate — name the channel that is on screen. `replace` keeps channel
   * hopping out of the history stack.
   */
  const selectChannel = (channelId: string) => {
    setSelectedId(channelId);
    void navigate({
      search: (previous) => ({ ...previous, channel: channelId }),
      replace: true,
    });
  };

  const searching = searchTerm.trim().length >= 2;

  /** Exactly one sidebar view is on at a time (or none → chat). */
  const setView = (view: "wiki" | "fleet" | "work" | "org") => {
    // The toggles live in the slide-over: dismiss it so the view is visible.
    setSidebarOpen(false);
    const active =
      view === "wiki"
        ? showingWiki
        : view === "fleet"
          ? showingFleet
          : view === "work"
            ? showingWork
            : showingOrg;
    const next = !active;
    setShowingWiki(view === "wiki" && next);
    setShowingFleet(view === "fleet" && next);
    setShowingWork(view === "work" && next);
    setShowingOrg(view === "org" && next);
    writeView(next ? view : undefined);
  };

  /**
   * Keep the URL in step with the surface. `replace` so toggling panels does not
   * fill the history stack, and `page`/`work` are dropped when leaving their
   * surface so a stale slug never rides along.
   */
  const writeView = (view?: "wiki" | "work" | "org" | "fleet") => {
    void navigate({
      search: (previous) => ({
        ...previous,
        view,
        page: view === "wiki" ? previous.page : undefined,
        work: view === "work" ? previous.work : undefined,
      }),
      replace: true,
    });
  };

  /** Wiki page selection, mirrored into the URL for linking. */
  const selectWikiPage = (slug: string) => {
    void navigate({
      search: (previous) => ({ ...previous, view: "wiki", page: slug }),
      replace: true,
    });
  };

  return (
    <PasskeyUnlockGate>
      <div className="flex h-full min-h-0 w-full flex-1">
        {sidebarOpen ? (
          <button
            type="button"
            aria-label="Close channel list"
            className="fixed inset-0 z-30 cursor-default bg-black/40 lg:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        ) : null}
        <div
          className={`fixed inset-y-0 left-0 z-40 flex w-60 shrink-0 flex-col bg-[#F8F8F8] shadow-xl transition-transform duration-200 ease-out dark:bg-[#1B1B1B] lg:static lg:z-auto lg:w-[264px] lg:translate-x-0 lg:bg-transparent lg:shadow-none lg:transition-none ${
            sidebarOpen ? "translate-x-0" : "-translate-x-full"
          }`}
          id="channel-sidebar"
        >
          <div className="flex items-center gap-2 px-3 pt-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[#43e296]/15 dark:bg-[#43e296]/20">
              <Zap className="h-4 w-4 text-[#0e9f66] dark:text-[#43e296]" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-black dark:text-white">
                Creaton
              </p>
              <p className="truncate text-2xs text-black/60 dark:text-white/60">
                {host}
              </p>
            </div>
            <Link
              to="/"
              className="ml-auto shrink-0 rounded-md p-1.5 text-black/60 hover:bg-black/5 hover:text-black dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white"
              aria-label="Back to all communities"
              title="All communities"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </div>
          <NotificationBell
            onOpenChannel={(channelId) => {
              selectChannel(channelId);
              setSearchTerm("");
              setShowingWiki(false);
              setShowingFleet(false);
              setShowingWork(false);
              setShowingOrg(false);
              setSidebarOpen(false);
            }}
            onOpenWork={() => setView("work")}
          />
          <div className="px-3 pb-2 pt-3">
            <div className="flex items-center gap-2 rounded-md border border-black/10 bg-white px-2 py-1.5 dark:border-white/10 dark:bg-white/5">
              <Search className="h-3.5 w-3.5 shrink-0 text-black/60 dark:text-white/60" />
              <input
                aria-keyshortcuts="Control+K Meta+K"
                ref={searchInputRef}
                value={searchTerm}
                onChange={(e) => {
                  setSearchTerm(e.target.value);
                  // Results render behind the slide-over; step aside for them.
                  if (e.target.value.trim().length >= 2) setSidebarOpen(false);
                }}
                placeholder="Search messages…"
                className="w-full bg-transparent text-sm text-black outline-none placeholder:text-black/60 dark:text-white dark:placeholder:text-white/40"
                data-testid="search-input"
              />
              <kbd className="hidden shrink-0 rounded border border-black/10 px-1 text-2xs font-medium text-black/60 lg:block dark:border-white/15 dark:text-white/60">
                ⌘K
              </kbd>
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
            hasMore={
              onLoadMoreChannels != null &&
              (hasMoreChannels ||
                loadingMoreChannels ||
                moreChannelsError != null)
            }
            loadingMore={loadingMoreChannels}
            moreError={moreChannelsError}
            onLoadMore={onLoadMoreChannels}
            selectedId={activeChannel?.id ?? null}
            onSelect={(id) => {
              selectChannel(id);
              setSearchTerm("");
              setShowingWiki(false);
              setShowingFleet(false);
              setShowingWork(false);
              setShowingOrg(false);
              setSidebarOpen(false);
            }}
          />
          <div className="mt-auto border-t border-black/10 px-3 py-2.5 dark:border-white/10">
            <ProfileMenu />
          </div>
        </div>

        <div
          className="flex min-h-0 min-w-0 flex-1 flex-col"
          data-testid="content-pane"
        >
          <div className="flex items-center gap-2 border-b border-black/10 px-3 py-2 lg:hidden dark:border-white/10">
            <button
              type="button"
              aria-controls="channel-sidebar"
              aria-expanded={sidebarOpen}
              aria-label="Open channel list"
              className="rounded-md p-1.5 text-black/60 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10"
              data-testid="open-channel-list"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu className="h-4 w-4" />
            </button>
            <span className="truncate text-sm font-semibold text-black dark:text-white">
              {host}
            </span>
          </div>
          <div className="buzz-content-card mb-2 mr-2 mt-px flex min-h-0 min-w-0 flex-1 flex-col">
            {showingOrg ? (
              <Suspense fallback={<ViewLoadingFallback label="Loading org…" />}>
                <OrgView />
              </Suspense>
            ) : showingWork ? (
              <Suspense
                fallback={<ViewLoadingFallback label="Loading the board…" />}
              >
                <WorkBoard
                  channels={channels}
                  initialItemId={initialWorkId}
                  onSelectItem={(id) => {
                    void navigate({
                      search: (previous) => ({
                        ...previous,
                        view: "work",
                        work: id ?? undefined,
                      }),
                      replace: true,
                    });
                  }}
                />
              </Suspense>
            ) : showingFleet ? (
              <Suspense
                fallback={<ViewLoadingFallback label="Loading agents…" />}
              >
                <FleetView channels={channels} />
              </Suspense>
            ) : showingWiki ? (
              <Suspense
                fallback={<ViewLoadingFallback label="Loading the wiki…" />}
              >
                <WikiView
                  initialSlug={initialPage}
                  onSlugChange={selectWikiPage}
                />
              </Suspense>
            ) : searching ? (
              <Suspense fallback={<ViewLoadingFallback label="Searching…" />}>
                <SearchResults
                  onOpenKnowledge={({ view, id }) => {
                    setView(view);
                    if (view === "wiki" && id) selectWikiPage(id);
                    if (view === "work" && id) {
                      void navigate({
                        search: (previous) => ({
                          ...previous,
                          view: "work",
                          work: id,
                        }),
                        replace: true,
                      });
                    }
                  }}
                  term={searchTerm.trim()}
                  channels={channels}
                  onOpenChannel={(channelId) => {
                    selectChannel(channelId);
                    setSearchTerm("");
                  }}
                />
              </Suspense>
            ) : activeChannel ? (
              <ChannelTimeline
                channel={activeChannel}
                highlightedId={highlightedMessage}
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
              <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-black/60 dark:text-white/60">
                Select a channel to start reading.
              </div>
            )}
          </div>
        </div>
      </div>
    </PasskeyUnlockGate>
  );
}

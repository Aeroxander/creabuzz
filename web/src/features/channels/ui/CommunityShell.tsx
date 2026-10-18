import {
  BookOpen,
  Bot,
  ListChecks,
  Menu,
  MessageSquare,
  Rocket,
  Search,
  ShieldCheck,
  Users,
  Zap,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";

import type { Channel } from "../use-channels";
import { ChannelSidebar } from "./ChannelSidebar";
import { ChannelTimeline } from "./ChannelTimeline";
import { PasskeyUnlockGate } from "@/features/identity/ui/PasskeyUnlockGate";
import { useModerationAccess } from "@/features/moderation/use-moderation-queue";
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
const BoardView = lazy(() =>
  import("@/features/board/ui/BoardView").then((m) => ({
    default: m.BoardView,
  })),
);
// A thread about a DAO decision reads the chain; only then is that code needed.
const ProposalExtras = lazy(() =>
  import("@/features/launchpad/ui/ProposalExtras").then((m) => ({
    default: m.ProposalExtras,
  })),
);
const ProposalStates = lazy(() =>
  import("@/features/launchpad/ui/ProposalStates").then((m) => ({
    default: m.ProposalStates,
  })),
);
const StartProject = lazy(() =>
  import("@/features/templates/ui/StartProject").then((m) => ({
    default: m.StartProject,
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
const DmView = lazy(() =>
  import("@/features/dms/DmView").then((m) => ({ default: m.DmView })),
);
const ModerationQueuePanel = lazy(() =>
  import("@/features/moderation/ui/ModerationQueuePanel").then((m) => ({
    default: m.ModerationQueuePanel,
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
  initialPostId,
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
  /** A board post from the URL: opens its thread. */
  initialPostId?: string;
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
  const [openPostId, setOpenPostId] = useState<string | null>(
    () => initialPostId ?? null,
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
  /** Start-a-project picker (local state like DMs: not a linkable view). */
  const [showingStart, setShowingStart] = useState(false);
  /**
   * Direct messages panel. Local state like search (not a linkable URL view)
   * so the community route stays untouched.
   */
  const [showingDms, setShowingDms] = useState(false);
  /**
   * Moderation queue (local state like DMs — not a linkable URL view).
   * The entry is owner/moderator-gated by the server's access probe.
   */
  const [showingModeration, setShowingModeration] = useState(false);
  const { access: moderationAccess } = useModerationAccess();
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

  /** Open (or close) the start-a-project picker, leaving every other view. */
  const showStart = (open: boolean) => {
    setSearchTerm("");
    setSidebarOpen(false);
    setShowingWiki(false);
    setShowingFleet(false);
    setShowingWork(false);
    setShowingOrg(false);
    setShowingDms(false);
    setShowingModeration(false);
    setShowingStart(open);
    writeView(undefined);
  };

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
    setOpenPostId(null);
    void navigate({
      search: (previous) => ({
        ...previous,
        channel: channelId,
        post: undefined,
      }),
      replace: true,
    });
  };

  /** Open a board post (or go back to the list with null), mirrored into the URL. */
  const openPost = (postId: string | null) => {
    setOpenPostId(postId);
    void navigate({
      search: (previous) => ({ ...previous, post: postId ?? undefined }),
      replace: true,
    });
  };

  const searching = searchTerm.trim().length >= 2;

  /** Exactly one sidebar view is on at a time (or none → chat). */
  const setView = (view: "wiki" | "fleet" | "work" | "org") => {
    // The toggles live in the slide-over: dismiss it so the view is visible.
    setSidebarOpen(false);
    setShowingDms(false);
    setShowingModeration(false);
    setShowingStart(false);
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
          className={`fixed inset-y-0 left-0 z-40 flex w-60 shrink-0 flex-col bg-sidebar shadow-xl transition-transform duration-200 ease-out lg:static lg:z-auto lg:w-[264px] lg:translate-x-0 lg:bg-transparent lg:shadow-none lg:transition-none ${
            sidebarOpen ? "translate-x-0" : "-translate-x-full"
          }`}
          id="channel-sidebar"
        >
          <div className="flex items-center gap-2 px-3 pt-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[#43e296]/15 dark:bg-[#43e296]/20">
              <Zap className="h-4 w-4 text-[#0e9f66] dark:text-[#43e296]" />
            </div>
            <p className="min-w-0 truncate text-sm font-semibold text-black dark:text-white">
              {host}
            </p>
          </div>
          <NotificationBell
            onOpenChannel={(channelId) => {
              selectChannel(channelId);
              setSearchTerm("");
              setShowingWiki(false);
              setShowingFleet(false);
              setShowingWork(false);
              setShowingOrg(false);
              setShowingDms(false);
              setShowingModeration(false);
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
            onClick={() => showStart(!showingStart)}
            className={`mx-3 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm ${
              showingStart
                ? "bg-black/10 text-black dark:bg-white/15 dark:text-white"
                : "text-black/60 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/5"
            }`}
            data-testid="start-project-toggle"
          >
            <Rocket className="h-3.5 w-3.5" />
            Set up community
          </button>
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
            AI helpers
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
          <button
            type="button"
            onClick={() => {
              setSearchTerm("");
              setSidebarOpen(false);
              const next = !showingDms;
              setShowingWiki(false);
              setShowingFleet(false);
              setShowingWork(false);
              setShowingOrg(false);
              setShowingModeration(false);
              setShowingStart(false);
              setShowingDms(next);
              writeView(undefined);
            }}
            className={`mx-3 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm ${
              showingDms
                ? "bg-black/10 text-black dark:bg-white/15 dark:text-white"
                : "text-black/60 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/5"
            }`}
            data-testid="dms-toggle"
          >
            <MessageSquare className="h-3.5 w-3.5" />
            Messages
          </button>
          {moderationAccess === "granted" ? (
            <button
              type="button"
              onClick={() => {
                setSearchTerm("");
                setSidebarOpen(false);
                const next = !showingModeration;
                setShowingWiki(false);
                setShowingFleet(false);
                setShowingWork(false);
                setShowingOrg(false);
                setShowingDms(false);
                setShowingStart(false);
                setShowingModeration(next);
                writeView(undefined);
              }}
              className={`mx-3 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm ${
                showingModeration
                  ? "bg-black/10 text-black dark:bg-white/15 dark:text-white"
                  : "text-black/60 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/5"
              }`}
              data-testid="moderation-toggle"
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              Moderation
            </button>
          ) : null}
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
              setShowingDms(false);
              setShowingModeration(false);
              setShowingStart(false);
              setSidebarOpen(false);
            }}
          />
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
            {showingStart ? (
              <section
                aria-label="Community setup"
                className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
                data-testid="community-setup-scroll"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need to focus this scroll container to scroll it.
                tabIndex={0}
              >
                <Suspense
                  fallback={<ViewLoadingFallback label="Loading templates…" />}
                >
                  <StartProject
                    onOpenChannel={(channelId) => {
                      selectChannel(channelId);
                      setShowingStart(false);
                    }}
                    onOpenView={(view) => {
                      setShowingStart(false);
                      setView(view === "agents" ? "fleet" : view);
                    }}
                  />
                </Suspense>
              </section>
            ) : showingDms ? (
              <Suspense
                fallback={<ViewLoadingFallback label="Loading messages…" />}
              >
                <DmView />
              </Suspense>
            ) : showingModeration ? (
              <Suspense
                fallback={<ViewLoadingFallback label="Loading reports…" />}
              >
                <ModerationQueuePanel />
              </Suspense>
            ) : showingOrg ? (
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
                fallback={<ViewLoadingFallback label="Loading helpers…" />}
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
            ) : activeChannel?.type === "forum" ? (
              <Suspense
                fallback={<ViewLoadingFallback label="Loading the board…" />}
              >
                <BoardView
                  channel={activeChannel}
                  key={activeChannel.id}
                  onOpenPost={openPost}
                  postId={openPostId ?? undefined}
                  proposalExtras={ProposalExtras}
                  proposalStates={ProposalStates}
                  suggestPeopleFrom={
                    channels.find(
                      (c) => c.type !== "forum" && c.visibility === "public",
                    )?.id ?? null
                  }
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
              <div
                className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-black/60 dark:text-white/60"
                data-testid={
                  channels.length === 0 ? "empty-community" : undefined
                }
              >
                {channels.length === 0 ? (
                  <>
                    <p className="text-base font-semibold text-foreground">
                      Nothing here yet
                    </p>
                    <p className="max-w-sm">
                      Choose a ready-made team and this community fills with
                      channels, AI helpers and shared pages.
                    </p>
                    <button
                      className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
                      data-testid="empty-community-start"
                      onClick={() => showStart(true)}
                      type="button"
                    >
                      Set up community
                    </button>
                  </>
                ) : (
                  "Select a channel to start reading."
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </PasskeyUnlockGate>
  );
}

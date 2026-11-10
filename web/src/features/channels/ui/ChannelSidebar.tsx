import {
  ChevronDown,
  Hash,
  LoaderCircle,
  Lock,
  Newspaper,
  Plus,
  Users,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { existingUserPubkey } from "@/shared/lib/identity";

import { Button } from "@/shared/ui/button";
import { readFailureWords } from "@/shared/lib/readable-error";
import { TechnicalDetails } from "@/shared/ui/technical-details";

import { type ChannelUnread, unreadMarker } from "../lib/read-state";
import type { Channel } from "../use-channels";
import { CreateChannelDialog } from "./CreateChannelDialog";

function ChannelButton({
  channel,
  selected,
  onSelect,
  testId,
  unread = null,
}: {
  channel: Channel;
  selected: boolean;
  onSelect: () => void;
  testId: string;
  /** What is unread in it, shown unless it is the one open. */
  unread?: ReturnType<typeof unreadMarker>;
}) {
  const board = channel.type === "forum";
  const marker = selected ? null : unread;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "page" : undefined}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
        selected
          ? "bg-black/10 text-black dark:bg-white/15 dark:text-white"
          : "text-black/60 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/5"
      }`}
      data-testid={testId}
    >
      {channel.visibility === "private" ? (
        <Lock className="h-3.5 w-3.5 shrink-0" />
      ) : board ? (
        <Newspaper className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <Hash className="h-3.5 w-3.5 shrink-0" />
      )}
      <span
        className={`truncate ${marker ? "font-semibold text-black dark:text-white" : ""}`}
      >
        {channel.name}
      </span>
      {marker ? (
        <span
          className={`ml-auto shrink-0 rounded-full px-1.5 text-2xs font-semibold ${
            marker.attention
              ? "bg-destructive text-destructive-foreground"
              : "bg-black/10 text-black dark:bg-white/15 dark:text-white"
          }`}
          data-testid={`${testId}-unread`}
        >
          {marker.label ?? <span aria-hidden>•</span>}
          <span className="sr-only">{`, ${marker.words}`}</span>
        </span>
      ) : null}
      {channel.visibility === "private" && (
        <span
          className={`${marker ? "" : "ml-auto "}shrink-0 text-2xs text-black/60 uppercase dark:text-white/60`}
          title={
            board
              ? "Private board. Only people who were added can read it."
              : "Private room. One of its admins has to add you."
          }
        >
          private
        </span>
      )}
    </button>
  );
}

function SectionHeader({
  label,
  icon,
  collapsed,
  onToggle,
  actionLabel,
  actionTestId,
  onAction,
}: {
  label: string;
  icon: ReactNode;
  collapsed: boolean;
  onToggle: () => void;
  actionLabel: string;
  actionTestId: string;
  /** Left out for a visitor, who has no account to make anything with. */
  onAction?: () => void;
}) {
  return (
    <div className="flex items-center gap-1 px-4 py-3">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="flex items-center gap-2 text-sm font-semibold text-black/70 dark:text-white/70"
      >
        {icon} {label}
        <ChevronDown
          className={`h-3.5 w-3.5 text-black/60 transition-transform dark:text-white/60 ${
            collapsed ? "-rotate-90" : ""
          }`}
        />
      </button>
      {onAction ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto h-7 gap-1 px-2 text-xs"
          onClick={onAction}
          data-testid={actionTestId}
        >
          <Plus className="h-3.5 w-3.5" /> {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}

export function ChannelSidebar({
  channels,
  selectedId,
  onSelect,
  hasMore = false,
  loadingMore = false,
  moreError = null,
  onLoadMore,
  unread,
  unreadPaused = false,
  onRefreshUnread,
}: {
  channels: Channel[];
  selectedId: string | null;
  /** Unread counts by room or board, when the server offers them. */
  unread?: ReadonlyMap<string, ChannelUnread>;
  /** The unread counts stopped refreshing and may be out of date. */
  unreadPaused?: boolean;
  onRefreshUnread?: () => void;
  onSelect: (id: string) => void;
  /** A community can have more channels than one relay page. */
  hasMore?: boolean;
  loadingMore?: boolean;
  moreError?: unknown;
  onLoadMore?: () => void;
}) {
  const [chatsCollapsed, setChatsCollapsed] = useState(false);
  const [boardsCollapsed, setBoardsCollapsed] = useState(false);
  const [creating, setCreating] = useState<"stream" | "forum" | null>(null);
  const boards = channels.filter((channel) => channel.type === "forum");
  const chats = channels.filter((channel) => channel.type !== "forum");
  const moreFailure = moreError != null ? readFailureWords(moreError) : null;
  const signedIn = existingUserPubkey() !== null;
  return (
    <aside className="flex min-h-0 w-full flex-1 flex-col">
      <SectionHeader
        actionLabel="New board"
        actionTestId="new-board"
        collapsed={boardsCollapsed}
        icon={<Newspaper className="h-4 w-4" />}
        label="Boards"
        onAction={signedIn ? () => setCreating("forum") : undefined}
        onToggle={() => setBoardsCollapsed((v) => !v)}
      />
      {!boardsCollapsed && (
        <nav aria-label="Boards" className="px-2 pb-2" data-testid="board-list">
          {boards.length === 0 ? (
            <div className="px-2">
              <p className="text-xs text-black/60 dark:text-white/60">
                Posts and replies that stay easy to find. A project's own boards
                are made on its page.
              </p>
            </div>
          ) : (
            boards.map((board) => (
              <ChannelButton
                channel={board}
                key={board.id}
                onSelect={() => onSelect(board.id)}
                selected={board.id === selectedId}
                testId={`board-nav-${board.name}`}
                unread={unreadMarker(unread?.get(board.id))}
              />
            ))
          )}
        </nav>
      )}
      <SectionHeader
        actionLabel="New room"
        actionTestId="new-channel"
        collapsed={chatsCollapsed}
        icon={<Users className="h-4 w-4" />}
        label="Rooms"
        onAction={signedIn ? () => setCreating("stream") : undefined}
        onToggle={() => setChatsCollapsed((v) => !v)}
      />
      {!chatsCollapsed && (
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {chats.map((channel) => (
            <ChannelButton
              channel={channel}
              key={channel.id}
              onSelect={() => onSelect(channel.id)}
              selected={channel.id === selectedId}
              testId={`channel-${channel.name}`}
              unread={unreadMarker(unread?.get(channel.id))}
            />
          ))}

          {hasMore || loadingMore || moreError != null ? (
            <div className="px-2 py-2">
              {moreFailure !== null ? (
                <>
                  <p
                    className="text-xs text-amber-700 dark:text-amber-300"
                    data-testid="channels-more-error"
                    role="alert"
                  >
                    Couldn't load more rooms. {moreFailure.text}{" "}
                    <button
                      type="button"
                      className="underline"
                      onClick={onLoadMore}
                    >
                      Try again
                    </button>
                  </p>
                  <TechnicalDetails
                    className="mt-1"
                    detail={moreFailure.detail}
                    testId="channels-more-error-details"
                  />
                </>
              ) : (
                <button
                  type="button"
                  className="rounded-full border border-black/10 bg-white px-3 py-1 text-xs font-medium text-black/70 disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-white/70"
                  data-testid="load-more-channels"
                  disabled={loadingMore}
                  onClick={onLoadMore}
                >
                  {loadingMore ? "Loading more rooms…" : "Load more rooms"}
                </button>
              )}
            </div>
          ) : null}
        </nav>
      )}
      {unreadPaused && onRefreshUnread ? (
        <p
          className="border-t border-black/10 px-4 py-2 text-xs text-black/60 dark:border-white/10 dark:text-white/60"
          data-testid="unread-paused"
          role="status"
        >
          Unread counts may be out of date.{" "}
          <button className="underline" onClick={onRefreshUnread} type="button">
            Refresh
          </button>
        </p>
      ) : null}
      <p className="border-t border-black/10 px-4 py-2 text-xs text-black/60 dark:border-white/10 dark:text-white/60">
        {chats.length} room{chats.length === 1 ? "" : "s"}
        {boards.length > 0
          ? ` · ${boards.length} board${boards.length === 1 ? "" : "s"}`
          : ""}
      </p>
      <CreateChannelDialog
        defaultType={creating ?? "stream"}
        onOpenChange={(next) => {
          if (!next) setCreating(null);
        }}
        open={creating !== null}
      />
    </aside>
  );
}

export function ChannelSidebarLoading() {
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-black/10 bg-sidebar px-4 py-4 dark:border-white/10">
      <LoaderCircle className="h-4 w-4 animate-spin text-black/60 dark:text-white/60" />
    </aside>
  );
}

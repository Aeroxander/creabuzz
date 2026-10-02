import {
  ChevronDown,
  Hash,
  LoaderCircle,
  Lock,
  Plus,
  Users,
} from "lucide-react";
import { useState } from "react";

import { Button } from "@/shared/ui/button";
import { errorMessage } from "@/shared/ui/query-error";

import type { Channel } from "../use-channels";
import { CreateChannelDialog } from "./CreateChannelDialog";

export function ChannelSidebar({
  channels,
  selectedId,
  onSelect,
  hasMore = false,
  loadingMore = false,
  moreError = null,
  onLoadMore,
}: {
  channels: Channel[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** A community can have more channels than one relay page. */
  hasMore?: boolean;
  loadingMore?: boolean;
  moreError?: unknown;
  onLoadMore?: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [creating, setCreating] = useState(false);
  return (
    <aside className="flex min-h-0 w-full flex-1 flex-col">
      <div className="flex items-center gap-1 px-4 py-3">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
          className="flex items-center gap-2 text-sm font-semibold text-black/70 dark:text-white/70"
        >
          <Users className="h-4 w-4" /> Channels
          <ChevronDown
            className={`h-3.5 w-3.5 text-black/60 transition-transform dark:text-white/60 ${
              collapsed ? "-rotate-90" : ""
            }`}
          />
        </button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto h-7 gap-1 px-2 text-xs"
          onClick={() => setCreating(true)}
          data-testid="new-channel"
        >
          <Plus className="h-3.5 w-3.5" /> New channel
        </Button>
      </div>
      {!collapsed && (
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {channels.map((channel) => (
            <button
              key={channel.id}
              type="button"
              onClick={() => onSelect(channel.id)}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
                channel.id === selectedId
                  ? "bg-black/10 text-black dark:bg-white/15 dark:text-white"
                  : "text-black/60 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/5"
              }`}
              data-testid={`channel-${channel.name}`}
            >
              {channel.visibility === "private" ? (
                <Lock className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <Hash className="h-3.5 w-3.5 shrink-0" />
              )}
              <span className="truncate">{channel.name}</span>
              {channel.visibility === "private" && (
                <span
                  className="ml-auto shrink-0 text-2xs text-black/60 uppercase dark:text-white/60"
                  title="Private channel — join requires a member with admin rights to add you"
                >
                  private
                </span>
              )}
            </button>
          ))}

          {hasMore || loadingMore || moreError != null ? (
            <div className="px-2 py-2">
              {moreError != null ? (
                <p
                  className="text-xs text-amber-700 dark:text-amber-300"
                  data-testid="channels-more-error"
                  role="alert"
                >
                  Couldn't load more channels — {errorMessage(moreError)}.{" "}
                  <button
                    type="button"
                    className="underline"
                    onClick={onLoadMore}
                  >
                    Try again
                  </button>
                </p>
              ) : (
                <button
                  type="button"
                  className="rounded-full border border-black/10 bg-white px-3 py-1 text-xs font-medium text-black/70 disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-white/70"
                  data-testid="load-more-channels"
                  disabled={loadingMore}
                  onClick={onLoadMore}
                >
                  {loadingMore
                    ? "Loading more channels…"
                    : "Load more channels"}
                </button>
              )}
            </div>
          ) : null}
        </nav>
      )}
      <p className="border-t border-black/10 px-4 py-2 text-xs text-black/60 dark:border-white/10 dark:text-white/60">
        {channels.length} channel{channels.length === 1 ? "" : "s"}
      </p>
      <CreateChannelDialog open={creating} onOpenChange={setCreating} />
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

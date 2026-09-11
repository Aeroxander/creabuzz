import { ChevronDown, Hash, LoaderCircle, Lock, Users } from "lucide-react";
import { useState } from "react";

import type { Channel } from "../use-channels";

export function ChannelSidebar({
  channels,
  selectedId,
  onSelect,
}: {
  channels: Channel[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <aside className="flex min-h-0 w-full flex-1 flex-col">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
        className="flex items-center gap-2 px-4 py-3 text-sm font-semibold text-black/70 dark:text-white/70"
      >
        <Users className="h-4 w-4" /> Channels
        <ChevronDown
          className={`ml-auto h-3.5 w-3.5 text-black/60 transition-transform dark:text-white/60 ${
            collapsed ? "-rotate-90" : ""
          }`}
        />
      </button>
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
                  className="ml-auto shrink-0 text-[10px] text-black/60 uppercase dark:text-white/60"
                  title="Private channel — join requires a member with admin rights to add you"
                >
                  private
                </span>
              )}
            </button>
          ))}
        </nav>
      )}
      <p className="border-t border-black/10 px-4 py-2 text-xs text-black/60 dark:border-white/10 dark:text-white/60">
        {channels.length} channel{channels.length === 1 ? "" : "s"}
      </p>
    </aside>
  );
}

export function ChannelSidebarLoading() {
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-black/10 bg-[#F8F8F8] px-4 py-4 dark:border-white/10 dark:bg-[#1B1B1B]">
      <LoaderCircle className="h-4 w-4 animate-spin text-black/60 dark:text-white/60" />
    </aside>
  );
}

import { Hash, LoaderCircle, Users } from "lucide-react";

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
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-black/10 bg-[#F8F8F8] dark:border-white/10 dark:bg-[#1B1B1B]">
      <div className="flex items-center gap-2 px-4 py-3 text-sm font-semibold text-black/70 dark:text-white/70">
        <Users className="h-4 w-4" /> Channels
      </div>
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
            <Hash className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{channel.name}</span>
          </button>
        ))}
      </nav>
      <p className="border-t border-black/10 px-4 py-2 text-xs text-black/40 dark:border-white/10 dark:text-white/40">
        {channels.length} channel{channels.length === 1 ? "" : "s"}
      </p>
    </aside>
  );
}

export function ChannelSidebarLoading() {
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-black/10 bg-[#F8F8F8] px-4 py-4 dark:border-white/10 dark:bg-[#1B1B1B]">
      <LoaderCircle className="h-4 w-4 animate-spin text-black/40 dark:text-white/40" />
    </aside>
  );
}

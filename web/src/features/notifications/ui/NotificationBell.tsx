/**
 * Bell with unread badge + dropdown feed. Clicking an item routes you to the
 * channel (mentions) or the work board (task assignments).
 */

import { useEffect, useState } from "react";
import { Bell, Bot, MessageSquare, Users } from "lucide-react";

import { useNotifications, type NotificationItem } from "../use-notifications";

const KIND_ICON = {
  mention: MessageSquare,
  task: Bot,
  member: Users,
} as const;

export function NotificationBell({
  onOpenChannel,
  onOpenWork,
}: {
  onOpenChannel: (channelId: string) => void;
  onOpenWork: () => void;
}) {
  const { items, unread, markRead } = useNotifications();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (
        !(e.target as HTMLElement).closest("[data-testid='notifications-bell']")
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const openPanel = () => {
    if (!open) markRead();
    setOpen((v) => !v);
  };

  const route = (item: NotificationItem) => {
    setOpen(false);
    markRead();
    if (item.kind === "mention" && item.channelId) {
      onOpenChannel(item.channelId);
    } else if (item.kind === "task") {
      onOpenWork();
    }
  };

  return (
    <div data-testid="notifications-bell" className="relative px-3 pt-2">
      <button
        type="button"
        onClick={openPanel}
        className="relative flex w-full items-center gap-2 rounded-md border border-black/10 bg-white px-2 py-1.5 text-sm dark:border-white/10 dark:bg-white/5"
        aria-label="Notifications"
      >
        <Bell className="h-3.5 w-3.5 shrink-0 text-black/40 dark:text-white/40" />
        <span className="min-w-0 flex-1 truncate text-left text-sm text-black/70 dark:text-white/70">
          Notifications
        </span>
        {unread > 0 ? (
          <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-black px-1 text-[10px] font-semibold text-white dark:bg-white dark:text-black">
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute left-3 right-3 top-full z-40 mt-1 max-h-80 overflow-y-auto rounded-xl border border-black/10 bg-background p-2 shadow-xl dark:border-white/10">
          {items.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-black/45 dark:text-white/45">
              Nothing new.
            </p>
          ) : (
            items.slice(0, 20).map((item) => {
              const Icon = KIND_ICON[item.kind];
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => route(item)}
                  className="flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left hover:bg-black/5 dark:hover:bg-white/10"
                >
                  <span className="mt-0.5 shrink-0">
                    <Icon className="h-3.5 w-3.5 text-black/45 dark:text-white/45" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-black dark:text-white">
                      {item.title}
                    </span>
                    <span className="block truncate text-[11px] text-black/50 dark:text-white/50">
                      {item.preview}
                    </span>
                    <span className="block text-[10px] text-black/35 dark:text-white/35">
                      {new Date(item.at).toLocaleString()}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
/**
 * Bell with unread badge + dropdown feed. Clicking an item routes you to the
 * channel (mentions) or the work board (task assignments).
 */

import { Suspense, lazy, useEffect, useState } from "react";
import { Bell, Bot, ListChecks, MessageSquare, Users } from "lucide-react";

import { ViewLoadingFallback } from "@/shared/ui/ViewLoadingFallback";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog";
import { useNotifications, type NotificationItem } from "../use-notifications";
import { ApprovalsPanel } from "./ApprovalsPanel";

// The run list loads with the dialog; the dropdown itself stays light.
const WorkflowRunsPanel = lazy(() =>
  import("@/features/workflows/ui/WorkflowRunsPanel").then((m) => ({
    default: m.WorkflowRunsPanel,
  })),
);

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
  const [runsOpen, setRunsOpen] = useState(false);

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
        className="relative flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        aria-label="Notifications"
      >
        <Bell className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left text-sm">
          Notifications
        </span>
        {unread > 0 ? (
          <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-2xs font-semibold text-primary-foreground">
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute left-3 right-3 top-full z-40 mt-1 max-h-80 overflow-y-auto rounded-xl border border-black/10 bg-background p-2 shadow-xl dark:border-white/10">
          <ApprovalsPanel />
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setRunsOpen(true);
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            data-testid="open-workflow-runs"
          >
            <ListChecks className="h-3.5 w-3.5 shrink-0" />
            <span className="flex-1 truncate text-left text-sm">
              Workflow runs
            </span>
          </button>
          {items.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-black/60 dark:text-white/60">
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
                    <Icon className="h-3.5 w-3.5 text-black/60 dark:text-white/60" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-black dark:text-white">
                      {item.title}
                    </span>
                    <span className="block truncate text-2xs text-black/60 dark:text-white/60">
                      {item.preview}
                    </span>
                    <span className="block text-2xs text-black/60 dark:text-white/60">
                      {new Date(item.at).toLocaleString()}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      ) : null}
      <AlertDialog
        open={runsOpen}
        onOpenChange={(next) => {
          if (!next) setRunsOpen(false);
        }}
      >
        <AlertDialogContent
          className="max-h-[80vh] overflow-y-auto"
          data-testid="workflow-runs-dialog"
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Workflow runs</AlertDialogTitle>
            <AlertDialogDescription>
              Recent runs, what each step did, and anything waiting for your
              approval.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Suspense fallback={<ViewLoadingFallback label="Loading runs…" />}>
            <WorkflowRunsPanel />
          </Suspense>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setRunsOpen(false)} type="button">
              Close
            </AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

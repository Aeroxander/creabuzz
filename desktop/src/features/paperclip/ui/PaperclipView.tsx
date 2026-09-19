import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import {
  closePaperclipWindow,
  fetchPaperclipStatus,
  openPaperclipWindow,
  setPaperclipWindowBounds,
  startPaperclip,
  stopPaperclip,
} from "@/features/paperclip/lib/paperclipBackend";
import { isEmbeddablePaperclipUrl } from "@/features/paperclip/lib/paperclipStatus";
import { useCommunities } from "@/features/communities/useCommunities";
import { Button } from "@/shared/ui/button";
import { BuzzLoadingState } from "@/shared/ui/BuzzLoadingState";

/**
 * The placeholder's rectangle, in CSS pixels relative to the content area.
 *
 * Module level on purpose: an effect that closed over a per-render function would
 * have to re-subscribe on every render to satisfy the dependency rule.
 */
function boundsOf(element: HTMLElement | null) {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

export function PaperclipView() {
  const queryClient = useQueryClient();
  const { activeCommunity } = useCommunities();
  const communityId = activeCommunity?.id ?? null;

  React.useEffect(() => {
    if (!communityId) return;
    return () => {
      queryClient.removeQueries({ queryKey: ["paperclip", "status"] });
    };
  }, [communityId, queryClient]);

  const statusQuery = useQuery({
    queryKey: ["paperclip", "status"],
    queryFn: fetchPaperclipStatus,
    staleTime: 10_000,
  });

  const startMutation = useMutation({
    mutationFn: startPaperclip,
    onSuccess: (next) => {
      queryClient.setQueryData(["paperclip", "status"], next);
      void queryClient.invalidateQueries({ queryKey: ["paperclip", "status"] });
    },
  });

  const stopMutation = useMutation({
    mutationFn: stopPaperclip,
    onSuccess: (next) => {
      queryClient.setQueryData(["paperclip", "status"], next);
      void queryClient.invalidateQueries({ queryKey: ["paperclip", "status"] });
    },
  });

  // The Paperclip webview is docked over this element, so a placeholder element
  // is what keeps the two in step. It is a real webview, not a frame: an iframe
  // would be refused by the app's CSP (`frame-src` falls back to `default-src
  // 'self'`) and could not reach the NIP-07 signer anyway.
  const placeholderRef = React.useRef<HTMLDivElement | null>(null);

  // Whether THIS view instance opened the docked window. A detached window the
  // user opened via "Open in a window" is theirs: the view must neither move
  // it nor close it on unmount.
  const ownsDockedWindowRef = React.useRef(false);

  const openMutation = useMutation({
    mutationFn: async (input: { url: string; docked: boolean }) => {
      await openPaperclipWindow(input.url, {
        docked: input.docked,
        bounds: boundsOf(placeholderRef.current) ?? undefined,
      });
      ownsDockedWindowRef.current = input.docked;
    },
  });

  // Keep the docked window on its placeholder when the layout moves under it.
  // Only a window this view docked follows the placeholder; repositioning a
  // detached window the user placed themselves would fight the user.
  React.useEffect(() => {
    const element = placeholderRef.current;
    if (!element) return;
    const follow = () => {
      if (!ownsDockedWindowRef.current) return;
      const bounds = boundsOf(placeholderRef.current);
      if (bounds) void setPaperclipWindowBounds(bounds);
    };
    const observer = new ResizeObserver(follow);
    observer.observe(element);
    window.addEventListener("resize", follow);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", follow);
    };
  }, []);

  // Leaving the tab closes the docked window: it covers the content area, so
  // leaving it open would float over whatever the user opened next. A detached
  // window stays open until the user closes it themselves.
  React.useEffect(() => {
    return () => {
      if (ownsDockedWindowRef.current) {
        void closePaperclipWindow();
      }
    };
  }, []);

  const status = statusQuery.data;
  const statusError =
    statusQuery.error ?? startMutation.error ?? stopMutation.error;
  const running =
    status?.state === "running" && isEmbeddablePaperclipUrl(status.url)
      ? status.url
      : null;
  const starting = startMutation.isPending;
  const stopping = stopMutation.isPending;
  const openError =
    openMutation.error instanceof Error ? openMutation.error.message : null;

  if (statusQuery.isPending) {
    return <BuzzLoadingState fill label="Checking Paperclip status" />;
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {running ? (
        <div
          key={communityId ?? "none"}
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
        >
          <p className="text-sm text-muted-foreground">
            Paperclip is running at{" "}
            <span className="font-mono text-xs">{running}</span>.
          </p>
          <p className="text-xs text-muted-foreground">
            It opens in its own window and signs you in with your Buzz identity.
          </p>
          <div
            ref={placeholderRef}
            data-testid="paperclip-placeholder"
            className="w-full max-w-3xl flex-1 rounded-lg border border-dashed border-black/10 dark:border-white/10"
          />
          <div className="flex items-center gap-2">
            <Button
              data-testid="paperclip-open"
              onClick={() =>
                openMutation.mutate({ url: running, docked: true })
              }
              disabled={openMutation.isPending || stopping}
              type="button"
            >
              Open Paperclip
            </Button>
            <Button
              data-testid="paperclip-open-window"
              variant="outline"
              onClick={() =>
                openMutation.mutate({ url: running, docked: false })
              }
              disabled={openMutation.isPending || stopping}
              type="button"
            >
              Open in a window
            </Button>
            <Button
              data-testid="paperclip-stop"
              variant="outline"
              onClick={() => stopMutation.mutate()}
              disabled={starting || stopping}
              type="button"
            >
              Stop
            </Button>
          </div>
          {openError ? (
            <p className="text-xs text-destructive">{openError}</p>
          ) : null}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          {starting || stopping ? (
            <BuzzLoadingState
              fill
              label={starting ? "Starting Paperclip" : "Stopping Paperclip"}
            />
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                {status?.state === "error"
                  ? (status.error ?? "Paperclip failed to start.")
                  : statusError instanceof Error
                    ? statusError.message
                    : "Paperclip is not running."}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  data-testid="paperclip-start"
                  onClick={() => startMutation.mutate()}
                  disabled={starting || stopping}
                  type="button"
                >
                  {status?.state === "error" || statusError
                    ? "Retry"
                    : "Start Paperclip"}
                </Button>
                {status?.state !== "stopped" || statusError ? (
                  <Button
                    data-testid="paperclip-stop"
                    variant="outline"
                    onClick={() => stopMutation.mutate()}
                    disabled={starting || stopping}
                    type="button"
                  >
                    Stop
                  </Button>
                ) : null}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

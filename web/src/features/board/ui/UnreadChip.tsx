/**
 * The unread marker beside a board's name: a dot or a count, with the same words for a screen reader. Nothing when
 * there is nothing unread, or when the server keeps no read state (the caller then passes no marker).
 */

import type { unreadMarker } from "@/features/channels/lib/read-state";

type Marker = NonNullable<ReturnType<typeof unreadMarker>>;

export function UnreadChip({
  marker,
  testId,
}: {
  marker: Marker;
  testId: string;
}) {
  return (
    <span
      aria-hidden
      className={`shrink-0 rounded-full px-1.5 text-2xs font-semibold ${
        marker.attention
          ? "bg-destructive text-destructive-foreground"
          : "bg-black/10 text-black dark:bg-white/15 dark:text-white"
      }`}
      data-testid={testId}
    >
      {marker.label ?? "•"}
    </span>
  );
}

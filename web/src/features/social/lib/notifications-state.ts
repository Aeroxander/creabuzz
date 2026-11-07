/**
 * What the Notifications page and its nav badge show for a read's state. A failed read is a failure, never "Nothing
 * yet" or a quiet badge; a failed refresh keeps the last good list (Review-Proven Rule 1). Pure and alias-free:
 * `moderation-notices.test.mjs` drives it under `node --test`.
 */

export type NotificationsView = "loading" | "error" | "empty" | "list";

export function notificationsView(read: {
  data: readonly unknown[] | undefined;
  error: unknown;
  isLoading: boolean;
}): NotificationsView {
  if (read.data !== undefined) return read.data.length === 0 ? "empty" : "list";
  if (read.error) return "error";
  return read.isLoading ? "loading" : "empty";
}

/** The nav badge: how many are new since `seenAt`, or `failed` when nothing could be read to count. */
export function badgeState(
  items: readonly { at: number }[] | undefined,
  error: unknown,
  updates: readonly { at: number }[],
  seenAt: number | undefined,
): { unread: number; failed: boolean } {
  const failed = items === undefined && Boolean(error);
  if (seenAt === undefined) return { unread: 0, failed };
  return {
    unread:
      (items ?? []).filter((n) => n.at > seenAt).length +
      updates.filter((u) => u.at > seenAt).length,
    failed,
  };
}

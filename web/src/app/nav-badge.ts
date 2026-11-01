/**
 * What the main nav's Communities item says about the community's notifications. A poll that failed before anything
 * was read is marked as a failure, never shown as nothing new; a later failed poll keeps the count of what loaded
 * before. Pure and alias-free: `nav-badge.test.mjs` drives it under `node --test`.
 */

export function communityBadge(feed: {
  /** `useNotifications().view`: "error" is a failed poll with nothing read. */
  view: "loading" | "error" | "empty" | "list";
  unread: number;
}): { count: number; failed: boolean } {
  if (feed.view === "error") return { count: 0, failed: true };
  return { count: feed.unread, failed: false };
}

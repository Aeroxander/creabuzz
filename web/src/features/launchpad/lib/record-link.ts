/**
 * The address of a DAO's track record: `/launchpad/<launch>?author=…&tab=record`.
 *
 * Like a decision link it names the launch and nothing else. Whoever opens it works the DAO out from the launch record
 * the app already knows, so a link can never point the app at a contract of the link-writer's choosing.
 *
 * Alias-free; `record-link.test.mjs` drives it under `node --test`.
 */

/** The path and query of a launch's track record, without the site. */
export function recordPath(launchId: string, author?: string): string {
  const query = new URLSearchParams();
  if (author) query.set("author", author);
  query.set("tab", "record");
  return `/launchpad/${encodeURIComponent(launchId)}?${query.toString()}`;
}

/** The full address of a launch's track record on the site at `origin`. */
export function recordUrl(
  launchId: string,
  author: string | undefined,
  origin: string,
): string {
  return `${origin.replace(/\/+$/, "")}${recordPath(launchId, author)}`;
}

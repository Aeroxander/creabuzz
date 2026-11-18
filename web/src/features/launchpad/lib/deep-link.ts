/**
 * Desktop → web handoff: `<origin>/launchpad/<launchId>?author=<hex>&action=`
 * opens the matching money flow directly (the detail page consumes this).
 *
 * The `action` vocabulary is the closed set {bid, exit, claim, update}; anything else
 * is ignored for forward compatibility (a desktop that grows new actions must
 * never break the web page). `author` parsing lives in
 * `app/routes/launchpad.$launchId.tsx`.
 */

/**
 * `update` opens the founder's update dialog: the weekly calendar reminder links to it, so the reminder lands on the
 * form and not on a page to look around. For anyone but the founder, signed out or not, it opens nothing.
 */
export type LaunchAction = "bid" | "exit" | "claim" | "update";

const ACTIONS: readonly LaunchAction[] = ["bid", "exit", "claim", "update"];

/**
 * Parse the `action` search param. Unknown values (including non-strings)
 * resolve to null — the page loads without opening any flow.
 */
export function parseLaunchAction(value: unknown): LaunchAction | null {
  if (typeof value !== "string") return null;
  return (ACTIONS as readonly string[]).includes(value)
    ? (value as LaunchAction)
    : null;
}

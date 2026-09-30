/**
 * Deep links into the web app's launch detail — the canonical money plane.
 *
 * Platform split (adopted): the web app owns bidder money actions (bid /
 * exit / claim) with passkey-first custody; this desktop app is the agentic
 * ops cockpit with a READ-ONLY launchpad plus operator/founder actions. So
 * every bidder-money affordance on desktop is a deep link, never a send.
 *
 * URL shape (query style):
 *   `<relay-origin>/launchpad/<launchId>?author=<author-hex>&action=<action>`
 *
 * - Path: web's canonical detail route `/launchpad/$launchId`
 *   (`web/src/app/routes.ts` + `web/src/app/routes/launchpad.$launchId.tsx`).
 * - `author` is web's existing `validateSearch` param — it resolves the
 *   launch record by (author, id), so it is always included.
 * - `action` is the money-plane intent: `bid` | `exit` | `claim`. Query
 *   style was chosen over `#bid` fragments because web's route already
 *   parses query search params; a fragment would need new hash plumbing.
 *   Web's `validateSearch` ignores unknown params today, so these links
 *   work immediately and are the natural hook for web to auto-open the
 *   matching flow later.
 * - Base origin: the community's relay origin (the relay serves the web
 *   bundle via `BUZZ_WEB_DIR` + `BUZZ_WEB_SPA=full`), so the link stays
 *   inside the host-derived community boundary and "same account" applies.
 */

/** The bidder-money intent a desktop affordance hands off to the web app. */
export type LaunchWebAction = "bid" | "exit" | "claim";

/**
 * Build the web deep link for one launch. Returns null when the relay
 * origin is not resolved yet — callers should disable the affordance and
 * say so rather than opening a malformed URL.
 */
export function launchWebUrl(
  relayOrigin: string | null,
  launch: { id: string; author: string },
  action: LaunchWebAction,
): string | null {
  if (!relayOrigin) return null;
  let url: URL;
  try {
    url = new URL(`/launchpad/${encodeURIComponent(launch.id)}`, relayOrigin);
  } catch {
    return null;
  }
  url.searchParams.set("author", launch.author);
  url.searchParams.set("action", action);
  return url.toString();
}

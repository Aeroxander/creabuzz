/**
 * The example project a server names for itself: the address of one project's public page, so a first visitor has a
 * real record to read before deciding anything.
 *
 * The server's information document carries it as `example_project` (the scorecard address without its `/p/`), and
 * only on a community where a visitor who is not signed in can open that project. That matters on an invite-only
 * server, where such a visitor cannot read the member list or the list of projects, so the page could not find the
 * owner's project itself (`example-project.ts`). Anything that is not a well-formed address is treated as "none".
 *
 * Pure and alias-free: `server-example.test.mjs` drives it under `node --test`.
 */

import { parseScorecardSlug } from "../../launchpad/lib/share.ts";

/** The longest address taken from the server. */
const SLUG_CHARS = 200;

/** The example project's scorecard address (without `/p/`) from the server's information document, or null. */
export function serverExampleSlug(info: unknown): string | null {
  if (!info || typeof info !== "object" || Array.isArray(info)) return null;
  const named = (info as { example_project?: unknown }).example_project;
  if (typeof named !== "string" || named.length > SLUG_CHARS) return null;
  return parseScorecardSlug(named) ? named : null;
}

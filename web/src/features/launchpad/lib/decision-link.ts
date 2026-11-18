/**
 * The address of one decision, and finding it in text.
 *
 * A link names a launch and one of its decisions: `/launchpad/<launch>?author=…&tab=decisions&decision=<id>`.
 * It carries no DAO address on purpose. Whoever reads it works the DAO out from the launch record the app already
 * knows, so a link can never point the app at a contract of the link-writer's choosing.
 *
 * Alias-free; `decision-link.test.mjs` drives it under `node --test`.
 */

export interface DecisionLink {
  /** The launch's id (its `d` tag). */
  launchId: string;
  /** The launch author's public key, when the link names one (launch ids are only unique per author). */
  author?: string;
  /** The decision's id: `0x` + 64 lower-case hex. */
  decisionId: string;
}

const DECISION_ID = /^0x[0-9a-f]{64}$/;
const PUBKEY = /^[0-9a-f]{64}$/;
/** A web address in running text, up to the first space or closing bracket. */
const URL_IN_TEXT = /https?:\/\/[^\s<>"')\]]+/g;
const MAX_EMBEDS = 3;

/** Is this a well-formed decision id? */
export function isDecisionId(value: string): boolean {
  return DECISION_ID.test(value);
}

/** The path and query of a decision's link, without the site. */
export function decisionPath(link: DecisionLink): string {
  const query = new URLSearchParams();
  if (link.author) query.set("author", link.author);
  query.set("tab", "decisions");
  query.set("decision", link.decisionId);
  return `/launchpad/${encodeURIComponent(link.launchId)}?${query.toString()}`;
}

/** The full address of a decision on the site at `origin`. */
export function decisionUrl(link: DecisionLink, origin: string): string {
  return `${origin.replace(/\/+$/, "")}${decisionPath(link)}`;
}

/**
 * The decision an address names, or null for anything else: another site, another page, a missing or malformed
 * decision id. `origin` is this site's own (a link elsewhere is somebody else's page, not ours to embed).
 */
export function parseDecisionLink(
  href: string,
  origin: string,
): DecisionLink | null {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== new URL(origin).origin) return null;
  const match = /^\/launchpad\/([^/]+)\/?$/.exec(url.pathname);
  if (!match) return null;
  let launchId: string;
  try {
    launchId = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  const decisionId = (url.searchParams.get("decision") ?? "").toLowerCase();
  if (launchId === "" || !DECISION_ID.test(decisionId)) return null;
  const author = (url.searchParams.get("author") ?? "").toLowerCase();
  return {
    launchId,
    ...(PUBKEY.test(author) ? { author } : {}),
    decisionId,
  };
}

/** The decisions linked to in some text, each once, at most three (more is a wall of cards, not an embed). */
export function findDecisionLinks(
  text: string,
  origin: string,
): DecisionLink[] {
  const found: DecisionLink[] = [];
  const seen = new Set<string>();
  for (const raw of text.match(URL_IN_TEXT) ?? []) {
    // A sentence's closing punctuation is not part of the address.
    const link = parseDecisionLink(raw.replace(/[.,;:!?]+$/, ""), origin);
    if (!link) continue;
    const key = `${link.launchId}|${link.author ?? ""}|${link.decisionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(link);
    if (found.length === MAX_EMBEDS) break;
  }
  return found;
}

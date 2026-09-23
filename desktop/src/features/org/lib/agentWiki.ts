/**
 * Agent Wiki (kind:44002) read-side logic for the org surface.
 *
 * Pages are agent-authored markdown (d = "<space>/<slug>", content = front
 * matter + body). Kind 44002 is OUTSIDE the NIP-33 parameterized range, so
 * every revision is stored and the newest event per (pubkey, kind, d) wins
 * READ-SIDE LWW — there is no relay-side replacement. That means the grouping
 * here is the product contract, not a convenience: fold per-author heads
 * first, then resolve the winning head per page across authors.
 *
 * See docs/agent-wiki.md. Pure logic — the React shell lives in
 * ../ui/AgentWikiSection.tsx.
 */
import { KIND_AGENT_WIKI_PAGE } from "@/shared/constants/kinds";

/** Bounded read: the wiki fetch never pulls more than this many events. */
export const AGENT_WIKI_FETCH_LIMIT = 100;

/** The standup page the distillation loop rewrites each run. */
export const AGENT_WIKI_STANDUP_D = "default/standup";

export const AGENT_WIKI_EMPTY_HINT =
  "Run `buzz agwiki distill` to generate the first standup.";

export type AgentWikiEventLike = {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  tags: ReadonlyArray<readonly string[]>;
  content: string;
};

export type AgentWikiPage = {
  /** Full d tag, e.g. "default/standup" or "default/projects/research/index". */
  d: string;
  space: string;
  /** Slug after the space segment; may itself contain slashes (nested). */
  slug: string;
  /** Body markdown with the CLI front-matter block stripped. */
  content: string;
  updatedAt: number;
  /** Provenance `model` tag; null when the event carries none. */
  model: string | null;
  /** Provenance `cost_tokens` tag (decimal); null when absent/malformed. */
  costTokens: number | null;
  /** Provenance `sources` tag — source event ids, comma-separated. */
  sources: string[];
  eventId: string;
  authorPubkey: string;
};

/**
 * Split the d tag into space + slug. The relay envelope validation keeps
 * malformed d values from winning LWW, but the read side still defends:
 * a d without a "<space>/<slug>" shape yields null and the page is skipped.
 */
export function parseAgentWikiD(
  d: string,
): { space: string; slug: string } | null {
  const slash = d.indexOf("/");
  if (slash <= 0 || slash === d.length - 1) return null;
  return { space: d.slice(0, slash), slug: d.slice(slash + 1) };
}

/** First value of a single-value tag, or null. Tags are untrusted input. */
function singleTagValue(
  tags: ReadonlyArray<readonly string[]>,
  name: string,
): string | null {
  for (const tag of tags) {
    if (tag[0] === name && typeof tag[1] === "string" && tag[1].length > 0) {
      return tag[1];
    }
  }
  return null;
}

/**
 * Strip the deterministic CLI front-matter block (`---` … `---`) so the
 * renderer shows prose, not YAML. A missing or unterminated block returns
 * the content unchanged — markdown is data, and a page that does not carry
 * front matter is still a valid page.
 */
export function stripFrontMatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const newline = content.indexOf("\n");
  if (newline === -1) return content;
  const close = content.indexOf("\n---", newline);
  if (close === -1) return content;
  // Drop the blank line(s) between the closing fence and the body so the
  // renderer starts on the first prose line.
  const after = content.slice(close + 4).replace(/^\n+/, "");
  return after;
}

export function eventToAgentWikiPage(
  event: AgentWikiEventLike,
): AgentWikiPage | null {
  if (event.kind !== KIND_AGENT_WIKI_PAGE) return null;
  const dTag = event.tags.find((tag) => tag[0] === "d")?.[1];
  if (!dTag) return null;
  const parsed = parseAgentWikiD(dTag);
  if (!parsed) return null;
  const model = singleTagValue(event.tags, "model");
  const rawCost = singleTagValue(event.tags, "cost_tokens");
  const cost =
    rawCost !== null && /^\d+$/.test(rawCost) ? Number(rawCost) : null;
  const rawSources = singleTagValue(event.tags, "sources");
  const sources = rawSources
    ? rawSources
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0)
    : [];
  return {
    d: dTag,
    space: parsed.space,
    slug: parsed.slug,
    content: stripFrontMatter(event.content),
    updatedAt: event.created_at,
    model,
    costTokens: cost,
    sources,
    eventId: event.id,
    authorPubkey: event.pubkey,
  };
}

/**
 * Read-side LWW for kind:44002. Stage 1 folds revisions per
 * (pubkey, d) — the relay's stored-head contract. Stage 2 picks, per d, the
 * newest head across authors for display. Newest-first in the result.
 */
export function newestAgentWikiPages(
  events: ReadonlyArray<AgentWikiEventLike>,
): AgentWikiPage[] {
  const perAuthor = new Map<string, AgentWikiPage>();
  for (const event of events) {
    const page = eventToAgentWikiPage(event);
    if (!page) continue;
    const key = `${page.authorPubkey.toLowerCase()}|${page.d}`;
    const current = perAuthor.get(key);
    if (
      !current ||
      page.updatedAt > current.updatedAt ||
      (page.updatedAt === current.updatedAt && page.eventId > current.eventId)
    ) {
      perAuthor.set(key, page);
    }
  }
  const winners = new Map<string, AgentWikiPage>();
  for (const page of perAuthor.values()) {
    const current = winners.get(page.d);
    if (
      !current ||
      page.updatedAt > current.updatedAt ||
      (page.updatedAt === current.updatedAt && page.eventId > current.eventId)
    ) {
      winners.set(page.d, page);
    }
  }
  return [...winners.values()].sort(
    (a, b) => b.updatedAt - a.updatedAt || a.d.localeCompare(b.d),
  );
}

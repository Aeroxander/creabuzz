/**
 * The Knowledge area's pure model layer.
 *
 * The wiki has two page kinds, unified under one "Knowledge" entry point:
 *
 * - **Team pages** — the human-authored wiki (`kind:44001`, `d` = slug). The
 *   product name for the 44001 kind is a "Team page"; the kind number is a
 *   protocol internal and never appears in user-facing copy.
 * - **Agent pages** — the agent-maintained wiki (`kind:44002`, `d` =
 *   `<space>/<slug>`, read-side LWW), published by the distill loop
 *   (`crates/buzz-cli/src/commands/agent_wiki.rs` → `crates/buzz-agwiki`).
 *   Each carries provenance: which agent produced it and how many source
 *   events it distilled — rendered as "Updated by agent X from N sources".
 *
 * This module is the single place that answers, from raw relay events:
 *
 * 1. what kind a page is and (for agent pages) its provenance;
 * 2. how a **correction suggestion** is recorded and read back — an agent page
 *    is read-only, so a reader who spots an error files a proposal instead;
 * 3. the **team-scope edit gate** — a page may name a team whose seat holders
 *    alone may edit it; everyone else reads and can only suggest a correction.
 *
 * ── Tag conventions (documented here, as the task requires) ─────────────────
 *
 * Both suggestion markers and team scope ride the wiki's `t` tag, each with a
 * distinct prefix so a reader can tell them apart:
 *
 * - `["t", "correction-for:<slug>"]` — this event is a correction suggestion
 *   for the page whose `d` is `<slug>`. The suggestion itself is a `kind:44001`
 *   proposal page (the simplest durable record the relay already stores) whose
 *   `d` is `correction-for-<slug>`, so it never collides with — or overwrites —
 *   the page it corrects. A `t` filter (`#t`) renders suggestions back; the
 *   per-author, parameterised-replaceable `d` means one live suggestion per
 *   author per page (a resubmission replaces the same author's earlier one).
 *
 * - `["t", "team:<team-node-id>"]` — this page is scoped to the org-chart team
 *   named by `<team-node-id>` (a NIP-ORG node `d`). Only that team's seat
 *   holders may edit the page; everyone else reads and may only suggest a
 *   correction. A page with no `team:` scope tag is edited exactly as today
 *   (the community member list decides who may edit).
 *
 * Alias-free on purpose: `knowledge.test.mjs` drives it under `node --test`.
 */

/** The team page kind (human wiki). Product name: "Team page". */
export const KIND_WIKI_PAGE = 44001;
/** The agent page kind (agent wiki). Product name: "Agent page". */
export const KIND_AGENT_WIKI_PAGE = 44002;

/** `t`-tag prefix marking a correction suggestion. */
export const SUGGESTION_TAG_PREFIX = "correction-for:";
/** `t`-tag prefix naming the team that owns a page's edit rights. */
export const SCOPE_TAG_PREFIX = "team:";

/** The subset of a Nostr event this module needs. */
export interface KnowledgeEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

// ── classification ─────────────────────────────────────────────────────────

/** Which product kind a Knowledge page is. */
export type PageKind = "team" | "agent";

/**
 * Provenance of an agent page: the agent that produced it and how many source
 * events it distilled. Both fields are extracted from the 44002 event's tags
 * (falling back to its front-matter content), never invented.
 */
export interface AgentProvenance {
  /** The producing agent (the distilling model, e.g. "glm-5.3-flash"). */
  agent: string | null;
  /** Number of distinct source event ids distilled into the page. */
  sourceCount: number;
}

/** A Knowledge page, classified. */
export interface KnowledgePage {
  kind: PageKind;
  /** The `d` tag — the page's identity. For agent pages it is `<space>/<slug>`. */
  slug: string;
  content: string;
  updatedAt: number;
  authorPubkey: string;
  /** Non-null only for agent pages. */
  provenance: AgentProvenance | null;
  /** The team-node id this page's edits are scoped to, or null (open editing). */
  scope: string | null;
}

function tagValue(event: KnowledgeEvent, name: string): string | null {
  for (const tag of event.tags) {
    if (tag[0] === name && typeof tag[1] === "string" && tag[1].length > 0) {
      return tag[1];
    }
  }
  return null;
}

/** First `t`-tag value carrying `prefix`; null when absent. */
function prefixedTag(event: KnowledgeEvent, prefix: string): string | null {
  for (const tag of event.tags) {
    if (tag[0] !== "t") continue;
    const value = typeof tag[1] === "string" ? tag[1] : "";
    if (value.startsWith(prefix) && value.length > prefix.length) {
      return value.slice(prefix.length);
    }
  }
  return null;
}

const HEX_64 = /^[0-9a-f]{64}$/;

/** The `sources` tag: comma-separated event ids, deduplicated and bounded. */
function sourceIds(raw: string | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const piece of raw.split(",")) {
    if (out.length >= 64) break;
    const id = piece.trim().toLowerCase();
    if (!HEX_64.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Minimal `model:` lookup in a front-matter block (the content fallback). */
function frontMatterModel(content: string): string | null {
  const lines = content.split("\n");
  if (lines.length === 0 || lines[0].trim() !== "---") return null;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "---") break;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    if (line.slice(0, colon).trim() !== "model") continue;
    const value = line.slice(colon + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

/**
 * Extract an agent page's provenance from its 44002 event. The agent name is
 * the `model` tag (falling back to the front-matter `model:` field); the source
 * count is the number of valid `sources` ids. A malformed value degrades to
 * "unknown" rather than a broken render.
 */
export function extractProvenance(event: KnowledgeEvent): AgentProvenance {
  const agent = tagValue(event, "model") ?? frontMatterModel(event.content);
  return {
    agent: agent && agent.length > 0 ? agent : null,
    sourceCount: sourceIds(tagValue(event, "sources")).length,
  };
}

/** The team node id a page scopes its edits to, from its `t: team:<id>` tag. */
export function pageScope(event: KnowledgeEvent): string | null {
  return prefixedTag(event, SCOPE_TAG_PREFIX);
}

/** True when this 44001 event is a correction suggestion, not a page. */
export function isSuggestionEvent(event: KnowledgeEvent): boolean {
  return (
    event.kind === KIND_WIKI_PAGE &&
    prefixedTag(event, SUGGESTION_TAG_PREFIX) !== null
  );
}

/**
 * Classify one raw event into a Knowledge page. Returns null for anything that
 * is not a Knowledge page — including correction suggestions, which are
 * records about a page rather than pages themselves.
 */
export function classifyEvent(event: KnowledgeEvent): KnowledgePage | null {
  if (isSuggestionEvent(event)) return null;
  const slug = tagValue(event, "d") ?? event.id;
  const scope = pageScope(event);
  if (event.kind === KIND_WIKI_PAGE) {
    return {
      kind: "team",
      slug,
      content: typeof event.content === "string" ? event.content : "",
      updatedAt: event.created_at,
      authorPubkey: event.pubkey,
      provenance: null,
      scope,
    };
  }
  if (event.kind === KIND_AGENT_WIKI_PAGE) {
    return {
      kind: "agent",
      slug,
      content: typeof event.content === "string" ? event.content : "",
      updatedAt: event.created_at,
      authorPubkey: event.pubkey,
      provenance: extractProvenance(event),
      scope,
    };
  }
  return null;
}

/** Classify a batch, splitting the pages into the two product groups. */
export function classifyEvents(events: readonly KnowledgeEvent[]): {
  team: KnowledgePage[];
  agent: KnowledgePage[];
} {
  const team: KnowledgePage[] = [];
  const agent: KnowledgePage[] = [];
  for (const event of events) {
    const page = classifyEvent(event);
    if (!page) continue;
    (page.kind === "team" ? team : agent).push(page);
  }
  const bySlug = (a: KnowledgePage, b: KnowledgePage) =>
    a.slug.localeCompare(b.slug);
  return { team: team.sort(bySlug), agent: agent.sort(bySlug) };
}

/**
 * The agent-page provenance header line. The canonical form is
 * "Updated by agent X from N sources"; a missing agent or a zero source count
 * drops that segment rather than rendering "unknown" or "from 0 sources".
 */
export function provenanceLine(provenance: AgentProvenance): string {
  const agent = provenance.agent ?? "an agent";
  if (provenance.sourceCount > 0) {
    return `Updated by agent ${agent} from ${provenance.sourceCount} source${
      provenance.sourceCount === 1 ? "" : "s"
    }`;
  }
  return `Updated by agent ${agent}`;
}

// ── correction suggestions ─────────────────────────────────────────────────

/** A recorded correction suggestion for a page. */
export interface Suggestion {
  authorPubkey: string;
  createdAt: number;
  /** The suggested correction, as plain text/markdown. */
  note: string;
}

/** The event template a caller signs and publishes to file a suggestion. */
export interface SuggestionPayload {
  kind: number;
  tags: string[][];
  content: string;
  created_at: number;
}

/**
 * Build the durable record for a correction suggestion against `slug`.
 *
 * It is a `kind:44001` proposal page whose `d` is `correction-for-<slug>` (so
 * it can never overwrite the page it corrects) and whose `t` tag marks it for
 * render-back. Parameterised-replaceable semantics make this one live
 * suggestion per author per page.
 */
export function buildSuggestion(opts: {
  slug: string;
  note: string;
  authorPubkey: string;
  now: number;
}): SuggestionPayload {
  return {
    kind: KIND_WIKI_PAGE,
    tags: [
      ["d", `correction-for-${opts.slug}`],
      ["t", `${SUGGESTION_TAG_PREFIX}${opts.slug}`],
    ],
    content: opts.note,
    created_at: opts.now,
  };
}

/**
 * Read correction suggestions for `slug` back out of raw events. Suggestions
 * fold per author (the newest wins, matching their replaceable `d`) and come
 * back newest-first.
 */
export function suggestionsFor(
  events: readonly KnowledgeEvent[],
  slug: string,
): Suggestion[] {
  const marker = `${SUGGESTION_TAG_PREFIX}${slug}`;
  const perAuthor = new Map<string, Suggestion>();
  for (const event of events) {
    if (event.kind !== KIND_WIKI_PAGE) continue;
    const target = prefixedTag(event, SUGGESTION_TAG_PREFIX);
    if (target !== slug) continue;
    // `marker` guards the exact `t` value; a bare prefix match is not enough.
    const tagged = event.tags.some(
      (tag) => tag[0] === "t" && tag[1] === marker,
    );
    if (!tagged) continue;
    const current = perAuthor.get(event.pubkey);
    if (!current || event.created_at > current.createdAt) {
      perAuthor.set(event.pubkey, {
        authorPubkey: event.pubkey,
        createdAt: event.created_at,
        note: typeof event.content === "string" ? event.content : "",
      });
    }
  }
  return [...perAuthor.values()].sort((a, b) => b.createdAt - a.createdAt);
}

// ── team-scope edit gate ───────────────────────────────────────────────────

/** Whether the viewer may edit, or may only propose a correction. */
export type EditVerdict = "edit" | "propose";

/**
 * Resolves a team node id to its seat-holder pubkeys, or null when the org
 * graph cannot resolve the scope (no node, unknown team). Callers wire this to
 * the live org chart; tests inject a fixed map.
 */
export type TeamSeatResolver = (teamId: string) => string[] | null;

/**
 * The team-scope edit gate.
 *
 * A page scoped to a team is editable only by that team's seat holders;
 * everyone else reads and may only suggest a correction. When the scope cannot
 * be resolved — or resolves to a team with no seat holders at all — the gate
 * falls back to today's open (member-list) editing rather than locking every
 * editor out: a guard that leaves no way to edit is the recovery-affordance
 * failure the repo rules forbid. An unscoped page is always open.
 */
export function canEditKnowledge(
  page: { scope: string | null },
  viewerPubkey: string | null,
  resolveTeamSeats: TeamSeatResolver,
): EditVerdict {
  const scope = page.scope;
  if (!scope) return "edit";
  const holders = resolveTeamSeats(scope);
  // Unresolvable, or a team with no seats: restricting here would lock every
  // editor out with no way back, so fall back to open editing.
  if (holders == null || holders.length === 0) return "edit";
  if (viewerPubkey != null && holders.includes(viewerPubkey)) return "edit";
  return "propose";
}

/**
 * Policy for the browser agent's wiki copilot ("@buzz-tab: <ask>" inside a
 * page). Alias-free so `wiki-copilot.test.mjs` can drive it under `node --test`.
 *
 * The copilot answers by publishing a new revision of the page. Two members'
 * tabs each run a copilot, and each revision is a kind:44001 event the OTHER
 * tab receives — so a reply that still begins with the trigger is a fresh
 * request to the other agent, whose reply is a fresh request to the first, and
 * the two answer each other's pages for as long as both tabs are open. Four
 * independent guards stop that, any one of which is enough on its own:
 *
 * 1. NEUTRALISE — the revision replaces the leading trigger with a quoted
 *    "asked:" line, so it is not a request to anyone.
 * 2. TAG — the revision carries `["agent-reply","1"]`; tagged events are never
 *    answered, and their author is remembered as an agent. (A person editing
 *    an agent's revision publishes a new, untagged revision of their own — a
 *    genuine new request.)
 * 3. KNOWN AGENTS — events authored by any known agent identity (this tab's,
 *    every identity that announced capabilities, every author seen tagging a
 *    reply) are never answered, which covers revisions published by an older
 *    client that neither neutralises nor tags.
 * 4. BUDGET — at most MAX_REPLIES_PER_PAGE_PER_HOUR replies per page per hour
 *    per tab, so a loop through some path nobody thought of is bounded and
 *    cheap, not endless and billed.
 */

export const AGENT_NAME = "buzz-tab";

/**
 * "@buzz-tab: <instruction>" at the very start of the content. The escape
 * matters: inside a template literal the two-character sequence backslash-s is
 * not an escape, so the unescaped form matched zero or more literal "s"
 * characters instead of whitespace between the name and the colon.
 */
export const TASK_PATTERN = new RegExp(`^@${AGENT_NAME}\\s*:`, "i");

/** Tag on every agent-authored wiki revision. */
export const AGENT_REPLY_TAG: readonly [string, string] = ["agent-reply", "1"];

export const MAX_REPLIES_PER_PAGE_PER_HOUR = 3;
const HOUR_MS = 60 * 60 * 1000;
const MAX_TRACKED_PAGES = 200;
const MAX_HANDLED_EVENTS = 500;

/** The instruction after the trigger, bounded. */
export function extractInstruction(content: string): string {
  return content.replace(TASK_PATTERN, "").trim().slice(0, 400);
}

/**
 * Replace the leading trigger with a quoted "asked:" line so the revision that
 * carries the answer is not itself a request.
 */
export function neutraliseTrigger(content: string): string {
  return content.replace(TASK_PATTERN, "> asked:");
}

/** The page content an answered request becomes. */
export function buildReplyContent(original: string, answer: string): string {
  return `${neutraliseTrigger(original)}\n\n---\n> ✍️ ${AGENT_NAME}\n\n${answer.slice(0, 2000)}`;
}

/** Tags of a copilot revision of page `slug`. */
export function replyTags(slug: string): string[][] {
  return [["d", slug], [...AGENT_REPLY_TAG]];
}

export interface WikiEventLike {
  id: string;
  pubkey: string;
  content: string;
  tags: readonly (readonly string[])[];
}

export type WikiSkipReason =
  | "no-trigger"
  | "no-slug"
  | "own"
  | "agent-author"
  | "agent-reply"
  | "already-handled"
  | "rate-limited";

export type WikiDecision =
  | { action: "reply"; slug: string; instruction: string }
  | { action: "skip"; reason: WikiSkipReason };

export interface WikiCopilotPolicy {
  /** Decide, and — for a reply — reserve one slot of the page's hourly budget. */
  decide(event: WikiEventLike): WikiDecision;
}

export function createWikiCopilotPolicy(options: {
  selfPubkey: () => string;
  /** Every pubkey known to be an agent (this tab's own is always excluded). */
  knownAgents: () => ReadonlySet<string>;
  nowMs?: () => number;
  maxRepliesPerHour?: number;
}): WikiCopilotPolicy {
  const now = options.nowMs ?? (() => Date.now());
  const maxReplies = options.maxRepliesPerHour ?? MAX_REPLIES_PER_PAGE_PER_HOUR;
  const repliesByPage = new Map<string, number[]>();
  const handled = new Set<string>();
  /** Authors seen publishing a tagged reply: agents, whatever the roster says. */
  const learnedAgents = new Set<string>();

  const remember = (id: string) => {
    handled.add(id);
    while (handled.size > MAX_HANDLED_EVENTS) {
      const oldest = handled.values().next().value;
      if (oldest === undefined) break;
      handled.delete(oldest);
    }
  };

  /** Reserve a reply slot for `slug`; false when the hour's budget is spent. */
  const reserve = (slug: string): boolean => {
    const nowMs = now();
    const recent = (repliesByPage.get(slug) ?? []).filter(
      (at) => nowMs - at < HOUR_MS,
    );
    repliesByPage.delete(slug);
    if (recent.length >= maxReplies) {
      repliesByPage.set(slug, recent);
      return false;
    }
    recent.push(nowMs);
    repliesByPage.set(slug, recent);
    while (repliesByPage.size > MAX_TRACKED_PAGES) {
      const oldest = repliesByPage.keys().next().value;
      if (oldest === undefined) break;
      repliesByPage.delete(oldest);
    }
    return true;
  };

  return {
    decide(event) {
      if (event.pubkey === options.selfPubkey()) {
        return { action: "skip", reason: "own" };
      }
      // Agent-authored revisions are never requests, whatever they say.
      if (event.tags.some((tag) => tag[0] === AGENT_REPLY_TAG[0])) {
        learnedAgents.add(event.pubkey);
        return { action: "skip", reason: "agent-reply" };
      }
      if (
        learnedAgents.has(event.pubkey) ||
        options.knownAgents().has(event.pubkey)
      ) {
        return { action: "skip", reason: "agent-author" };
      }
      if (!TASK_PATTERN.test(event.content)) {
        return { action: "skip", reason: "no-trigger" };
      }
      const slug = event.tags.find((tag) => tag[0] === "d")?.[1];
      if (!slug) return { action: "skip", reason: "no-slug" };
      // The relay replays events on every resubscribe.
      if (handled.has(event.id)) {
        return { action: "skip", reason: "already-handled" };
      }
      remember(event.id);
      if (!reserve(slug)) return { action: "skip", reason: "rate-limited" };
      return {
        action: "reply",
        slug,
        instruction: extractInstruction(event.content),
      };
    },
  };
}

/** A revision to publish: the page, its content, and its tags. */
export interface WikiRevisionDraft {
  slug: string;
  content: string;
  tags: string[][];
}

/**
 * Answer one wiki edit if the policy says to. The single production path from
 * a received page to a published copilot revision.
 */
export async function answerWikiEdit(
  policy: WikiCopilotPolicy,
  event: WikiEventLike,
  deps: {
    ask: (input: {
      slug: string;
      instruction: string;
      page: string;
    }) => Promise<string>;
    publish: (draft: WikiRevisionDraft) => Promise<void>;
  },
): Promise<WikiDecision> {
  const decision = policy.decide(event);
  if (decision.action !== "reply") return decision;
  const answer = await deps.ask({
    slug: decision.slug,
    instruction: decision.instruction,
    page: event.content.slice(0, 3000),
  });
  await deps.publish({
    slug: decision.slug,
    content: buildReplyContent(event.content, answer),
    tags: replyTags(decision.slug),
  });
  return decision;
}

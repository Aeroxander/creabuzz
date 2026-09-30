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

/**
 * The CLI invocation the self-service "Distill now" button drives. Kept as the
 * small secondary note for terminal-first users; the button is the primary
 * affordance.
 */
export const AGENT_WIKI_CLI_HINT = "buzz agwiki distill --publish";

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

// ── Distill run status mapping (pure; bound by agentWiki.test.mjs) ─────────
//
// The "Distill now" button runs the bundled `buzz` sidecar
// (`agwiki distill --space <space> --publish`, see ../agentWikiHooks.ts) and
// classifies the run from its actual CLI output. The matched strings are the
// CLI's real output, verified against crates/buzz-cli/src:
//
// - skip (exit 0, stdout):
//   "no new done tasks or contribution records since cursor <n>; nothing to
//   distill" — commands/agent_wiki.rs (run_distill_inner prints it and returns
//   before any LLM call).
// - publish confirmation (exit 0, stdout): the normalized write response
//   `{"accepted":true,"event_id":"…","message":"…"}` printed by
//   run_distill_inner via normalize_write_response (client.rs).
// - failure (non-zero exit, stderr): print_error's JSON envelope
//   `{"error":"…","message":"…","retryable":…}` (error.rs) — its `message`
//   field is the human-readable detail surfaced inline.
// - harness timeout: "… timed out after <n>s and was stopped" (the timeout
//   string format used by desktop/src-tauri/src/commands/org_classify.rs and
//   this feature's sidecar contract).
//
// Rule: an exit-0 run without a recognized publish confirmation is a FAILURE,
// never a silent success — nothing is guessed from partial output.

/** Wall-clock cap for one distill run (the sidecar owns the process kill). */
export const AGENT_WIKI_DISTILL_TIMEOUT_SECONDS = 180;

/** Char cap for the inline failure excerpt surfaced to the user. */
export const AGENT_WIKI_DISTILL_ERROR_EXCERPT_CHARS = 300;

/** Printed when a run fails with no output at all (mirrors the sidecar UX). */
const AGENT_WIKI_DISTILL_NO_OUTPUT_TEXT =
  "buzz agwiki distill failed with no output";

/** Attached when exit 0 came back without a publish confirmation. */
const AGENT_WIKI_DISTILL_UNCONFIRMED_TEXT =
  "distill exited without a publish confirmation";

/** Raw result of one `agwiki distill --publish` sidecar run. */
export type AgentWikiDistillRun = {
  /** Process exit code was 0. */
  ok: boolean;
  stdout: string;
  stderr: string;
};

/** Terminal outcome of one distill run — surfaced distinctly by the UI. */
export type AgentWikiDistillOutcome =
  | { status: "published"; eventId: string }
  | { status: "nothing-new" }
  | { status: "timeout" }
  | { status: "failed"; message: string };

// commands/agent_wiki.rs (run_distill_inner) prints exactly this stdout line
// when the cursor window holds nothing new; exit stays 0 and no LLM call runs.
const SKIP_LINE_PATTERN =
  /^no new done tasks or contribution records since cursor \d+; nothing to distill$/m;

// Harness timeout string format: "… timed out after <n>s and was stopped".
const TIMEOUT_PATTERN = /timed out after \d+s and was stopped/i;

function boundedExcerpt(
  text: string,
  max = AGENT_WIKI_DISTILL_ERROR_EXCERPT_CHARS,
): string {
  const trimmed = text.trim();
  const chars = [...trimmed];
  return chars.length <= max ? trimmed : `${chars.slice(0, max).join("")}…`;
}

/** Extract `message` from a print_error JSON envelope line (error.rs). */
function cliErrorMessage(text: string): string | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "message" in parsed
      ) {
        const message = (parsed as { message?: unknown }).message;
        if (typeof message === "string" && message.trim().length > 0) {
          return message.trim();
        }
      }
    } catch {
      // Not the error envelope line; keep scanning.
    }
  }
  return null;
}

/** The event id from the normalized write response line, or null. */
function publishedEventId(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object") {
        const record = parsed as { accepted?: unknown; event_id?: unknown };
        if (
          record.accepted === true &&
          typeof record.event_id === "string" &&
          record.event_id.length > 0
        ) {
          return record.event_id;
        }
      }
    } catch {
      // Not a JSON line; keep scanning.
    }
  }
  return null;
}

function distillFailureMessage(stderr: string, stdout: string): string {
  const detail = cliErrorMessage(stderr) ?? cliErrorMessage(stdout);
  if (detail) return boundedExcerpt(detail);
  const raw = boundedExcerpt(`${stderr}\n${stdout}`);
  return raw.length > 0 ? raw : AGENT_WIKI_DISTILL_NO_OUTPUT_TEXT;
}

/**
 * Classify a finished sidecar run into its terminal outcome. Pure — this is
 * the seam the unit tests bind; the mutation hook calls exactly this.
 */
export function classifyAgentWikiDistillRun(
  run: AgentWikiDistillRun,
): AgentWikiDistillOutcome {
  const combined = `${run.stderr}\n${run.stdout}`;
  if (TIMEOUT_PATTERN.test(combined)) return { status: "timeout" };
  if (!run.ok) {
    return {
      status: "failed",
      message: distillFailureMessage(run.stderr, run.stdout),
    };
  }
  if (SKIP_LINE_PATTERN.test(run.stdout)) return { status: "nothing-new" };
  const eventId = publishedEventId(run.stdout);
  if (eventId !== null) return { status: "published", eventId };
  // Exit 0 without a publish confirmation (e.g. a preview-only draft) is a
  // failure: never report a standup update the CLI did not confirm.
  return {
    status: "failed",
    message: boundedExcerpt(
      `${AGENT_WIKI_DISTILL_UNCONFIRMED_TEXT}\n${combined}`,
    ),
  };
}

/**
 * Classify a rejected sidecar invocation (env/spawn errors, harness timeout).
 * Timeout strings match the `… timed out after <n>s and was stopped` format;
 * everything else surfaces as a bounded inline failure — including the
 * missing-classifier-env errors, exactly as the classify mutation surfaces
 * them.
 */
export function classifyAgentWikiDistillError(
  message: string,
): AgentWikiDistillOutcome {
  if (TIMEOUT_PATTERN.test(message)) return { status: "timeout" };
  const excerpt = boundedExcerpt(message);
  return {
    status: "failed",
    message: excerpt.length > 0 ? excerpt : AGENT_WIKI_DISTILL_NO_OUTPUT_TEXT,
  };
}

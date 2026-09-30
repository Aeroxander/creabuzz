/**
 * Persona drafting loop (B1) — wiki decision blocks → 47004 `agent-draft`
 * proposal records (docs/persona-drafting-loop.md).
 *
 * Pure and deterministic; the desktop twin of `buzz-agwiki::draft` (the CLI
 * loop) and web's `lib/draft-proposal.ts`. The golden vectors in
 * `draft-proposal.test.mjs` pin the SAME canonical content strings as the
 * Rust and desktop tests, so the CLI loop and the UI journey can never
 * diverge silently.
 *
 * Honesty rules (the seams the goldens bind):
 * - D3 verbatim evidence: `evidence` must appear verbatim in the page body
 *   OUTSIDE decision blocks — the no-invented-facts seam.
 * - D4 strictly parse or drop: malformed block structure drops the block
 *   with a reason; a malformed `intent`/`calls` VALUE drops only that value
 *   (record-only), never guessed at. `signal` + `intent` is contradictory.
 * - D6 routing is inherited: `kind` is the routing map's own key
 *   (`plain` | `futarchy-budget` | `signal`), never defaulted.
 * - D7 dedupe by `["wiki", page, anchor]`; anchors count every decision
 *   block (including skipped ones), stable across runs on unchanged pages.
 * - D8 provenance is the source pointer: the `wiki` tag + verbatim quote.
 *
 * No imports on purpose (alias-free under `node --test`, like `page-index.ts`).
 */

export type ProposalRoute = "plain" | "futarchy-budget" | "signal";

export interface StrictIntent {
  op: 0 | 1;
  to: string;
  value: string;
  data: string;
  nonce: string;
}

export interface StrictCall {
  operation: "call" | "delegatecall";
  from: string;
  to: string;
  value: string;
  data: string;
}

export interface RawBlock {
  anchor: number;
  fields: [string, string][];
}

export interface SkippedBlock {
  anchor: number;
  reason: string;
}

export interface DraftFields {
  anchor: number;
  title: string;
  kind: ProposalRoute;
  evidence: string;
  intent?: StrictIntent;
  calls?: StrictCall[];
}

export interface DraftRow extends DraftFields {
  /** Canonical content JSON (fixed NIP-LP field order). */
  content: string;
}

export interface PageDrafts {
  drafts: DraftRow[];
  skipped: SkippedBlock[];
}

export interface DraftEventShape {
  kind: number;
  content: string;
  tags: string[][];
}

export const AGENT_DRAFT_STATE = "agent-draft";
export const KIND_LAUNCH_PROPOSAL = 47004;
export const KIND_DELETE = 5;
export const BLOCK_TITLE_MAX = 200;
export const BLOCK_EVIDENCE_MAX = 400;

// ── Line semantics (identical to Rust `str::lines`) ────────────────────────

function lines(body: string): string[] {
  const out = body.split("\n");
  return out.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function isOpenFence(line: string): boolean {
  const trimmed = line.replace(/^\s+/, "");
  const rest = trimmed.startsWith("```decision")
    ? trimmed.slice("```decision".length)
    : null;
  return rest !== null && rest.trim() === "";
}

function isCloseFence(line: string): boolean {
  return line.trim() === "```";
}

function parseFieldLine(line: string): [string, string] | null {
  const colon = line.indexOf(":");
  if (colon <= 0) return null;
  const key = line.slice(0, colon).trim();
  if (key.length === 0) return null;
  return [key, line.slice(colon + 1).trim()];
}

export function parseDecisionBlocks(body: string): {
  blocks: RawBlock[];
  skipped: SkippedBlock[];
} {
  const blocks: RawBlock[] = [];
  const skipped: SkippedBlock[] = [];
  let anchor = 0;
  let current: RawBlock | null = null;
  for (const line of lines(body)) {
    if (current) {
      if (isCloseFence(line)) {
        blocks.push(current);
        current = null;
      } else {
        const field = parseFieldLine(line);
        if (field && !current.fields.some(([k]) => k === field[0])) {
          current.fields.push(field);
        }
      }
    } else if (isOpenFence(line)) {
      anchor += 1;
      current = { anchor, fields: [] };
    }
  }
  if (current) {
    skipped.push({
      anchor: current.anchor,
      reason: "unterminated decision block (no closing fence)",
    });
  }
  return { blocks, skipped };
}

/** The prose surface D3 checks against (decision blocks removed). */
export function bodyWithoutDecisionBlocks(body: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of lines(body)) {
    if (inBlock) {
      if (isCloseFence(line)) inBlock = false;
      continue;
    }
    if (isOpenFence(line)) {
      inBlock = true;
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

// ── Strict value parsers (desktop's parseProposalIntent rules) ─────────────

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const DATA_RE = /^0x[0-9a-fA-F]*$/;
const DECIMAL_RE = /^[0-9]+$/;

function fieldOf(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key];
  return typeof value === "string" ? value : null;
}

export function parseStrictIntent(value: unknown): StrictIntent | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (raw.op !== 0 && raw.op !== 1) return null;
  const to = fieldOf(raw, "to");
  const valueField = fieldOf(raw, "value");
  const data = fieldOf(raw, "data");
  const nonce = fieldOf(raw, "nonce");
  if (!to || !valueField || !data || !nonce) return null;
  if (!ADDRESS_RE.test(to)) return null;
  if (!DECIMAL_RE.test(valueField)) return null;
  if (!DATA_RE.test(data) || (data.length - 2) % 2 !== 0) return null;
  if (!BYTES32_RE.test(nonce)) return null;
  return { op: raw.op, to, value: valueField, data, nonce };
}

export function parseStrictCalls(value: unknown): StrictCall[] | null {
  if (!Array.isArray(value)) return null;
  const out: StrictCall[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") return null;
    const e = entry as Record<string, unknown>;
    if (e.operation !== "call" && e.operation !== "delegatecall") return null;
    const from = fieldOf(e, "from");
    const to = fieldOf(e, "to");
    const valueField = fieldOf(e, "value");
    const data = fieldOf(e, "data");
    if (!from || !to || !valueField || !data) return null;
    out.push({ operation: e.operation, from, to, value: valueField, data });
  }
  return out.length > 0 ? out : null;
}

// ── Structural validation + composition ────────────────────────────────────

function fieldOfBlock(block: RawBlock, key: string): string | null {
  const found = block.fields.find(([k]) => k === key);
  return found ? found[1] : null;
}

function charLength(s: string): number {
  return [...s].length;
}

function validateBlock(
  block: RawBlock,
  prose: string,
): { fields: DraftFields } | { reason: string } {
  const title = fieldOfBlock(block, "title");
  if (!title) return { reason: "missing `title`" };
  if (charLength(title) > BLOCK_TITLE_MAX) {
    return { reason: `title exceeds ${BLOCK_TITLE_MAX} chars` };
  }
  const kind = fieldOfBlock(block, "kind");
  if (kind !== "plain" && kind !== "futarchy-budget" && kind !== "signal") {
    return {
      reason: `unknown \`kind\` ${JSON.stringify(kind)} (routing map keys only)`,
    };
  }
  const evidence = fieldOfBlock(block, "evidence");
  if (!evidence) return { reason: "missing `evidence`" };
  if (charLength(evidence) > BLOCK_EVIDENCE_MAX) {
    return { reason: `evidence exceeds ${BLOCK_EVIDENCE_MAX} chars` };
  }
  if (kind === "signal" && block.fields.some(([k]) => k === "intent")) {
    return { reason: "contradictory block: `signal` carries an `intent`" };
  }
  if (!prose.includes(evidence)) {
    return {
      reason:
        "non-verbatim `evidence` (must appear in the page body outside decision blocks)",
    };
  }
  const intentRaw = fieldOfBlock(block, "intent");
  const callsRaw = fieldOfBlock(block, "calls");
  const intent = intentRaw
    ? parseStrictIntent(JSON.parse(intentRaw) as unknown)
    : null;
  const calls = callsRaw
    ? parseStrictCalls(JSON.parse(callsRaw) as unknown)
    : null;
  return {
    fields: {
      anchor: block.anchor,
      title,
      kind,
      evidence,
      ...(intent ? { intent } : {}),
      ...(calls ? { calls } : {}),
    },
  };
}

/**
 * Canonical content JSON: NIP-LP schema field order (proposalId, kind, issue,
 * state, title, evidence, intent, calls) — the Rust composer serializes the
 * same order and the goldens pin the identical strings.
 */
export function composeDraftContent(
  fields: DraftFields,
  state: string = AGENT_DRAFT_STATE,
  proposalId: string | null = null,
): string {
  return JSON.stringify({
    proposalId,
    kind: fields.kind,
    issue: null,
    state,
    title: fields.title,
    evidence: fields.evidence,
    ...(fields.intent
      ? {
          intent: {
            op: fields.intent.op,
            to: fields.intent.to,
            value: fields.intent.value,
            data: fields.intent.data,
            nonce: fields.intent.nonce,
          },
        }
      : {}),
    ...(fields.calls
      ? {
          calls: fields.calls.map((c) => ({
            operation: c.operation,
            from: c.from,
            to: c.to,
            value: c.value,
            data: c.data,
          })),
        }
      : {}),
  });
}

/** Compose every honest draft from one page body (D1–D4, D8), document order. */
export function decisionDrafts(body: string): PageDrafts {
  const prose = bodyWithoutDecisionBlocks(body);
  const { blocks, skipped } = parseDecisionBlocks(body);
  const drafts: DraftRow[] = [];
  const allSkipped = [...skipped];
  for (const block of blocks) {
    const result = validateBlock(block, prose);
    if ("reason" in result) {
      allSkipped.push({ anchor: block.anchor, reason: result.reason });
    } else {
      drafts.push({
        ...result.fields,
        content: composeDraftContent(result.fields),
      });
    }
  }
  allSkipped.sort((a, b) => a.anchor - b.anchor);
  return { drafts, skipped: allSkipped };
}

// ── Event envelopes ────────────────────────────────────────────────────────

/** Strict `["wiki", page, anchor]` parse (the D7/D8 pointer); null = absent. */
export function parseWikiTag(
  tags: string[][] | undefined,
): { page: string; anchor: number } | null {
  for (const tag of tags ?? []) {
    if (tag[0] !== "wiki" || tag.length < 3) continue;
    if (!DECIMAL_RE.test(tag[2])) continue;
    const anchor = Number(tag[2]);
    if (!Number.isInteger(anchor) || anchor < 1) continue;
    return { page: tag[1], anchor };
  }
  return null;
}

/** The kind:47004 `agent-draft` event template (unsigned). */
export function composeDraftEvent(
  launchCoordinate: string,
  pageCoordinate: string,
  row: DraftRow,
): DraftEventShape {
  return {
    kind: KIND_LAUNCH_PROPOSAL,
    content: row.content,
    tags: [
      ["a", launchCoordinate],
      ["wiki", pageCoordinate, String(row.anchor)],
    ],
  };
}

/** The counter-sign's accepted record (D5): `open` + the onchain id. */
export function composeAcceptedRecord(
  launchCoordinate: string,
  pageCoordinate: string,
  fields: DraftFields,
  proposalId: string,
): DraftEventShape {
  return {
    kind: KIND_LAUNCH_PROPOSAL,
    content: composeDraftContent(fields, "open", proposalId),
    tags: [
      ["a", launchCoordinate],
      ["wiki", pageCoordinate, String(fields.anchor)],
    ],
  };
}

/** Reject (D5): a NIP-09 tombstone hiding the draft — the chain of hashes keeps the audit. */
export function composeRejectTombstone(draftEventId: string): DraftEventShape {
  return {
    kind: KIND_DELETE,
    content: "",
    tags: [["e", draftEventId]],
  };
}

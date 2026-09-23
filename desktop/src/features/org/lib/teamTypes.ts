/**
 * Team (SAT) kinds 44020–44022 read-side logic for the org surface.
 *
 * Kinds 44020 (strategy), 44021 (run) and 44022 (turn) sit OUTSIDE the
 * NIP-33 parameterized range, so the relay stores every revision and the
 * newest event per (pubkey, kind, d) wins READ-SIDE LWW — exactly like the
 * NIP-ORG kinds (see docs/agent-teams.md). The folding here is the product
 * contract, not a convenience: fold per-author heads first, then resolve the
 * winning head per id across authors.
 *
 * Turn `d` tags encode run membership: `d = "<run-id>/<phase>/<agentSlot>"`
 * with 1-based phase numbers, so turns group per run and per phase purely
 * from the event shape. Strategies additionally carry reflection lineage:
 * a revision is published with `d = "<original-id>-rev<N>"` and content
 * `parentStrategy = "<original-id>"`, forming a chain back to the root.
 *
 * Pure logic — the React shell lives in ../ui/OrgTeamsView.tsx.
 */
import {
  KIND_TEAM_RUN,
  KIND_TEAM_STRATEGY,
  KIND_TEAM_TURN,
} from "@/shared/constants/kinds";

/** Bounded reads: each team fetch never pulls more than this many events. */
export const TEAM_STRATEGY_FETCH_LIMIT = 100;
export const TEAM_RUN_FETCH_LIMIT = 100;
export const TEAM_TURN_FETCH_LIMIT = 200;

/** Strategy ids cap (relay envelope bound, mirrored for id parsing). */
export const TEAM_STRATEGY_ID_MAX = 64;

export type TeamEventLike = {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  tags: ReadonlyArray<readonly string[]>;
  content: string;
};

/** One kind:44020 strategy head (content + envelope provenance). */
export type TeamStrategy = {
  /** The `d` tag — strategy id, e.g. "sat-smoke-2" or "sat-smoke-2-rev1". */
  id: string;
  name: string;
  description: string;
  /** Roster slots (roles keys), ordered. */
  roster: string[];
  /** Phase count (the paper's K). */
  phases: number;
  finalWriter: string;
  /** Reflection lineage: `d` of the strategy this revision was reflected
   *  from; null on originals. */
  parentStrategy: string | null;
  /** `rev` parsed from the `-rev<N>` suffix; null for roots. */
  rev: number | null;
  /** Provenance `model` tag (rare on strategies; runs carry the model). */
  model: string | null;
  eventId: string;
  authorPubkey: string;
  updatedAt: number;
};

/** One kind:44022 turn (raw markdown + run/phase/slot addressing). */
export type TeamTurn = {
  /** Full d tag `<run-id>/<phase>/<agentSlot>`. */
  id: string;
  runId: string;
  /** 1-based phase number. */
  phase: number;
  agentSlot: string;
  /** Raw markdown of the turn (reasoning, digest, or certificate). */
  content: string;
  /** Per-turn token usage (embedded in the running text when known). */
  tokens: number;
  /** Org-bound runs only: the roster slot's occupant pubkey. */
  pubkey: string | null;
  eventId: string;
  authorPubkey: string;
  createdAt: number;
};

/** One transcript row embedded in a kind:44021 run head. */
export type RunTranscriptRow = {
  phase: number;
  agentSlot: string;
  content: string;
  tokens: number;
  pubkey: string | null;
};

/** One kind:44021 run head. */
export type TeamRun = {
  /** The `d` tag — run id (also the prefix of every 44022 d). */
  id: string;
  strategyId: string;
  problem: string;
  /** The final writer's certificate markdown. */
  finalAnswer: string;
  totalTokens: number;
  model: string;
  /** "complete" — failed runs publish nothing, so no other status exists. */
  status: string;
  /** Org-bound runs only. */
  orgNode: string | null;
  /** Org-bound runs only: roster slot → occupant pubkey. */
  seats: Record<string, string> | null;
  /** Slot → token share (org-bound runs only). */
  participantTokens: Record<string, number>;
  /** Transcript embedded in the head; prefer grouped 44022 turns when both
   *  are present (they are the per-turn record). */
  transcript: RunTranscriptRow[];
  eventId: string;
  authorPubkey: string;
  createdAt: number;
};

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

function parseObjectContent(content: string): Record<string, unknown> | null {
  if (!content) return null;
  try {
    const value: unknown = JSON.parse(content);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Malformed content — callers fall back to defensible defaults.
  }
  return null;
}

function objString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value ? value : fallback;
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (typeof val === "string" && key.length > 0) {
      out[key] = val;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Parse the `-rev<N>` suffix of a strategy id; null when absent. */
export function parseStrategyRev(id: string): number | null {
  const match = /-rev(\d+)$/.exec(id);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/**
 * Split a turn d tag into run id / phase / agent slot. The relay envelope
 * validation bounds the shape, but the read side still defends: a d without
 * the `<run-id>/<phase>/<slot>` form yields null and the turn is skipped.
 */
export function parseTurnD(
  d: string,
): { runId: string; phase: number; agentSlot: string } | null {
  const first = d.indexOf("/");
  if (first <= 0) return null;
  const second = d.indexOf("/", first + 1);
  if (second <= first + 1 || second >= d.length - 1) return null;
  const phase = Number(d.slice(first + 1, second));
  if (!Number.isInteger(phase) || phase < 1) return null;
  return {
    runId: d.slice(0, first),
    phase,
    agentSlot: d.slice(second + 1),
  };
}

export function eventToTeamStrategy(event: TeamEventLike): TeamStrategy | null {
  if (event.kind !== KIND_TEAM_STRATEGY) return null;
  const id = event.tags.find((tag) => tag[0] === "d")?.[1];
  if (!id || id.length > TEAM_STRATEGY_ID_MAX) return null;
  const content = parseObjectContent(event.content);
  if (!content) return null;
  // `roles` is an object keyed by roster slot (the CLI's fixed roster); the
  // slot ORDER is the CLI's canonical order (the BTreeMap sorts keys), so
  // display uses sorted keys like the relay record does.
  const rolesRaw = content.roles;
  if (!rolesRaw || typeof rolesRaw !== "object" || Array.isArray(rolesRaw)) {
    // Fail-soft: a strategy-shaped event with no parseable roster is not a
    // usable bank entry (the CLI validates strictly, but older or foreign
    // events may still be malformed — skip rather than render garbage).
    return null;
  }
  const roster: string[] = [];
  for (const [slot, prompt] of Object.entries(
    rolesRaw as Record<string, unknown>,
  )) {
    if (typeof prompt === "string" && prompt.length > 0) roster.push(slot);
  }
  if (roster.length === 0) return null;
  roster.sort();
  const steps = content.steps;
  const phaseCount = Array.isArray(steps) ? steps.length : 0;
  if (phaseCount === 0) return null;
  const parentRaw = objString(content.parentStrategy, "");
  const parentStrategy = parentRaw || null;
  return {
    id,
    name: objString(content.name, id),
    description: objString(content.description),
    roster,
    phases: phaseCount,
    finalWriter: objString(content.finalWriter, roster[0] ?? ""),
    parentStrategy,
    rev: parseStrategyRev(id),
    model: singleTagValue(event.tags, "model"),
    eventId: event.id,
    authorPubkey: event.pubkey,
    updatedAt: event.created_at,
  };
}

export function eventToTeamRun(event: TeamEventLike): TeamRun | null {
  if (event.kind !== KIND_TEAM_RUN) return null;
  const id = event.tags.find((tag) => tag[0] === "d")?.[1];
  if (!id) return null;
  const content = parseObjectContent(event.content);
  if (!content) return null;
  const transcriptRaw = content.transcript;
  const transcript: RunTranscriptRow[] = [];
  if (Array.isArray(transcriptRaw)) {
    for (const row of transcriptRaw) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const obj = row as Record<string, unknown>;
      transcript.push({
        phase: Number.isInteger(obj.phase) ? Number(obj.phase) : 0,
        agentSlot: objString(obj.agentSlot, "agent"),
        content: objString(obj.content),
        tokens: Number.isFinite(Number(obj.tokens)) ? Number(obj.tokens) : 0,
        pubkey:
          typeof obj.pubkey === "string" && obj.pubkey ? obj.pubkey : null,
      });
    }
  }
  const seatsRaw = stringRecord(content.seats);
  const participantRaw = content.participantTokens;
  const participantTokens: Record<string, number> = {};
  if (
    participantRaw &&
    typeof participantRaw === "object" &&
    !Array.isArray(participantRaw)
  ) {
    for (const [slot, val] of Object.entries(
      participantRaw as Record<string, unknown>,
    )) {
      if (Number.isFinite(Number(val))) participantTokens[slot] = Number(val);
    }
  }
  return {
    id,
    strategyId: objString(content.strategyId),
    problem: objString(content.problem),
    finalAnswer: objString(content.finalAnswer),
    totalTokens: Number.isFinite(Number(content.totalTokens))
      ? Number(content.totalTokens)
      : 0,
    model: objString(content.model),
    status: objString(content.status, "complete"),
    orgNode: objString(content.orgNode, "") || null,
    seats: seatsRaw,
    participantTokens,
    transcript,
    eventId: event.id,
    authorPubkey: event.pubkey,
    createdAt: event.created_at,
  };
}

export function eventToTeamTurn(event: TeamEventLike): TeamTurn | null {
  if (event.kind !== KIND_TEAM_TURN) return null;
  const id = event.tags.find((tag) => tag[0] === "d")?.[1];
  if (!id) return null;
  const parsed = parseTurnD(id);
  if (!parsed) return null;
  if (!event.content?.trim()) return null;
  const rawTokens = singleTagValue(event.tags, "cost_tokens");
  const tokens =
    rawTokens !== null && /^\d+$/.test(rawTokens) ? Number(rawTokens) : 0;
  return {
    id,
    runId: parsed.runId,
    phase: parsed.phase,
    agentSlot: parsed.agentSlot,
    content: event.content,
    tokens,
    pubkey: singleTagValue(event.tags, "p"),
    eventId: event.id,
    authorPubkey: event.pubkey,
    createdAt: event.created_at,
  };
}

/**
 * Fold kind:44020 events to one head per strategy id. Stage 1 folds
 * revisions per (pubkey, id) — the stored-head contract. Stage 2 picks,
 * per id, the newest head across authors. Newest-first in the result.
 */
export function newestTeamStrategies(
  events: ReadonlyArray<TeamEventLike>,
): TeamStrategy[] {
  const perAuthor = new Map<string, TeamStrategy>();
  for (const event of events) {
    const strategy = eventToTeamStrategy(event);
    if (!strategy) continue;
    const key = `${strategy.authorPubkey.toLowerCase()}|${strategy.id}`;
    const current = perAuthor.get(key);
    if (
      !current ||
      strategy.updatedAt > current.updatedAt ||
      (strategy.updatedAt === current.updatedAt &&
        strategy.eventId > current.eventId)
    ) {
      perAuthor.set(key, strategy);
    }
  }
  const winners = new Map<string, TeamStrategy>();
  for (const strategy of perAuthor.values()) {
    const current = winners.get(strategy.id);
    if (
      !current ||
      strategy.updatedAt > current.updatedAt ||
      (strategy.updatedAt === current.updatedAt &&
        strategy.eventId > current.eventId)
    ) {
      winners.set(strategy.id, strategy);
    }
  }
  return [...winners.values()].sort(
    (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
  );
}

/** Fold kind:44021 events to one head per run id (same two-stage LWW). */
export function newestTeamRuns(
  events: ReadonlyArray<TeamEventLike>,
): TeamRun[] {
  const perAuthor = new Map<string, TeamRun>();
  for (const event of events) {
    const run = eventToTeamRun(event);
    if (!run) continue;
    const key = `${run.authorPubkey.toLowerCase()}|${run.id}`;
    const current = perAuthor.get(key);
    if (
      !current ||
      run.createdAt > current.createdAt ||
      (run.createdAt === current.createdAt && run.eventId > current.eventId)
    ) {
      perAuthor.set(key, run);
    }
  }
  const winners = new Map<string, TeamRun>();
  for (const run of perAuthor.values()) {
    const current = winners.get(run.id);
    if (
      !current ||
      run.createdAt > current.createdAt ||
      (run.createdAt === current.createdAt && run.eventId > current.eventId)
    ) {
      winners.set(run.id, run);
    }
  }
  return [...winners.values()].sort(
    (a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id),
  );
}

/** Sort turns into per-run execution order: phase, then age, then id. */
export function sortTurnsForRun(turns: TeamTurn[]): TeamTurn[] {
  return [...turns].sort(
    (a, b) =>
      a.phase - b.phase ||
      a.createdAt - b.createdAt ||
      a.id.localeCompare(b.id),
  );
}

/**
 * Group 44022 turns per run id (from the d-tag address), each list sorted in
 * execution order. Runs without turns get no entry — callers fall back to
 * the run head's embedded transcript.
 */
export function groupTurnsByRun(
  turns: ReadonlyArray<TeamTurn>,
): Map<string, TeamTurn[]> {
  const grouped = new Map<string, TeamTurn[]>();
  for (const turn of turns) {
    const list = grouped.get(turn.runId);
    if (list) {
      list.push(turn);
    } else {
      grouped.set(turn.runId, [turn]);
    }
  }
  for (const [runId, list] of grouped) {
    grouped.set(runId, sortTurnsForRun(list));
  }
  return grouped;
}

/** Group one run's turns (or embedded rows) into phase buckets. */
export function groupTurnsByPhase(
  turns: ReadonlyArray<TeamTurn | RunTranscriptRow>,
): Map<number, Array<TeamTurn | RunTranscriptRow>> {
  const phases = new Map<number, Array<TeamTurn | RunTranscriptRow>>();
  for (const turn of turns) {
    const list = phases.get(turn.phase);
    if (list) {
      list.push(turn);
    } else {
      phases.set(turn.phase, [turn]);
    }
  }
  return phases;
}

/** Direct revisions of a strategy id, from a folded bank list. */
export function strategyRevisions(
  strategies: ReadonlyArray<TeamStrategy>,
  id: string,
): TeamStrategy[] {
  return strategies
    .filter((strategy) => strategy.parentStrategy === id)
    .sort((a, b) => (a.rev ?? 0) - (b.rev ?? 0));
}

/** `rev1 of sat-smoke-2` lineage label for a revision strategy. */
export function lineageLabel(strategy: TeamStrategy): string | null {
  if (!strategy.parentStrategy) return null;
  const rev = strategy.rev ?? "";
  return `rev${rev} of ${strategy.parentStrategy}`;
}

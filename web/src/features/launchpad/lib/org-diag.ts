/**
 * The differentiated instrument (OA.md Phase 4 / OAv2 §6) — the web twin of
 * `buzz-core::org_diag` and desktop's `lib/orgDiag.ts`.
 *
 * Pure and deterministic over the normalized event graph; identical integer
 * basis-point math (no floats in any reported number), identical reading
 * strings. The goldens in `org-diag.test.mjs` pin the SAME numbers as the
 * Rust tests, so the CLI (`buzz diag`) and the UI cards can never diverge
 * silently.
 *
 * Named to source: Pentland's time signal (timing-only — safe even when
 * identities are synonymous), Tomasello's three layers (institutionalization
 * weighted — the CooperBench null result on volume), the five WEF
 * multi-agent failure modes (OAv2 §4.9's early-warning surface), Cursor's
 * thrash-vs-work scoreboard, AI-Village-shaped drift probes (a moved
 * distribution; "bad" is never inferred), and supervision saturation with
 * the governor-agents concentration risk.
 *
 * Honesty rules: insufficient data yields `null`/omitted — never a zero that
 * reads as measured; raw counts are primary and every rate accompanies them;
 * readings are patterns, never verdicts.
 */

export const HANDOFF_LAG_S = 60;
export const BURSTY_FLAG_BP = 2000;
export const MIN_EVENTS = 20;
export const MIN_DRIFT_EVENTS = 8;
export const DRIFT_FLAG_BP = 3000;
export const SATURATION_FLAG_BP = 2000;

/** The kinds the instrument reasons over (the coordination plane). */
export const DIAG_KINDS = [
  47004, 47005, 37013, 37011, 46010, 44001, 44002, 5, 44011, 40002,
] as const;

export type DiagClass =
  | "message"
  | "proposal"
  | "vote"
  | "execute"
  | "contribution"
  | "grant"
  | "revoke"
  | "approval"
  | "revision"
  | "tombstone"
  | "task-done"
  | "receipt"
  | "other";

export const DIAG_CLASSES: DiagClass[] = [
  "message",
  "proposal",
  "vote",
  "execute",
  "contribution",
  "grant",
  "revoke",
  "approval",
  "revision",
  "tombstone",
  "task-done",
  "receipt",
  "other",
];

export interface DiagEvent {
  id: string;
  actor: string;
  at: number;
  class: DiagClass;
  coordinate?: string;
}

/** Map a house event kind to its action class (unknown → "other"). */
export function classOfKind(kind: number, table?: string): DiagClass {
  switch (kind) {
    case 9:
    case 40002:
    case 45001:
    case 45003:
      return "message";
    case 47004:
      return "proposal";
    case 47005:
      return table === "vote"
        ? "vote"
        : table === "execute"
          ? "execute"
          : "receipt";
    case 37013:
      return "contribution";
    case 37011:
      return table === "revoke" ? "revoke" : "grant";
    case 46010:
      return "approval";
    case 44001:
    case 44002:
      return "revision";
    case 5:
      return "tombstone";
    case 44011:
      return "task-done";
    default:
      return "other";
  }
}

function tagValue(tags: string[][] | undefined, name: string): string | null {
  for (const tag of tags ?? []) {
    if (tag[0] === name && typeof tag[1] === "string") return tag[1];
  }
  return null;
}

/**
 * Strict wire → DiagEvent parse: rows missing id/pubkey/created_at/kind are
 * dropped, never guessed at (the CLI reports the drop count).
 */
export function diagEventFromNostr(event: {
  id?: unknown;
  pubkey?: unknown;
  created_at?: unknown;
  kind?: unknown;
  tags?: unknown;
}): DiagEvent | null {
  if (
    typeof event.id !== "string" ||
    typeof event.pubkey !== "string" ||
    typeof event.created_at !== "number" ||
    typeof event.kind !== "number"
  ) {
    return null;
  }
  const tags = Array.isArray(event.tags)
    ? (event.tags as string[][])
    : undefined;
  const coordinate = tagValue(tags, "d");
  return {
    id: event.id,
    actor: event.pubkey,
    at: event.created_at,
    class: classOfKind(event.kind, tagValue(tags, "kind") ?? undefined),
    ...(coordinate ? { coordinate } : {}),
  };
}

// ── Deterministic integer statistics ───────────────────────────────────────

function meanInt(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return Math.trunc(sum / values.length);
}

function isqrt(n: number): number {
  if (n <= 0) return 0;
  let x = n;
  let y = Math.trunc((x + 1) / 2);
  while (y < x) {
    x = y;
    y = Math.trunc((x + Math.trunc(n / x)) / 2);
  }
  return x;
}

function stdInt(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = meanInt(values);
  let acc = 0;
  for (const v of values) {
    const d = v - mean;
    acc += d * d;
  }
  return isqrt(Math.trunc(acc / values.length));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.trunc(sorted.length / 2)];
}

function rateBp(part: number, whole: number): number {
  if (whole === 0) return 0;
  return Math.trunc((part * 10000) / whole);
}

function sortedEvents(events: DiagEvent[]): DiagEvent[] {
  return [...events].sort((a, b) =>
    a.at !== b.at ? a.at - b.at : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

// ── Instrument 1: the time signal (Pentland) ───────────────────────────────

export interface TimeSignal {
  events: number;
  burstinessBp: number;
  bursty: boolean;
  handoffRateBp: number;
  handoffMedianLagS: number;
  reading: string;
}

export function timeSignal(events: DiagEvent[]): TimeSignal | null {
  if (events.length < MIN_EVENTS) return null;
  const sorted = sortedEvents(events);
  const intervals: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    intervals.push(Math.max(0, sorted[i].at - sorted[i - 1].at));
  }
  if (intervals.length === 0) return null;
  const mean = meanInt(intervals);
  const std = stdInt(intervals);
  const burstinessBp =
    mean + std === 0
      ? 0
      : Math.max(
          -10000,
          Math.min(10000, Math.trunc(((std - mean) * 10000) / (std + mean))),
        );
  const bursty = burstinessBp >= BURSTY_FLAG_BP;
  let handoffs = 0;
  const lags: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    const lag = Math.max(0, b.at - a.at);
    if (a.actor !== b.actor && lag <= HANDOFF_LAG_S) {
      handoffs += 1;
      lags.push(lag);
    }
  }
  const handoffRateBp = rateBp(handoffs, events.length);
  const reading =
    bursty && handoffRateBp >= 1000
      ? "coordination-consistent timing: bursty stream with cross-actor handoffs — a pattern in the timestamps, not proof of coordination"
      : bursty
        ? "bursty timing without cross-actor handoffs — synchronized load or deadlines also produce this"
        : "no timing coordination pattern detectable in this window";
  return {
    events: events.length,
    burstinessBp,
    bursty,
    handoffRateBp,
    handoffMedianLagS: median(lags),
    reading,
  };
}

// ── Instrument 2: Tomasello's three layers ─────────────────────────────────

export interface Layer {
  events: number;
  shareBp: number;
}

export interface Tomasello {
  communicate: Layer;
  buildTrust: Layer;
  institutionalize: Layer;
  reading: string;
}

export function tomasello(events: DiagEvent[]): Tomasello | null {
  if (events.length < MIN_EVENTS) return null;
  const count = (c: DiagClass) => events.filter((e) => e.class === c).length;
  const communicateN = count("message");
  const trustN = count("contribution") + count("grant") + count("revoke");
  const instN =
    count("proposal") + count("vote") + count("execute") + count("approval");
  const total = events.length;
  const layer = (n: number): Layer => ({
    events: n,
    shareBp: rateBp(n, total),
  });
  const reading =
    instN === 0
      ? "talk without decisions: no standing rules or executed decisions in this window — a busy channel is not the same as a team that decides"
      : instN * 2 < communicateN
        ? "institutions exist but communication dominates — measure what binds future action, not what is said"
        : "institutionalization present: proposals/votes/executions and approval gates bind future action";
  return {
    communicate: layer(communicateN),
    buildTrust: layer(trustN),
    institutionalize: layer(instN),
    reading,
  };
}

// ── Instrument 3: the WEF five failure modes ───────────────────────────────

export interface WefMode {
  mode: string;
  signalEvents: number;
  status: "calm" | "watch" | "flag";
  note: string;
}

export function wefModes(events: DiagEvent[]): WefMode[] {
  const count = (c: DiagClass) => events.filter((e) => e.class === c).length;
  const approvals = count("approval");
  const revokes = count("revoke");
  const tombstones = count("tombstone");
  const revisions = count("revision");
  const total = Math.max(1, events.length);
  const sorted = sortedEvents(events);
  let cascadeEvents = 0;
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    if (e.class !== "revoke" && e.class !== "tombstone") continue;
    let follow = 0;
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].at - e.at > 30) break;
      follow += 1;
    }
    if (follow >= 3) cascadeEvents += 1;
  }
  const status = (bp: number): WefMode["status"] =>
    bp >= 2000 ? "flag" : bp >= 500 ? "watch" : "calm";
  return [
    {
      mode: "orchestration-drift",
      signalEvents: approvals,
      status: status(rateBp(approvals, total)),
      note: "approval requests and gate hits (46010) — drift toward asking permission",
    },
    {
      mode: "semantic-misalignment",
      signalEvents: tombstones,
      status: status(rateBp(tombstones, total)),
      note: "tombstones and disposed drafts — action retracted after the fact",
    },
    {
      mode: "security-trust-gaps",
      signalEvents: revokes,
      status: status(rateBp(revokes, total)),
      note: "revocations and sanctions — trust withdrawn",
    },
    {
      mode: "cascading-effects",
      signalEvents: cascadeEvents,
      status: status(rateBp(cascadeEvents, total)),
      note: "events clustering within 30s after a revoke/tombstone",
    },
    {
      mode: "systemic-complexity",
      signalEvents: revisions,
      status: status(rateBp(revisions, total)),
      note: "revision churn per coordinate (see the thrash scoreboard)",
    },
  ];
}

// ── Instrument 4: the thrash-vs-work scoreboard (Cursor) ───────────────────

export interface Thrash {
  revisions: number;
  coordinates: number;
  reworkRateBp: number;
  settledRateBp: number;
  reading: string;
}

export function thrash(events: DiagEvent[]): Thrash | null {
  const perCoordinate = new Map<string, number>();
  let revisions = 0;
  for (const e of events) {
    if (e.class !== "revision") continue;
    revisions += 1;
    if (e.coordinate) {
      perCoordinate.set(
        e.coordinate,
        (perCoordinate.get(e.coordinate) ?? 0) + 1,
      );
    }
  }
  if (revisions === 0) return null;
  const coordinates = perCoordinate.size;
  let rework = 0;
  let settled = 0;
  for (const n of perCoordinate.values()) {
    rework += Math.max(0, n - 1);
    if (n === 1) settled += 1;
  }
  const reworkRateBp = rateBp(rework, revisions);
  const settledRateBp = rateBp(settled, coordinates);
  const reading =
    reworkRateBp >= 5000
      ? "churning: most revisions rework the same item — effort without progress"
      : settledRateBp >= 7000
        ? "settled: most items were written once and left alone"
        : "mixed: raw counts above are the honest read";
  return {
    revisions,
    coordinates,
    reworkRateBp,
    settledRateBp,
    reading,
  };
}

// ── Instrument 5: drift probes (AI Village) ────────────────────────────────

export interface DriftProbe {
  actor: string;
  earlierEvents: number;
  laterEvents: number;
  driftBp: number;
  flagged: boolean;
}

export function driftProbes(events: DiagEvent[]): DriftProbe[] {
  if (events.length < MIN_EVENTS) return [];
  const sorted = sortedEvents(events);
  const t0 = sorted[0]?.at ?? 0;
  const t1 = sorted[sorted.length - 1]?.at ?? 0;
  const mid = t0 + Math.floor((t1 - t0) / 2);
  const perActor = new Map<string, { early: number[]; late: number[] }>();
  for (const e of sorted) {
    let entry = perActor.get(e.actor);
    if (!entry) {
      entry = {
        early: new Array(DIAG_CLASSES.length).fill(0),
        late: new Array(DIAG_CLASSES.length).fill(0),
      };
      perActor.set(e.actor, entry);
    }
    const idx = DIAG_CLASSES.indexOf(e.class);
    if (e.at <= mid) entry.early[idx] += 1;
    else entry.late[idx] += 1;
  }
  const out: DriftProbe[] = [];
  for (const [actor, { early, late }] of perActor) {
    const ne = early.reduce((a, b) => a + b, 0);
    const nl = late.reduce((a, b) => a + b, 0);
    if (ne < MIN_DRIFT_EVENTS || nl < MIN_DRIFT_EVENTS) continue;
    let l1 = 0;
    for (let i = 0; i < DIAG_CLASSES.length; i++) {
      l1 += Math.abs(rateBp(early[i], ne) - rateBp(late[i], nl));
    }
    out.push({
      actor,
      earlierEvents: ne,
      laterEvents: nl,
      driftBp: l1,
      flagged: l1 >= DRIFT_FLAG_BP,
    });
  }
  return out;
}

// ── Instrument 6: supervision saturation ───────────────────────────────────

export interface Supervision {
  approvalRequests: number;
  actions: number;
  saturationBp: number;
  topApproverShareBp: number;
  status: "calm" | "watch" | "saturated";
}

export function supervision(events: DiagEvent[]): Supervision | null {
  if (events.length < MIN_EVENTS) return null;
  const approvals = events.filter((e) => e.class === "approval");
  const saturationBp = rateBp(approvals.length, events.length);
  const perActor = new Map<string, number>();
  for (const e of approvals) {
    perActor.set(e.actor, (perActor.get(e.actor) ?? 0) + 1);
  }
  let topApproverShareBp = 0;
  for (const n of perActor.values()) {
    topApproverShareBp = Math.max(
      topApproverShareBp,
      rateBp(n, approvals.length),
    );
  }
  const status =
    saturationBp >= SATURATION_FLAG_BP
      ? "saturated"
      : saturationBp >= 500
        ? "watch"
        : "calm";
  return {
    approvalRequests: approvals.length,
    actions: events.length,
    saturationBp,
    topApproverShareBp,
    status,
  };
}

// ── The report ─────────────────────────────────────────────────────────────

export interface DiagReport {
  events: number;
  from: number;
  to: number;
  timeSignal?: TimeSignal;
  tomasello?: Tomasello;
  wefModes: WefMode[];
  thrash?: Thrash;
  drift: DriftProbe[];
  supervision?: Supervision;
}

/** Run every instrument over one window (order-independent by construction). */
export function diagnose(events: DiagEvent[]): DiagReport {
  const sorted = sortedEvents(events);
  const time = timeSignal(events) ?? undefined;
  const layers = tomasello(events) ?? undefined;
  const scoreboard = thrash(events) ?? undefined;
  const sat = supervision(events) ?? undefined;
  return {
    events: events.length,
    from: sorted[0]?.at ?? 0,
    to: sorted[sorted.length - 1]?.at ?? 0,
    ...(time ? { timeSignal: time } : {}),
    ...(layers ? { tomasello: layers } : {}),
    wefModes: wefModes(events),
    ...(scoreboard ? { thrash: scoreboard } : {}),
    drift: driftProbes(events),
    ...(sat ? { supervision: sat } : {}),
  };
}

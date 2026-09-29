// Budget subject + limit rules shared by the budget form, the org wizard, the
// budget card, and the activity/audit text. Pure and framework-free so
// node --test units can pin the relay contract from the client side.
//
// Relay contract (crates/buzz-relay budget_enforcement.rs
// `budget_content_error`): a kind:37012 budget's `subject` is either the
// 64-hex pubkey of the AGENT it covers or "*", the community default that
// covers every agent without its own budget (community owner/admin only). An
// org node's d-tag is NOT a subject — the relay rejects it, and every display
// path (audit, dashboard, ladder, consumption `#p` filters) reads the subject
// as a pubkey.
//
// NIP-ORG: "a budget a surface cannot observe MUST be rendered advisory."
// The relay enforces the counters it can observe (runs, tasks.create,
// governance proposals/votes/executes, messages, llmCalls). Task approvals
// and spend are NOT counted by the relay: spend is enforced only by an
// on-chain allowance (`OrgAllowance.spendTo`), so a spend limit without an
// `onchain` binding is a note, not a fence.
import type { BudgetLimits, OrgNode } from "../orgModels";

/** Subject of the community-default budget (covers every agent). */
export const COMMUNITY_DEFAULT_SUBJECT = "*";
export const COMMUNITY_DEFAULT_LABEL = "All agents (community default)";

const HEX_PUBKEY = /^[0-9a-f]{64}$/i;

export function isCommunityDefaultSubject(
  subject: string | null | undefined,
): boolean {
  return subject === COMMUNITY_DEFAULT_SUBJECT;
}

/** True for exactly what the relay accepts: a 64-hex agent pubkey or "*". */
export function isBudgetSubject(subject: string): boolean {
  return isCommunityDefaultSubject(subject) || HEX_PUBKEY.test(subject);
}

/** Trim; agent pubkeys are lowercased, "*" is kept as is. */
export function normalizeBudgetSubject(subject: string): string {
  const trimmed = subject.trim();
  return isCommunityDefaultSubject(trimmed) ? trimmed : trimmed.toLowerCase();
}

/** Human-readable reason a subject would be rejected, or null when valid. */
export function budgetSubjectError(
  subject: string | null | undefined,
): string | null {
  const trimmed = (subject ?? "").trim();
  if (!trimmed) return "Pick the agent this budget covers.";
  if (isBudgetSubject(trimmed)) return null;
  return 'A budget covers an agent (its 64-hex public key) or all agents ("*"). An org node id is not a valid subject.';
}

/**
 * Whether to offer "All agents (community default)". The relay accepts it
 * from the community owner/admin only. When the viewer's role is knowable
 * (an NIP-43 membership snapshot exists) it gates the option; when it is not
 * (open relay, still loading) the option is shown and the relay's rejection
 * is surfaced verbatim.
 */
export function canOfferCommunityDefault(
  lookup:
    | {
        snapshotFound: boolean;
        membership: { role: string } | null;
      }
    | undefined,
): boolean {
  if (!lookup?.snapshotFound) return true;
  const role = lookup.membership?.role;
  return role === "owner" || role === "admin";
}

export type BudgetSubjectOption = {
  /** The value published as `subject`: a lowercase 64-hex pubkey or "*". */
  id: string;
  label: string;
  /** Secondary line, also searched. */
  sub?: string;
  kindBadge?: string;
  /** Rendered as a pubkey chip. */
  pubkey?: string;
};

type SeatNode = Pick<OrgNode, "name" | "agentSeats" | "revoked">;

/**
 * Subject options: every agent occupying a seat of a live org node (one row
 * per pubkey, labelled with its seat(s)), plus the community default when
 * `includeCommunityDefault`. `resolveName` is the caller's profile lookup.
 */
export function buildBudgetSubjectOptions(
  nodes: readonly SeatNode[],
  options: {
    includeCommunityDefault: boolean;
    /** Names a pubkey; `seats` are the seat names it occupies. */
    resolveName: (pubkey: string, seats: readonly string[]) => string;
  },
): BudgetSubjectOption[] {
  const seatsByAgent = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.revoked) continue;
    for (const raw of node.agentSeats) {
      const pubkey = raw.trim().toLowerCase();
      if (!HEX_PUBKEY.test(pubkey)) continue;
      const seats = seatsByAgent.get(pubkey) ?? [];
      if (!seats.includes(node.name)) seats.push(node.name);
      seatsByAgent.set(pubkey, seats);
    }
  }

  const agents: BudgetSubjectOption[] = [...seatsByAgent.entries()]
    .map(([pubkey, seats]) => ({
      id: pubkey,
      label: options.resolveName(pubkey, seats),
      sub: `Seat: ${seats.join(", ")}`,
      kindBadge: "agent",
      pubkey,
    }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));

  if (!options.includeCommunityDefault) return agents;
  return [
    {
      id: COMMUNITY_DEFAULT_SUBJECT,
      label: COMMUNITY_DEFAULT_LABEL,
      sub: "Covers every agent that has no budget of its own",
      kindBadge: "default",
    },
    ...agents,
  ];
}

// ── Limits ─────────────────────────────────────────────────────────────────

export type BudgetEnforcement = "relay" | "onchain" | "advisory";

export const ENFORCEMENT_LABEL: Record<BudgetEnforcement, string> = {
  relay: "Enforced by the relay",
  onchain: "Enforced onchain",
  advisory: "Advisory",
};

export type BudgetLimitKey =
  | "runs"
  | "messages"
  | "llmCalls"
  | "llmCostCents"
  | "taskCreate"
  | "proposals"
  | "taskApprove"
  | "spend";

export type BudgetLimitField = {
  key: BudgetLimitKey;
  label: string;
  placeholder: string;
  /** What the relay does with this limit when the budget has no binding. */
  enforcement: BudgetEnforcement;
  /** One-line honesty note shown under advisory inputs. */
  note?: string;
};

/** Form fields, enforced-by-the-relay limits first. */
export const BUDGET_LIMIT_FIELDS: readonly BudgetLimitField[] = [
  {
    key: "runs",
    label: "Max Runs",
    placeholder: "e.g. 100",
    enforcement: "relay",
  },
  {
    key: "messages",
    label: "Max Messages",
    placeholder: "e.g. 500",
    enforcement: "relay",
  },
  {
    key: "llmCalls",
    label: "Max LLM Calls",
    placeholder: "e.g. 200",
    enforcement: "relay",
  },
  {
    key: "llmCostCents",
    label: "Max LLM Spend (cents)",
    placeholder: "e.g. 500",
    enforcement: "relay",
    note: "Needs the relay's LLM prices configured; without them the gateway refuses the agent rather than run it unmetered.",
  },
  {
    key: "taskCreate",
    label: "Task Create Limit",
    placeholder: "e.g. 10",
    enforcement: "relay",
  },
  {
    key: "proposals",
    label: "Max Proposals",
    placeholder: "e.g. 2",
    enforcement: "relay",
  },
  {
    key: "taskApprove",
    label: "Task Approve Limit",
    placeholder: "e.g. 5",
    enforcement: "advisory",
    note: "The relay does not count task approvals.",
  },
  {
    key: "spend",
    label: "Max Spend (cents)",
    placeholder: "e.g. 50000",
    enforcement: "advisory",
    note: "Only an on-chain allowance can stop spending.",
  },
];

export type BudgetLimitInput = Partial<Record<BudgetLimitKey, number>>;

/** The `limits` object published in a kind:37012 budget's content. */
export function buildBudgetLimits(
  input: BudgetLimitInput,
): Record<string, unknown> {
  const limits: Record<string, unknown> = {};
  if (input.spend != null) {
    limits.spend = { amount: input.spend, unit: "usd-cents" };
  }
  if (input.runs != null) limits.runs = input.runs;
  if (input.taskCreate != null || input.taskApprove != null) {
    limits.tasks = {
      ...(input.taskCreate != null ? { create: input.taskCreate } : {}),
      ...(input.taskApprove != null ? { approve: input.taskApprove } : {}),
    };
  }
  if (input.proposals != null)
    limits.governance = { proposal: input.proposals };
  if (input.messages != null) limits.messages = input.messages;
  if (input.llmCalls != null) limits.llmCalls = input.llmCalls;
  if (input.llmCostCents != null) limits.llmCostCents = input.llmCostCents;
  return limits;
}

export type OrgBudgetContentInput = {
  subject: string;
  window: "epoch" | "day" | "week" | "month";
  limits: BudgetLimitInput;
};

/**
 * The kind:37012 content for a new budget. Throws on a subject the relay
 * would reject, so every publish path (form and wizard) fails locally with a
 * readable message instead of a bare relay rejection.
 */
export function buildOrgBudgetContent(input: OrgBudgetContentInput): string {
  const error = budgetSubjectError(input.subject);
  if (error) throw new Error(error);
  return JSON.stringify({
    v: 1,
    subject: normalizeBudgetSubject(input.subject),
    window: input.window,
    limits: buildBudgetLimits(input.limits),
    onExceed: "require-approval",
  });
}

/** Parse a non-negative whole number from a form field; empty → undefined. */
export function parseLimitField(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** True when a form field is empty or a non-negative whole number. */
export function isLimitFieldValid(raw: string): boolean {
  return raw.trim() === "" || parseLimitField(raw) !== undefined;
}

export type DescribedLimit = {
  key: string;
  /** e.g. "50 runs/month". */
  text: string;
  enforcement: BudgetEnforcement;
  /** ENFORCEMENT_LABEL of `enforcement`. */
  badge: string;
};

/**
 * Every limit a budget declares, with an honest enforcement label. Limits
 * the relay counts are "Enforced by the relay"; task approvals are advisory;
 * spend is enforced onchain only when the budget carries an `onchain`
 * binding, otherwise advisory.
 */
export function describeBudgetLimits(budget: {
  limits: BudgetLimits;
  window: string;
  onchain?: unknown;
}): DescribedLimit[] {
  const { limits, window } = budget;
  const rows: Array<[string, string, BudgetEnforcement]> = [];
  if (limits.runs != null) {
    rows.push(["runs", `${limits.runs} runs/${window}`, "relay"]);
  }
  if (limits.spend != null) {
    rows.push([
      "spend",
      `${limits.spend.amount} ${limits.spend.unit}/${window}`,
      budget.onchain ? "onchain" : "advisory",
    ]);
  }
  if (limits.tasks?.create != null) {
    rows.push([
      "tasks.create",
      `${limits.tasks.create} tasks created/${window}`,
      "relay",
    ]);
  }
  if (limits.tasks?.approve != null) {
    rows.push([
      "tasks.approve",
      `${limits.tasks.approve} tasks approved/${window}`,
      "advisory",
    ]);
  }
  if (limits.messages != null) {
    rows.push(["messages", `${limits.messages} messages/${window}`, "relay"]);
  }
  if (limits.llmCalls != null) {
    rows.push(["llmCalls", `${limits.llmCalls} LLM calls/${window}`, "relay"]);
  }
  if (limits.llmCostCents != null) {
    rows.push([
      "llmCostCents",
      `${limits.llmCostCents}¢ LLM spend/${window}`,
      "relay",
    ]);
  }
  if (limits.governance?.proposal != null) {
    rows.push([
      "governance.proposal",
      `${limits.governance.proposal} proposals/${window}`,
      "relay",
    ]);
  }
  if (limits.governance?.vote != null) {
    rows.push([
      "governance.vote",
      `${limits.governance.vote} votes/${window}`,
      "relay",
    ]);
  }
  if (limits.governance?.execute != null) {
    rows.push([
      "governance.execute",
      `${limits.governance.execute} executions/${window}`,
      "relay",
    ]);
  }
  return rows.map(([key, text, enforcement]) => ({
    key,
    text,
    enforcement,
    badge: ENFORCEMENT_LABEL[enforcement],
  }));
}

/** Plain one-line summary (no enforcement labels) for feed and audit rows. */
export function budgetLimitSummary(budget: {
  limits: BudgetLimits;
  window: string;
  onchain?: unknown;
}): string {
  const rows = describeBudgetLimits(budget);
  return rows.length > 0 ? rows.map((row) => row.text).join(", ") : "no limits";
}

/** Display name of a budget's subject; `resolveAgent` names a pubkey. */
export function budgetSubjectLabel(
  subject: string,
  resolveAgent: (pubkey: string) => string,
): string {
  return isCommunityDefaultSubject(subject)
    ? COMMUNITY_DEFAULT_LABEL
    : resolveAgent(subject);
}

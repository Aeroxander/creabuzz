// The emergency-stop sequence shared by the desktop and web apps — the exact
// ordered publish chain `buzz org agent stop <pubkey>` runs
// (crates/buzz-cli/src/commands/org.rs), behind buttons instead of a shell.
//
// Why one shared implementation: stopping an agent is four separate records —
// a hard-reject budget, an optional ban, unseating it from every org node, and
// revoking its grants — and doing them as four independent UI writes leaves a
// torn half-stopped agent whenever one write fails. This module runs them as
// one ordered, retryable sequence: containment (the budget) first, every later
// step is cleanup, and a failure in one step never blocks the others because
// the whole sequence is safe to re-run. A re-run publishes only what is not
// already in force, so it resumes exactly where a partial failure left off.

/** The event kinds this sequence publishes. */
export const AGENT_STOP_KIND_BUDGET = 37012;
export const AGENT_STOP_KIND_BAN = 9040;
export const AGENT_STOP_KIND_NODE = 37010;
export const AGENT_STOP_KIND_GRANT = 37011;

/** One stored record the sequence may republish (its newest form per `d`). */
export type AgentStopRecord = {
  /** NIP-33 `d` tag (address of the record). */
  d: string;
  /** `created_at` of the stored event, unix seconds. */
  createdAt: number;
  /** Stored event `content`, JSON. */
  content: string;
};

/** An unsigned event the caller signs and publishes. */
export type AgentStopEvent = {
  kind: number;
  content: string;
  tags: string[][];
  createdAt: number;
};

export type AgentStopStepName = "budget" | "ban" | "seats" | "grants";

export type AgentStopStepResult =
  | { step: AgentStopStepName; ok: true; changed: number }
  | { step: AgentStopStepName; ok: false; error: string };

export type AgentStopReport = {
  agent: string;
  /** True only when every step completed — anything less needs a re-run. */
  stopped: boolean;
  steps: AgentStopStepResult[];
};

export type AgentStopDeps = {
  /** The operator's own pubkey (lowercase hex) — the sequence's author. */
  me: string;
  /** The agent to stop (hex). Must not be `me`. */
  agent: string;
  /** Also ban the agent from the community (kind:9040). */
  ban: boolean;
  /** Optional ban reason. */
  reason?: string;
  nowSeconds: () => number;
  /**
   * The caller's own newest records for `kind` (the caller scopes the fetch to
   * `me`). Pass `dTag` to fetch one address only.
   */
  fetchOwn: (kind: number, dTag?: string) => Promise<AgentStopRecord[]>;
  /** Sign and publish one event; throw on failure. */
  publish: (event: AgentStopEvent) => Promise<void>;
};

const HEX_PUBKEY = /^[0-9a-f]{64}$/i;

/** The budget record's address: the CLI's `stop-<agent[0..16]>`. */
export function stopBudgetId(agent: string): string {
  return `stop-${agent.slice(0, 16)}`;
}

/**
 * The all-time, hard-reject budget that stops an agent at once. The strictest
 * budget wins at enforcement, so this overrides whatever else covers it —
 * every limit zeroed and `onExceed: "reject"` so nothing queues for approval.
 * Serialized camelCase per NIP-ORG, matching the SDK's `OrgBudgetContent`.
 */
export function stopBudgetContent(agent: string): string {
  return JSON.stringify({
    v: 1,
    subject: agent.toLowerCase(),
    window: "epoch",
    limits: {
      spend: { amount: 0, unit: "usd-cents" },
      runs: 0,
      tasks: { create: 0, approve: 0 },
      governance: { proposal: 0, vote: 0, execute: 0 },
      messages: 0,
      llmCalls: 0,
      llmCostCents: 0,
    },
    onExceed: "reject",
  });
}

/**
 * A `created_at` strictly newer than the record being replaced. NIP-33 keeps
 * only the newest event per coordinate and drops a republish made within the
 * same second as its predecessor as a duplicate.
 */
export function nextCreatedAt(
  existingCreatedAt: number | null,
  now: number,
): number {
  return Math.max(now, existingCreatedAt === null ? 0 : existingCreatedAt + 1);
}

/** Parse a stored content body; `null` when it is not a JSON object. */
function parseObject(content: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

/** Canonical JSON (sorted keys, nulls dropped) for order-insensitive equality. */
function canonical(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonical(v)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== null && v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The newest record per `d` (NIP-33: only the newest counts). */
function newestPerD(records: AgentStopRecord[]): AgentStopRecord[] {
  const newest = new Map<string, AgentStopRecord>();
  for (const record of records) {
    const current = newest.get(record.d);
    if (!current || current.createdAt < record.createdAt) {
      newest.set(record.d, record);
    }
  }
  return [...newest.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, record]) => record);
}

/**
 * The node republish with `agent` removed from `agentSeats`, keeping every
 * other field — holders, parent, scope. `null` when nothing would change.
 */
export function detachAgentSeat(
  existing: string,
  agent: string,
): string | null {
  const body = parseObject(existing);
  if (!body) return null;
  const who = agent.toLowerCase();
  const seats = stringArray(body.agentSeats);
  if (!seats.some((s) => s.toLowerCase() === who)) return null;
  return JSON.stringify({
    ...body,
    agentSeats: seats.filter((s) => s.toLowerCase() !== who),
  });
}

/**
 * The tags of a republished kind:37010 node, matching the SDK builder: `d`,
 * `name`, and one `seat` per holder and agent seat (the relay's seat cap
 * counts these — dropping them silently strips authority).
 */
export function orgNodeTags(dtag: string, content: string): string[][] {
  const body = parseObject(content) ?? {};
  const tags: string[][] = [["d", dtag]];
  if (typeof body.name === "string" && body.name) {
    tags.push(["name", body.name]);
  }
  for (const holder of stringArray(body.holders)) tags.push(["seat", holder]);
  for (const agent of stringArray(body.agentSeats)) tags.push(["seat", agent]);
  return tags;
}

/**
 * The grant republish with `revoked: true`, every other field kept — never a
 * stub. `null` when the grant is not revocable here: an equity stake is a
 * record, not a delegation (an emergency stop cuts authority, it does not
 * confiscate equity), or it is already revoked / not the agent's.
 */
export function grantRevocation(
  existing: string,
  agent: string,
): string | null {
  const body = parseObject(existing);
  if (!body) return null;
  if (body.type === "equity") return null;
  if (body.revoked) return null;
  const grantee = typeof body.grantee === "string" ? body.grantee : "";
  if (grantee.toLowerCase() !== agent.toLowerCase()) return null;
  return JSON.stringify({ ...body, revoked: true });
}

async function stepBudget(
  deps: AgentStopDeps,
  steps: AgentStopStepResult[],
): Promise<void> {
  const id = stopBudgetId(deps.agent);
  const content = stopBudgetContent(deps.agent);
  const records = await deps.fetchOwn(AGENT_STOP_KIND_BUDGET, id);
  const current = records.reduce<AgentStopRecord | null>(
    (newest, r) => (!newest || r.createdAt > newest.createdAt ? r : newest),
    null,
  );
  // Already in force: nothing to publish (an identical republish within the
  // same second would only be dropped as a duplicate).
  if (
    current &&
    canonical(parseObject(current.content)) === canonical(parseObject(content))
  ) {
    steps.push({ step: "budget", ok: true, changed: 0 });
    return;
  }
  await deps.publish({
    kind: AGENT_STOP_KIND_BUDGET,
    content,
    tags: [["d", id]],
    createdAt: nextCreatedAt(
      current ? current.createdAt : null,
      deps.nowSeconds(),
    ),
  });
  steps.push({ step: "budget", ok: true, changed: 1 });
}

async function stepBan(
  deps: AgentStopDeps,
  steps: AgentStopStepResult[],
): Promise<void> {
  const tags: string[][] = [["p", deps.agent.toLowerCase()]];
  if (deps.reason) tags.push(["reason", deps.reason]);
  await deps.publish({
    kind: AGENT_STOP_KIND_BAN,
    content: "",
    tags,
    createdAt: deps.nowSeconds(),
  });
  steps.push({ step: "ban", ok: true, changed: 1 });
}

async function stepSeats(
  deps: AgentStopDeps,
  steps: AgentStopStepResult[],
): Promise<void> {
  let changed = 0;
  for (const record of newestPerD(await deps.fetchOwn(AGENT_STOP_KIND_NODE))) {
    const content = detachAgentSeat(record.content, deps.agent);
    if (content === null) continue;
    await deps.publish({
      kind: AGENT_STOP_KIND_NODE,
      content,
      tags: orgNodeTags(record.d, content),
      createdAt: nextCreatedAt(record.createdAt, deps.nowSeconds()),
    });
    changed += 1;
  }
  steps.push({ step: "seats", ok: true, changed });
}

async function stepGrants(
  deps: AgentStopDeps,
  steps: AgentStopStepResult[],
): Promise<void> {
  let changed = 0;
  for (const record of newestPerD(await deps.fetchOwn(AGENT_STOP_KIND_GRANT))) {
    const content = grantRevocation(record.content, deps.agent);
    if (content === null) continue;
    const body = parseObject(content) ?? {};
    const grantee = typeof body.grantee === "string" ? body.grantee : "";
    await deps.publish({
      kind: AGENT_STOP_KIND_GRANT,
      content,
      tags: [
        ["d", record.d],
        ["grantee", grantee],
      ],
      createdAt: nextCreatedAt(record.createdAt, deps.nowSeconds()),
    });
    changed += 1;
  }
  steps.push({ step: "grants", ok: true, changed });
}

/**
 * Run the emergency stop: budget, then optional ban, then unseat, then grant
 * revocation. Every step is attempted even when an earlier one fails
 * (containment first; the rest is cleanup), each failure is recorded with the
 * step that failed, and the whole sequence is safe to re-run — a re-run
 * publishes only what is not already in force, resuming the retry exactly.
 *
 * Throws only for invalid input (an agent that is not 64-hex, or `me` itself).
 */
export async function executeAgentStop(
  deps: AgentStopDeps,
): Promise<AgentStopReport> {
  const agent = deps.agent.trim().toLowerCase();
  const me = deps.me.trim().toLowerCase();
  if (!HEX_PUBKEY.test(agent)) {
    throw new Error("An agent stop needs the agent's 64-hex public key.");
  }
  if (agent === me) {
    throw new Error("refusing to stop your own key — pass the agent's pubkey");
  }
  const scoped: AgentStopDeps = { ...deps, agent };
  const steps: AgentStopStepResult[] = [];
  const run = async (
    name: AgentStopStepName,
    fn: (d: AgentStopDeps, s: AgentStopStepResult[]) => Promise<void>,
  ): Promise<void> => {
    try {
      await fn(scoped, steps);
    } catch (error) {
      steps.push({
        step: name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // Containment first: every later step is cleanup, and a failure in one
  // must not stop the others — the whole sequence is safe to re-run.
  await run("budget", stepBudget);
  if (scoped.ban) await run("ban", stepBan);
  await run("seats", stepSeats);
  await run("grants", stepGrants);

  return {
    agent,
    stopped: steps.every((s) => s.ok),
    steps,
  };
}

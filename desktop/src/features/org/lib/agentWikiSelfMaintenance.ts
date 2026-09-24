/**
 * Agent Wiki self-maintenance (scheduled distill) — pure logic behind the
 * one-click enable/disable toggle in ../ui/AgentWikiSection.tsx.
 *
 * The distill loop runs as a workflow action (`distill_agent_wiki`) on the
 * durable cron scheduler; the workflow itself IS the toggle (docs/agent-wiki.md
 * § Self-maintenance). This module pins the documented workflow definition
 * verbatim and derives everything the toggle shows from real workflow state —
 * presence is keyed on name AND action shape, and the schedule line comes from
 * the workflow's own trigger, never a hardcoded claim.
 *
 * This module never mutates anything: the hooks in ../agentWikiHooks.ts drive
 * the existing `create_workflow` / `delete_workflow` commands with
 * {@link agentWikiSelfMaintenanceYaml}.
 */
import { stringify as yamlStringify } from "yaml";

/** Workflow name the self-maintenance loop is keyed on. */
export const AGENT_WIKI_SELF_MAINTENANCE_NAME = "agwiki-nightly";

/** Step action the self-maintenance loop must run to count as present. */
export const AGENT_WIKI_SELF_MAINTENANCE_STEP_ACTION = "distill_agent_wiki";

/** Shape of the documented workflow (docs/agent-wiki.md). */
export type AgentWikiSelfMaintenanceDefinition = {
  name: string;
  description: string;
  trigger: { on: "schedule"; cron: string };
  steps: Array<{ id: string; action: "distill_agent_wiki"; space: string }>;
  enabled: boolean;
};

/**
 * The documented workflow, pinned field-for-field. A drift test
 * (agentWikiSelfMaintenance.test.mjs) keeps this in lockstep with the YAML
 * block in docs/agent-wiki.md — change either one and the test names the
 * other as the stale side.
 */
export const AGENT_WIKI_SELF_MAINTENANCE_DEFINITION: AgentWikiSelfMaintenanceDefinition =
  {
    name: AGENT_WIKI_SELF_MAINTENANCE_NAME,
    description:
      "Keep the Agent Wiki standup page current without a manual distill",
    trigger: { on: "schedule", cron: "0 9 * * 1-5" },
    steps: [
      {
        id: "distill",
        action: AGENT_WIKI_SELF_MAINTENANCE_STEP_ACTION,
        space: "default",
      },
    ],
    enabled: true,
  };

/**
 * YAML body for `create_workflow`. Round-trips through `yaml` parse to the
 * pinned definition (bound by the round-trip test).
 */
export function agentWikiSelfMaintenanceYaml(): string {
  return yamlStringify(AGENT_WIKI_SELF_MAINTENANCE_DEFINITION);
}

// ── Presence detection (name AND action shape) ──────────────────────────────

/** Structural slice of a workflow record presence detection needs. */
export type SelfMaintenanceWorkflowLike = {
  id: string;
  channelId: string | null;
  definition: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * A definition counts as the self-maintenance loop only when it carries BOTH
 * the pinned name AND a `distill_agent_wiki` step. Name-only or action-only
 * matches (a hand-edited workflow, an unrelated nightly job) never flip the
 * toggle — keyed on both halves so the UI cannot report state that the
 * scheduler does not have.
 */
export function isSelfMaintenanceDefinition(
  definition: Record<string, unknown>,
): boolean {
  if (definition.name !== AGENT_WIKI_SELF_MAINTENANCE_NAME) return false;
  const steps = definition.steps;
  if (!Array.isArray(steps)) return false;
  return steps.some(
    (step) =>
      isRecord(step) && step.action === AGENT_WIKI_SELF_MAINTENANCE_STEP_ACTION,
  );
}

/**
 * Find the self-maintenance workflow in a workflow list. When duplicates
 * exist (e.g. one per space, per docs), the winner is deterministic regardless
 * of relay ordering: lowest (channelId, id).
 */
export function findSelfMaintenanceWorkflow<
  T extends SelfMaintenanceWorkflowLike,
>(workflows: readonly T[]): T | null {
  const matches = workflows
    .filter((workflow) => isSelfMaintenanceDefinition(workflow.definition))
    .sort((a, b) =>
      `${a.channelId ?? ""}|${a.id}`.localeCompare(
        `${b.channelId ?? ""}|${b.id}`,
      ),
    );
  return matches[0] ?? null;
}

// ── Schedule rendering (from the workflow's own trigger) ────────────────────

const DAY_ABBREVS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Human day description for a cron day-of-week field, or null if unparsed. */
function describeCronDow(dow: string): string | null {
  if (dow === "*") return "every day";
  const days = new Set<number>();
  for (const part of dow.split(",")) {
    const token = part.trim();
    if (token === "") return null;
    const range = /^(\d{1,2})-(\d{1,2})$/.exec(token);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start > 6 || end > 6 || start > end) return null;
      for (let day = start; day <= end; day += 1) days.add(day);
      continue;
    }
    if (!/^\d{1,2}$/.test(token)) return null;
    const day = Number(token);
    if (day > 7) return null;
    // Cron allows 7 as a second Sunday spelling.
    days.add(day === 7 ? 0 : day);
  }
  if (days.size === 0) return null;
  if (days.size === 7) return "every day";
  if (days.size === 5 && [1, 2, 3, 4, 5].every((day) => days.has(day))) {
    return "weekdays";
  }
  if (days.size === 2 && days.has(0) && days.has(6)) return "weekends";
  return [...days]
    .sort((a, b) => a - b)
    .map((day) => DAY_ABBREVS[day])
    .join(", ");
}

function isBoundedNumberField(field: string, max: number): boolean {
  if (!/^\d+$/.test(field)) return false;
  return Number(field) <= max;
}

/**
 * Human schedule line for a 5-field cron expression. Only the shapes a reader
 * can state honestly are expanded ("weekdays at 09:00 UTC"); anything else
 * falls back to printing the raw expression instead of guessing.
 */
export function describeCronSchedule(cron: string): string {
  const fallback = `cron ${cron.trim()}`;
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return fallback;
  const [minute, hour, dom, month, dow] = fields;
  if (dom !== "*" || month !== "*") return fallback;
  if (!isBoundedNumberField(minute, 59) || !isBoundedNumberField(hour, 23)) {
    return fallback;
  }
  const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")} UTC`;
  const days = describeCronDow(dow);
  if (days === null) return fallback;
  return `${days} at ${time}`;
}

/**
 * Schedule line derived from a workflow definition's own trigger: the cron
 * humanized, an interval trigger verbatim ("every 24h"), and null when the
 * trigger is not a schedule at all (the row then shows "on" without a claim).
 */
export function selfMaintenanceScheduleLabel(
  definition: Record<string, unknown>,
): string | null {
  const trigger = definition.trigger;
  if (!isRecord(trigger) || trigger.on !== "schedule") return null;
  if (typeof trigger.cron === "string" && trigger.cron.trim().length > 0) {
    return describeCronSchedule(trigger.cron);
  }
  if (
    typeof trigger.interval === "string" &&
    trigger.interval.trim().length > 0
  ) {
    return `every ${trigger.interval.trim()}`;
  }
  return null;
}

// ── Row copy (pure, so the toggle text is testable) ─────────────────────────

/** The toggle's two verbs. */
export type SelfMaintenanceAction = "enable" | "disable";

export const SELF_MAINTENANCE_ENABLE_LABEL = "Enable nightly distill";
export const SELF_MAINTENANCE_DISABLE_LABEL = "Disable nightly distill";
export const SELF_MAINTENANCE_ENABLING_LABEL = "Enabling…";
export const SELF_MAINTENANCE_DISABLING_LABEL = "Disabling…";
export const SELF_MAINTENANCE_PENDING_FEEDBACK =
  "Saving the nightly distill schedule…";
export const SELF_MAINTENANCE_ENABLED_FEEDBACK = "Nightly standup enabled.";
export const SELF_MAINTENANCE_DISABLED_FEEDBACK = "Nightly standup disabled.";
export const SELF_MAINTENANCE_PENDING_STATUS =
  "Nightly standup: checking schedule…";
export const SELF_MAINTENANCE_ERROR_STATUS =
  "Nightly standup: status unavailable";
export const SELF_MAINTENANCE_NEEDS_CHANNEL_STATUS =
  "Nightly standup: needs a channel";
export const SELF_MAINTENANCE_NO_CHANNEL_COPY =
  "Workflows are channel-scoped — join or create a channel first to schedule the nightly distill.";

/**
 * The toggle button's visible label — its one accessible name (no aria-label
 * alongside it). Swaps to a progress verb while the save is pending.
 */
export function selfMaintenanceToggleLabel(
  enabled: boolean,
  pending: boolean,
): string {
  if (enabled) {
    return pending
      ? SELF_MAINTENANCE_DISABLING_LABEL
      : SELF_MAINTENANCE_DISABLE_LABEL;
  }
  return pending
    ? SELF_MAINTENANCE_ENABLING_LABEL
    : SELF_MAINTENANCE_ENABLE_LABEL;
}

/**
 * The status row text: "Nightly standup: on (weekdays at 09:00 UTC, #general)"
 * or "Nightly standup: off". The parenthetical is derived from the workflow's
 * own trigger and host channel — never a hardcoded schedule claim.
 */
export function selfMaintenanceStatusLabel(
  enabled: boolean,
  schedule: string | null,
  hostChannelName: string | null = null,
): string {
  if (!enabled) return "Nightly standup: off";
  const parts = [
    schedule,
    hostChannelName ? `#${hostChannelName}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0
    ? `Nightly standup: on (${parts.join(", ")})`
    : "Nightly standup: on";
}

/** Char cap for the inline failure excerpt surfaced to the user. */
export const SELF_MAINTENANCE_ERROR_EXCERPT_CHARS = 300;

/** Shown when the command failed without any error detail. */
export const SELF_MAINTENANCE_ERROR_FALLBACK =
  "Could not save the nightly distill workflow.";

/**
 * Bounded inline failure text for a rejected create/delete. Rule 1: the
 * command's own error (relay rejection, validation detail) is surfaced
 * verbatim up to the excerpt cap — never swallowed, never replaced with a
 * generic success-looking state.
 */
export function selfMaintenanceErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const trimmed = raw.trim();
  const chars = [...trimmed];
  if (chars.length === 0) return SELF_MAINTENANCE_ERROR_FALLBACK;
  return chars.length <= SELF_MAINTENANCE_ERROR_EXCERPT_CHARS
    ? trimmed
    : `${chars.slice(0, SELF_MAINTENANCE_ERROR_EXCERPT_CHARS).join("")}…`;
}

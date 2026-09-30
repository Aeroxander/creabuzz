/**
 * Self-Organizing Agent Teams strategy (kind:44020) create/edit form logic.
 *
 * Pure state <-> JSON mapping plus strict validation mirroring the CLI's
 * `TeamStrategy::validate` (crates/buzz-cli/src/commands/team_run.rs) bound
 * for bound: v=1; name 1..=128; description 1..=1024; teamworkPrompt
 * 1..=8192; roles 1..=6 slots (slot name 1..=32, role prompt 1..=4096);
 * steps 1..=6 phases (participants 1..=6 and all roster slots, rounds 1..=4,
 * flow "local" | "summary", step prompt 1..=4096, perAgentPrompts keyed by
 * that phase's participants with 1..=4096 prompts each); finalWriter a
 * roster slot; parentStrategy (optional) 1..=64. The strategy id (`d` tag)
 * is 1..=64 chars (`strategy put --id`).
 *
 * Character counts use Unicode code points (`[...s].length`), matching
 * Rust's `chars().count()`. The React shell (../ui/StrategyForm*.tsx) drives
 * every mutation through the exported helpers so the removal-path cleanup
 * rules (references dropped when a role or participant goes away) live in
 * one tested place. See docs/agent-teams.md for the language spec.
 */

/** Schema version written to every strategy (`v` must be 1). */
export const STRATEGY_SCHEMA_VERSION = 1;

// ── Validation bounds (mirror team_run.rs) ────────────────────────────────
export const STRATEGY_ID_MAX_CHARS = 64;
export const STRATEGY_NAME_MAX_CHARS = 128;
export const STRATEGY_DESC_MAX_CHARS = 1024;
export const TEAMWORK_PROMPT_MAX_CHARS = 8192;
export const ROLE_PROMPT_MAX_CHARS = 4096;
export const SLOT_NAME_MAX_CHARS = 32;
export const STEP_PROMPT_MAX_CHARS = 4096;
export const PARENT_STRATEGY_MAX_CHARS = 64;
/** Roster slots (`roles`) and `steps[].participants` both cap at 6. */
export const MAX_ROSTER_SLOTS = 6;
export const MAX_PHASES = 6;
export const MAX_PARTICIPANTS = 6;
export const MAX_ROUNDS = 4;

export const STRATEGY_FLOWS = ["local", "summary"] as const;
export type StrategyFlow = (typeof STRATEGY_FLOWS)[number];

// ── Form state ────────────────────────────────────────────────────────────

export type StrategyRoleRow = {
  /** Roster slot name (the `roles` key), e.g. "agent-0". */
  slot: string;
  /** Persistent role prompt α. */
  prompt: string;
};

export type StrategyStepRow = {
  /** Roster slots in response order (the listed array order is the order
   *  the members speak in each round). */
  participants: string[];
  /** Discussion rounds per participant; kept as a raw number so invalid
   *  values (NaN, 2.5) survive to validation instead of being coerced. */
  rounds: number;
  /** "local" | "summary"; a raw string so a bad value is flagged, not
   *  silently reinterpreted. */
  flow: string;
  /** Shared step prompt π_k. */
  prompt: string;
  /** Optional per-participant step prompts ρ_k, keyed by participants. */
  perAgentPrompts: Record<string, string>;
};

export type StrategyFormState = {
  /** The `d` tag (not part of the content JSON). */
  id: string;
  name: string;
  description: string;
  teamworkPrompt: string;
  roles: StrategyRoleRow[];
  steps: StrategyStepRow[];
  finalWriter: string;
  /** Reflection lineage (optional `parentStrategy` content field). */
  parentStrategy: string;
};

export type StrategyStepJson = {
  participants: string[];
  rounds: number;
  flow: string;
  prompt: string;
  perAgentPrompts?: Record<string, string>;
};

/** The exact kind:44020 content object (signed as the event content). */
export type StrategyJson = {
  v: number;
  name: string;
  description: string;
  teamworkPrompt: string;
  roles: Record<string, string>;
  steps: StrategyStepJson[];
  finalWriter: string;
  parentStrategy?: string;
};

/** Field-keyed validation messages; an empty object means valid. Keys match
 *  the form's field paths ("roles[1].prompt", "steps[0].rounds", …). */
export type StrategyFieldErrors = Record<string, string>;

// ── Small helpers ─────────────────────────────────────────────────────────

/** Unicode code-point count, matching Rust's `chars().count()`. */
export function charCount(value: string): number {
  return [...value].length;
}

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

/** String coercion for untrusted JSON scalars; structured junk becomes "". */
function scalarString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function emptyRoleRow(slot = ""): StrategyRoleRow {
  return { slot, prompt: "" };
}

export function emptyStepRow(participants: string[] = []): StrategyStepRow {
  return {
    participants: [...participants],
    rounds: 1,
    flow: "local",
    prompt: "",
    perAgentPrompts: {},
  };
}

/** Fresh create form: one "agent-0" role + one single-slot phase. */
export function defaultStrategyState(): StrategyFormState {
  return {
    id: "",
    name: "",
    description: "",
    teamworkPrompt: "",
    roles: [emptyRoleRow("agent-0")],
    steps: [emptyStepRow(["agent-0"])],
    finalWriter: "agent-0",
    parentStrategy: "",
  };
}

/** Slug suggestion for the `d` tag, derived from the display name. */
export function suggestStrategyId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, STRATEGY_ID_MAX_CHARS);
  return slug || "my-strategy";
}

// ── Immutable form mutators (the UI's only write path) ────────────────────

function patchStep(
  state: StrategyFormState,
  stepIndex: number,
  update: (step: StrategyStepRow) => Partial<StrategyStepRow>,
): StrategyFormState {
  return {
    ...state,
    steps: state.steps.map((step, index) =>
      index === stepIndex ? { ...step, ...update(step) } : step,
    ),
  };
}

/** Patch flat top-level fields (name, prompts, id, finalWriter, …). */
export function patchStrategy(
  state: StrategyFormState,
  patch: Partial<StrategyFormState>,
): StrategyFormState {
  return { ...state, ...patch };
}

/** Patch rounds/flow/prompt of one phase. */
export function patchStepFields(
  state: StrategyFormState,
  stepIndex: number,
  patch: Partial<StrategyStepRow>,
): StrategyFormState {
  return patchStep(state, stepIndex, () => patch);
}

export function addRole(state: StrategyFormState): StrategyFormState {
  return { ...state, roles: [...state.roles, emptyRoleRow()] };
}

/**
 * Remove one roster slot and clear every reference to it: participant
 * lists, per-agent prompt keys, and `finalWriter` (falls back to the first
 * remaining slot). Derived metadata is cleared on this removal path — see
 * AGENTS.md review-proven rule 2.
 */
export function removeRole(
  state: StrategyFormState,
  index: number,
): StrategyFormState {
  const removed = state.roles[index];
  if (!removed) return state;
  const roles = state.roles.filter((_, i) => i !== index);
  const steps = state.steps.map((step) => {
    const perAgentPrompts: Record<string, string> = {};
    for (const [slot, prompt] of Object.entries(step.perAgentPrompts)) {
      if (slot !== removed.slot) perAgentPrompts[slot] = prompt;
    }
    return {
      ...step,
      participants: step.participants.filter((slot) => slot !== removed.slot),
      perAgentPrompts,
    };
  });
  const finalWriter =
    state.finalWriter === removed.slot
      ? (roles[0]?.slot ?? "")
      : state.finalWriter;
  return { ...state, roles, steps, finalWriter };
}

/**
 * Rename a roster slot, rewriting every reference (participant order
 * preserved, per-agent prompt keys re-keyed, `finalWriter` follows) — the
 * other removal-adjacent path that must keep derived metadata coherent.
 */
export function renameRole(
  state: StrategyFormState,
  index: number,
  slot: string,
): StrategyFormState {
  const previous = state.roles[index]?.slot;
  if (previous === undefined) return state;
  const roles = state.roles.map((row, i) =>
    i === index ? { ...row, slot } : row,
  );
  const steps = state.steps.map((step) => {
    const perAgentPrompts: Record<string, string> = {};
    for (const [key, prompt] of Object.entries(step.perAgentPrompts)) {
      perAgentPrompts[key === previous ? slot : key] = prompt;
    }
    return {
      ...step,
      participants: step.participants.map((p) => (p === previous ? slot : p)),
      perAgentPrompts,
    };
  });
  const finalWriter = state.finalWriter === previous ? slot : state.finalWriter;
  return { ...state, roles, steps, finalWriter };
}

export function setRolePrompt(
  state: StrategyFormState,
  index: number,
  prompt: string,
): StrategyFormState {
  return {
    ...state,
    roles: state.roles.map((row, i) =>
      i === index ? { ...row, prompt } : row,
    ),
  };
}

export function addStep(state: StrategyFormState): StrategyFormState {
  return { ...state, steps: [...state.steps, emptyStepRow()] };
}

export function removeStep(
  state: StrategyFormState,
  index: number,
): StrategyFormState {
  return { ...state, steps: state.steps.filter((_, i) => i !== index) };
}

/**
 * Toggle a roster slot in one phase's participants. Adding appends to the
 * response order; removing also drops that slot's per-agent prompt (the
 * prompt is keyed by participant and must not outlive its owner).
 */
export function toggleStepParticipant(
  state: StrategyFormState,
  stepIndex: number,
  slot: string,
): StrategyFormState {
  return patchStep(state, stepIndex, (step) => {
    if (step.participants.includes(slot)) {
      const perAgentPrompts: Record<string, string> = {};
      for (const [key, prompt] of Object.entries(step.perAgentPrompts)) {
        if (key !== slot) perAgentPrompts[slot] = prompt;
      }
      return {
        participants: step.participants.filter((p) => p !== slot),
        perAgentPrompts,
      };
    }
    return { participants: [...step.participants, slot] };
  });
}

export function setStepPerAgentPrompt(
  state: StrategyFormState,
  stepIndex: number,
  slot: string,
  prompt: string,
): StrategyFormState {
  return patchStep(state, stepIndex, (step) => {
    const perAgentPrompts: Record<string, string> = {};
    for (const [key, value] of Object.entries(step.perAgentPrompts)) {
      if (key !== slot) perAgentPrompts[key] = value;
    }
    // Empty means "no override" and is omitted from the serialized JSON.
    if (prompt !== "") perAgentPrompts[slot] = prompt;
    return { perAgentPrompts };
  });
}

/** Move one participant within a phase's response order. */
export function moveStepParticipant(
  state: StrategyFormState,
  stepIndex: number,
  from: number,
  to: number,
): StrategyFormState {
  return patchStep(state, stepIndex, (step) => {
    const last = step.participants.length - 1;
    if (from === to || from < 0 || from > last || to < 0 || to > last) {
      return {};
    }
    const participants = [...step.participants];
    const [moved] = participants.splice(from, 1);
    if (moved === undefined) return {};
    participants.splice(to, 0, moved);
    return { participants };
  });
}

// ── Serialization (form state -> kind:44020 content) ──────────────────────

/**
 * Produce the exact kind:44020 content object. `perAgentPrompts` is
 * omitted when a phase has no non-empty overrides (the CLI field is
 * `skip_serializing_if = "Option::is_none"`), and `parentStrategy` is
 * omitted when blank (the CLI field is optional and rejects an empty
 * string). Strings are written verbatim — bounds are enforced by
 * `validateStrategyState`, matching `strategy put`'s validate-then-sign
 * order.
 */
export function toStrategyJson(state: StrategyFormState): StrategyJson {
  const roles: Record<string, string> = {};
  for (const row of state.roles) {
    roles[row.slot] = row.prompt;
  }
  const steps: StrategyStepJson[] = state.steps.map((step) => {
    const perAgentPrompts: Record<string, string> = {};
    for (const [slot, prompt] of Object.entries(step.perAgentPrompts)) {
      if (!isBlank(prompt)) perAgentPrompts[slot] = prompt;
    }
    const json: StrategyStepJson = {
      participants: [...step.participants],
      rounds: step.rounds,
      flow: step.flow,
      prompt: step.prompt,
    };
    if (Object.keys(perAgentPrompts).length > 0) {
      json.perAgentPrompts = perAgentPrompts;
    }
    return json;
  });
  const json: StrategyJson = {
    v: STRATEGY_SCHEMA_VERSION,
    name: state.name,
    description: state.description,
    teamworkPrompt: state.teamworkPrompt,
    roles,
    steps,
    finalWriter: state.finalWriter,
  };
  if (!isBlank(state.parentStrategy)) {
    json.parentStrategy = state.parentStrategy;
  }
  return json;
}

// ── Parsing (kind:44020 content -> form state) ────────────────────────────

/**
 * Coerce an untrusted strategy-shaped value into form state, fail-soft on
 * every field (empty/partial/foreign shapes must never crash the React
 * shell). Structured junk falls back to defaults; `flow` and `rounds` keep
 * raw values so `validateStrategyState` can flag them instead of silently
 * reinterpreting meaning. The id lives outside the content JSON and is
 * passed separately.
 */
export function strategyStateFromJson(
  value: unknown,
  options: { id?: string } = {},
): StrategyFormState {
  const obj = asRecord(value);
  const roles: StrategyRoleRow[] = [];
  for (const [slot, prompt] of Object.entries(asRecord(obj.roles))) {
    roles.push({ slot, prompt: scalarString(prompt) });
  }
  const steps: StrategyStepRow[] = [];
  const stepsRaw = Array.isArray(obj.steps) ? obj.steps : [];
  for (const raw of stepsRaw) {
    const step = asRecord(raw);
    const participants = Array.isArray(step.participants)
      ? step.participants.filter((p): p is string => typeof p === "string")
      : [];
    let rounds = Number.NaN;
    if (typeof step.rounds === "number") {
      rounds = step.rounds;
    } else if (
      typeof step.rounds === "string" &&
      step.rounds.trim() !== "" &&
      Number.isFinite(Number(step.rounds))
    ) {
      // Lossless numeric-string normalization (a typed "3" means 3).
      rounds = Number(step.rounds);
    }
    const perAgentPrompts: Record<string, string> = {};
    for (const [slot, prompt] of Object.entries(
      asRecord(step.perAgentPrompts),
    )) {
      const text = scalarString(prompt);
      if (text !== "") perAgentPrompts[slot] = text;
    }
    steps.push({
      participants,
      rounds,
      flow: typeof step.flow === "string" ? step.flow : "",
      prompt: scalarString(step.prompt),
      perAgentPrompts,
    });
  }
  return {
    id: options.id ?? "",
    name: scalarString(obj.name),
    description: scalarString(obj.description),
    teamworkPrompt: scalarString(obj.teamworkPrompt),
    roles,
    steps,
    finalWriter: scalarString(obj.finalWriter),
    parentStrategy: scalarString(obj.parentStrategy),
  };
}

/**
 * Parse raw JSON text (the "Advanced JSON" editor) into form state. The id
 * is not part of the content JSON and is carried over by the caller.
 */
export function parseStrategyJsonText(
  text: string,
  options: { id?: string } = {},
): { ok: true; state: StrategyFormState } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    return {
      ok: false,
      error: `Not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Strategy must be a JSON object." };
  }
  return { ok: true, state: strategyStateFromJson(parsed, options) };
}

// ── Validation (mirrors TeamStrategy::validate + the `put --id` bound) ────

/**
 * Strict, field-level mirror of the CLI's strategy schema. Returns one
 * message per offending field path; an empty object means the state
 * serializes to a strategy `buzz team strategy put` would accept (modulo
 * the duplicate-slot check, a form-only guard explained below).
 */
export function validateStrategyState(
  state: StrategyFormState,
): StrategyFieldErrors {
  const errors: StrategyFieldErrors = {};

  const requireBounded = (
    key: string,
    label: string,
    value: string,
    max: number,
  ) => {
    const n = charCount(value);
    if (isBlank(value)) {
      errors[key] = `${label} is required`;
    } else if (n > max) {
      errors[key] = `${label} must be 1..=${max} chars (got ${n})`;
    }
  };
  const optionalBounded = (
    key: string,
    label: string,
    value: string,
    max: number,
  ) => {
    if (value === "") return;
    const n = charCount(value);
    if (isBlank(value)) {
      errors[key] = `${label} must not be only whitespace`;
    } else if (n > max) {
      errors[key] = `${label} must be 1..=${max} chars (got ${n})`;
    }
  };

  // `strategy put --id`: 1..=64 chars after trimming.
  requireBounded("id", "`id`", state.id.trim(), STRATEGY_ID_MAX_CHARS);
  requireBounded("name", "`name`", state.name, STRATEGY_NAME_MAX_CHARS);
  requireBounded(
    "description",
    "`description`",
    state.description,
    STRATEGY_DESC_MAX_CHARS,
  );
  requireBounded(
    "teamworkPrompt",
    "`teamworkPrompt`",
    state.teamworkPrompt,
    TEAMWORK_PROMPT_MAX_CHARS,
  );
  optionalBounded(
    "parentStrategy",
    "`parentStrategy`",
    state.parentStrategy,
    PARENT_STRATEGY_MAX_CHARS,
  );

  // Roster: 1..=6 slots with unique names and bounded prompts. The CLI
  // deserializes `roles` into a map (duplicate JSON keys collapse), so the
  // form flags duplicates that would otherwise vanish silently.
  if (state.roles.length < 1 || state.roles.length > MAX_ROSTER_SLOTS) {
    errors.roles = `\`roles\` must have 1..=${MAX_ROSTER_SLOTS} slot(s) (got ${state.roles.length})`;
  }
  const seenSlots = new Set<string>();
  for (const [index, row] of state.roles.entries()) {
    const slotKey = `roles[${index}].slot`;
    const promptKey = `roles[${index}].prompt`;
    requireBounded(slotKey, "Role slot name", row.slot, SLOT_NAME_MAX_CHARS);
    if (!errors[slotKey] && seenSlots.has(row.slot)) {
      errors[slotKey] =
        `Role slot name ${JSON.stringify(row.slot)} is used more than once`;
    }
    seenSlots.add(row.slot);
    requireBounded(promptKey, "Role prompt", row.prompt, ROLE_PROMPT_MAX_CHARS);
  }

  // Phases: 1..=6, each bounded as in the CLI.
  if (state.steps.length < 1 || state.steps.length > MAX_PHASES) {
    errors.steps = `\`steps\` must have 1..=${MAX_PHASES} phase(s) (got ${state.steps.length})`;
  }
  for (const [index, step] of state.steps.entries()) {
    const label = `steps[${index}]`;
    const participantsKey = `${label}.participants`;
    if (
      step.participants.length < 1 ||
      step.participants.length > MAX_PARTICIPANTS
    ) {
      errors[participantsKey] =
        `Participants must have 1..=${MAX_PARTICIPANTS} slot(s) (got ${step.participants.length})`;
    } else {
      const unknown = step.participants.find((slot) => !seenSlots.has(slot));
      if (unknown !== undefined) {
        errors[participantsKey] =
          `Participant ${JSON.stringify(unknown)} is not a defined role slot`;
      }
    }
    if (
      !Number.isInteger(step.rounds) ||
      step.rounds < 1 ||
      step.rounds > MAX_ROUNDS
    ) {
      errors[`${label}.rounds`] =
        `Rounds must be 1..=${MAX_ROUNDS} (got ${Number.isNaN(step.rounds) ? "none" : step.rounds})`;
    }
    if (step.flow !== "local" && step.flow !== "summary") {
      errors[`${label}.flow`] =
        `Flow must be "local" or "summary" (got ${JSON.stringify(step.flow)})`;
    }
    requireBounded(
      `${label}.prompt`,
      "Phase prompt",
      step.prompt,
      STEP_PROMPT_MAX_CHARS,
    );
    for (const [slot, prompt] of Object.entries(step.perAgentPrompts)) {
      const promptKey = `${label}.perAgentPrompts[${slot}]`;
      if (!step.participants.includes(slot)) {
        errors[promptKey] =
          `Per-agent prompt names ${JSON.stringify(slot)}, which is not a participant of this phase`;
        continue;
      }
      optionalBounded(
        promptKey,
        "Per-agent prompt",
        prompt,
        STEP_PROMPT_MAX_CHARS,
      );
    }
  }

  // The final writer must come from the roster.
  if (!seenSlots.has(state.finalWriter)) {
    errors.finalWriter = `\`finalWriter\` must be a defined role slot (got ${JSON.stringify(state.finalWriter)})`;
  }

  return errors;
}

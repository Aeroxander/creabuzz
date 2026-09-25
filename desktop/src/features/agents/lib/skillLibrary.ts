/**
 * Skill-library UI derivations.
 *
 * Everything here is renderer-free and command-free: the panel and dialogs
 * render these results, and the unit tests pin the copy and the cap maths.
 * The numbers mirror the harness bounds exactly —
 * `crates/buzz-acp/src/project_skills.rs` (`MAX_SKILL_BINDINGS`,
 * `MAX_PROJECT_SKILL_BYTES`, `TRUNCATION_MARKER`) — because the whole point of
 * the cap warning is to tell the truth about truncation BEFORE the harness
 * appends the marker.
 */

/** Harness injection cap on `["skill", …]` tags per agent. */
export const SKILL_BINDING_CAP = 64;
/** Harness injection cap on total injected skill content (bytes). */
export const SKILL_BYTES_CAP = 65_536;
/** Warn at 7/8 of each cap — the last eighth is the "you're about to lose
 * bindings/content" zone, not a surprise. */
export const SKILL_BINDING_WARN_AT = 56;
export const SKILL_BYTES_WARN_AT = 57_344;

/** The marker `buzz-acp` appends when the byte cap cuts the section. Quoted
 * verbatim in the warning so the user recognises it if they hit it. */
export const SKILL_TRUNCATION_MARKER =
  "[project-skills: truncated — 65536-byte total skill cap reached]";

export const SKILL_SCOPES = ["all", "developers"] as const;
export type SkillScope = (typeof SKILL_SCOPES)[number];

export type SkillBinding = {
  skillId: string;
  scope: string;
  /** True for a tag the harness drops (wrong arity or unknown scope). Shown,
   * never hidden — a silently missing binding reads as "it never applied". */
  invalid: boolean;
};

export type ProjectSkill = {
  id: string;
  eventId: string;
  name: string;
  description: string;
  sha256: string;
  source: string | null;
  appliesTo: string | null;
  contentBytes: number;
  createdAt: number;
  author: string;
  own: boolean;
};

export type AgentSkillBindings = {
  personaId: string;
  displayName: string;
  canBind: boolean;
  bindings: SkillBinding[];
  /** Set when the agent's head exists but cannot be read: bindings are
   * UNKNOWN, not empty. */
  readError?: string;
};

export type SkillPublicationStatus = "published" | "queued" | "unchanged";

export type SkillBindingChangeResult = {
  publicationStatus: SkillPublicationStatus;
  relayMessage?: string;
  changed: boolean;
  bindings: SkillBinding[];
};

export type SkillBindingChange =
  | { type: "bind"; skillId: string; scope: SkillScope }
  | { type: "unbind"; skillId: string }
  | { type: "clear" };

export type SkillLibraryState = "loading" | "error" | "ready" | "empty";

/**
 * Derive the section's single presentation state. A skills error wins over
 * "there are no skills": an unreachable relay must never render as an empty
 * library (rule: a terminal failure is not an authoritative empty result).
 */
export function deriveSkillLibraryState(input: {
  isLoading: boolean;
  skillsError: string | null;
  bindingsError: string | null;
  skills: readonly ProjectSkill[];
}): SkillLibraryState {
  if (input.skillsError !== null || input.bindingsError !== null) {
    return "error";
  }
  if (input.isLoading) {
    return "loading";
  }
  return input.skills.length === 0 ? "empty" : "ready";
}

/** First 8 hex chars of the sha pin, with the algorithm named. */
export function shortSha(sha256: string): string {
  const trimmed = sha256.trim();
  if (trimmed.length === 0) return "sha256: unknown";
  return `sha256:${trimmed.slice(0, 8)}`;
}

export function scopeLabel(scope: string): string {
  switch (scope) {
    case "developers":
      return "developer work";
    case "all":
      return "all work";
    default:
      return scope;
  }
}

/** One agent's view of one binding — `skill` is null when the id is not in
 * the fetched library (beyond the bounded page read, or since deleted). The
 * row still renders: a binding that references an unknown skill must not
 * vanish, or "3 bound skills" stops matching what the harness sees. */
export type BindingRow = {
  skillId: string;
  scope: string;
  invalid: boolean;
  skill: ProjectSkill | null;
};

export function bindingRows(
  agent: Pick<AgentSkillBindings, "bindings">,
  skills: readonly ProjectSkill[],
): BindingRow[] {
  const byId = skillsById(skills);
  return agent.bindings.map((binding) => ({
    skillId: binding.skillId,
    scope: binding.scope,
    invalid: binding.invalid,
    skill: byId.get(binding.skillId) ?? null,
  }));
}

export function skillsById(
  skills: readonly ProjectSkill[],
): Map<string, ProjectSkill> {
  const byId = new Map<string, ProjectSkill>();
  for (const skill of skills) {
    // First entry wins: the newest head is first after the backend's
    // created_at sort, which matches the harness's owner-head preference.
    if (!byId.has(skill.id)) byId.set(skill.id, skill);
  }
  return byId;
}

/** Which agents are bound to each skill. Only valid bindings count — an
 * invalid tag is dropped by the harness, so it is not "bound". */
export function agentsBoundToSkill(
  skillId: string,
  agents: readonly AgentSkillBindings[],
): AgentSkillBindings[] {
  return agents.filter((agent) =>
    agent.bindings.some(
      (binding) => binding.skillId === skillId && !binding.invalid,
    ),
  );
}

export type CapWarning = {
  level: "ok" | "near" | "at" | "unknown";
  message: string | null;
  bindingCount: number;
  /** Sum of bound skill content bytes, or null when at least one bound skill
   * is missing from the library — the honest "can't compute" case. */
  boundBytes: number | null;
};

/**
 * The cap-honesty derivation. Surfaces the harness's two bounds and what
 * happens when they are crossed, before the user crosses them.
 */
export function skillBindingCapWarning(
  agent: Pick<AgentSkillBindings, "bindings">,
  skills: readonly ProjectSkill[],
): CapWarning {
  const rows = bindingRows(agent, skills);
  const bindingCount = agent.bindings.length;
  const allKnown = rows.every((row) => row.skill !== null);
  const boundBytes = allKnown
    ? rows.reduce((sum, row) => sum + (row.skill?.contentBytes ?? 0), 0)
    : null;

  if (
    bindingCount >= SKILL_BINDING_CAP ||
    (boundBytes ?? 0) >= SKILL_BYTES_CAP
  ) {
    return {
      level: "at",
      message: `At the harness limit: ${SKILL_BINDING_CAP} bindings or ${SKILL_BYTES_CAP} bytes of skills. Anything past it is dropped at injection, and the skill section ends with the marker ${SKILL_TRUNCATION_MARKER}.`,
      bindingCount,
      boundBytes,
    };
  }
  if (
    bindingCount >= SKILL_BINDING_WARN_AT ||
    (boundBytes ?? 0) >= SKILL_BYTES_WARN_AT
  ) {
    return {
      level: "near",
      message: `Near the harness limit: ${bindingCount} of ${SKILL_BINDING_CAP} bindings and ${formatKib(boundBytes)} of ${formatKib(SKILL_BYTES_CAP)}. Past these, bindings or skill content are dropped at injection.`,
      bindingCount,
      boundBytes,
    };
  }
  if (!allKnown) {
    return {
      level: "unknown",
      message:
        "One or more bound skills aren't in the local library list, so this agent's total skill size can't be computed.",
      bindingCount,
      boundBytes,
    };
  }
  return { level: "ok", message: null, bindingCount, boundBytes };
}

function formatKib(bytes: number | null): string {
  if (bytes === null) return "an unknown size";
  return `≈${Math.ceil(bytes / 1024)} KiB`;
}

/** The consequence sentence shown before and after an unbind — the honest
 * "what this actually does" line, keyed to the harness's per-session
 * injection (a bound skill loads on the NEXT session, not retroactively). */
export function unbindConsequence(
  agentDisplayName: string,
  skillName: string,
): string {
  return `${agentDisplayName} will stop loading '${skillName}' on its next session.`;
}

export function bindConsequence(
  agentDisplayName: string,
  skillName: string,
): string {
  return `${agentDisplayName} will load '${skillName}' on its next session.`;
}

/** A `queued` outcome means the durable local head changed but the relay has
 * not taken it yet. Said out loud, never folded into a success claim. */
export function queuedSuffix(relayMessage: string | null | undefined): string {
  const detail = relayMessage?.trim();
  return detail
    ? ` Saved locally; the relay hasn't accepted it yet (${detail}).`
    : " Saved locally; the relay hasn't accepted it yet — it stays queued for retry.";
}

export function bindingNotice(
  change: SkillBindingChange,
  agentDisplayName: string,
  skillName: string,
  result: SkillBindingChangeResult,
): string {
  const consequence =
    change.type === "unbind" || change.type === "clear"
      ? unbindConsequence(agentDisplayName, skillName)
      : bindConsequence(agentDisplayName, skillName);
  if (result.publicationStatus === "queued") {
    return consequence + queuedSuffix(result.relayMessage);
  }
  if (result.publicationStatus === "unchanged") {
    return `No change — ${agentDisplayName} already had '${skillName}' bound exactly as requested.`;
  }
  return consequence;
}

/** Clear-all consequence: plural, since no single skill names the change. */
export function clearNotice(
  agentDisplayName: string,
  result: SkillBindingChangeResult,
): string {
  const consequence = `${agentDisplayName} will stop loading all of its skills on its next session.`;
  if (result.publicationStatus === "queued") {
    return consequence + queuedSuffix(result.relayMessage);
  }
  if (result.publicationStatus === "unchanged") {
    return `No change — ${agentDisplayName} has no skills bound.`;
  }
  return consequence;
}

export type SkillSourceInput = {
  url: string;
  pasted: string;
};

export type ParsedSkillSource =
  | { source: { kind: "paste"; value: string }; error: null }
  | { source: { kind: "url"; value: string }; error: null }
  | { source: null; error: string };

/**
 * Decide what to publish from the two inputs. Pasted text wins (it is the
 * more deliberate act); a URL must be https, matching the backend's fetch
 * contract so the client-side error and the command's error agree.
 */
export function parseSkillSource(input: SkillSourceInput): ParsedSkillSource {
  const pasted = input.pasted.trim();
  const url = input.url.trim();
  if (pasted.length > 0) {
    return { source: { kind: "paste", value: pasted }, error: null };
  }
  if (url.length === 0) {
    return { source: null, error: "Paste a SKILL.md or give its URL." };
  }
  if (!url.startsWith("https://")) {
    return { source: null, error: "Skill URLs must use https://." };
  }
  return { source: { kind: "url", value: url }, error: null };
}

/** Skills this agent can newly bind: everything in the library that it does
 * not already hold a valid binding for. */
export function bindableSkills(
  agent: Pick<AgentSkillBindings, "bindings">,
  skills: readonly ProjectSkill[],
): ProjectSkill[] {
  const bound = new Set(agent.bindings.map((binding) => binding.skillId));
  return skills.filter((skill) => !bound.has(skill.id));
}

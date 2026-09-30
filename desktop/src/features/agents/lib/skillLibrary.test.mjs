import assert from "node:assert/strict";
import test from "node:test";

import {
  agentsBoundToSkill,
  bindingNotice,
  bindingRows,
  bindableSkills,
  bindConsequence,
  clearNotice,
  deriveSkillLibraryState,
  parseSkillSource,
  queuedSuffix,
  scopeLabel,
  shortSha,
  skillBindingCapWarning,
  SKILL_BINDING_CAP,
  SKILL_BINDING_WARN_AT,
  SKILL_BYTES_CAP,
  SKILL_BYTES_WARN_AT,
  SKILL_TRUNCATION_MARKER,
  unbindConsequence,
} from "./skillLibrary.ts";

/** @returns {import("./skillLibrary.ts").ProjectSkill} */
function skill(id, contentBytes = 1_000) {
  return {
    id,
    eventId: `event-${id}`,
    name: id,
    description: `${id} description`,
    sha256: "abcdef0123456789fedcba",
    source: `https://example.com/${id}/SKILL.md`,
    appliesTo: "all",
    contentBytes,
    createdAt: 1_700_000_000,
    author: "owner-pubkey",
    own: true,
  };
}

/** @returns {import("./skillLibrary.ts").AgentSkillBindings} */
function agent(bindings, overrides = {}) {
  return {
    personaId: "catalog-reviewer",
    displayName: "Catalog Reviewer",
    canBind: true,
    bindings,
    ...overrides,
  };
}

test("an error state never renders as an empty library", () => {
  assert.equal(
    deriveSkillLibraryState({
      isLoading: false,
      skillsError: "relay unreachable",
      bindingsError: null,
      skills: [],
    }),
    "error",
  );
  assert.equal(
    deriveSkillLibraryState({
      isLoading: false,
      skillsError: null,
      bindingsError: "retention store unavailable",
      skills: [skill("a")],
    }),
    "error",
    "an unreadable bindings list is an error, not a ready section",
  );
  assert.equal(
    deriveSkillLibraryState({
      isLoading: true,
      skillsError: null,
      bindingsError: null,
      skills: [],
    }),
    "loading",
  );
  assert.equal(
    deriveSkillLibraryState({
      isLoading: false,
      skillsError: null,
      bindingsError: null,
      skills: [],
    }),
    "empty",
  );
  assert.equal(
    deriveSkillLibraryState({
      isLoading: false,
      skillsError: null,
      bindingsError: null,
      skills: [skill("a")],
    }),
    "ready",
  );
});

test("short_sha_pins_the_first_eight_hex_chars", () => {
  assert.equal(shortSha("abcdef0123456789"), "sha256:abcdef01");
  assert.equal(shortSha("  "), "sha256: unknown");
});

test("scope_labels_read_as_work_scopes", () => {
  assert.equal(scopeLabel("all"), "all work");
  assert.equal(scopeLabel("developers"), "developer work");
  // An unknown scope is rendered verbatim rather than silently relabelled —
  // it is a scope the harness would drop, and the user should see the raw value.
  assert.equal(scopeLabel("everywhere"), "everywhere");
});

test("a_binding_to_a_skill_outside_the_fetched_library_stays_visible", () => {
  const rows = bindingRows(
    agent([
      { skillId: "present", scope: "all", invalid: false },
      { skillId: "deleted-later", scope: "developers", invalid: false },
    ]),
    [skill("present")],
  );
  assert.equal(rows.length, 2, "the row must not vanish");
  assert.equal(rows[0].skill?.id, "present");
  assert.equal(rows[1].skill, null);
  assert.equal(rows[1].skillId, "deleted-later");
});

test("only_valid_bindings_count_as_bound_to_a_skill", () => {
  const agents = [
    agent([{ skillId: "ethereum-dev", scope: "all", invalid: false }]),
    agent([{ skillId: "ethereum-dev", scope: "", invalid: true }]),
    agent([{ skillId: "other", scope: "all", invalid: false }]),
  ];
  assert.deepEqual(
    agentsBoundToSkill("ethereum-dev", agents).map((entry) => entry.personaId),
    ["catalog-reviewer"],
    "the harness drops invalid tags, so they are not a binding",
  );
});

test("bindable_skills_excludes_current_bindings", () => {
  const bound = bindableSkills(
    agent([{ skillId: "a", scope: "all", invalid: false }]),
    [skill("a"), skill("b")],
  );
  assert.deepEqual(
    bound.map((entry) => entry.id),
    ["b"],
  );
});

test("cap_warning_is_quiet_while_the_agent_has_room", () => {
  const warning = skillBindingCapWarning(
    agent([{ skillId: "a", scope: "all", invalid: false }]),
    [skill("a", 1_000)],
  );
  assert.equal(warning.level, "ok");
  assert.equal(warning.message, null);
  assert.equal(warning.bindingCount, 1);
  assert.equal(warning.boundBytes, 1_000);
});

test("cap_warning_fires_before_the_binding_cap", () => {
  const near = Array.from({ length: SKILL_BINDING_WARN_AT }, (_, index) => ({
    skillId: `s${index}`,
    scope: "all",
    invalid: false,
  }));
  const warning = skillBindingCapWarning(agent(near), []);
  assert.equal(warning.level, "near");
  assert.match(
    warning.message,
    new RegExp(`${SKILL_BINDING_WARN_AT} of ${SKILL_BINDING_CAP}`),
  );

  const at = Array.from({ length: SKILL_BINDING_CAP }, (_, index) => ({
    skillId: `s${index}`,
    scope: "all",
    invalid: false,
  }));
  const capped = skillBindingCapWarning(agent(at), []);
  assert.equal(capped.level, "at");
  assert.match(
    capped.message,
    new RegExp(SKILL_TRUNCATION_MARKER.replace(/[[\]—]/g, "\\$&")),
  );
});

test("cap_warning_counts_bound_content_bytes", () => {
  const nearBytes = skillBindingCapWarning(
    agent([{ skillId: "big", scope: "all", invalid: false }]),
    [skill("big", SKILL_BYTES_WARN_AT)],
  );
  assert.equal(nearBytes.level, "near");
  assert.equal(nearBytes.boundBytes, SKILL_BYTES_WARN_AT);

  const atBytes = skillBindingCapWarning(
    agent([{ skillId: "big", scope: "all", invalid: false }]),
    [skill("big", SKILL_BYTES_CAP)],
  );
  assert.equal(atBytes.level, "at");
  assert.match(atBytes.message, new RegExp(`${SKILL_BYTES_CAP} bytes`));
});

test("an_unresolvable_bound_skill_reports_an_unknown_total_instead_of_a_guess", () => {
  const warning = skillBindingCapWarning(
    agent([
      { skillId: "in-library", scope: "all", invalid: false },
      { skillId: "not-in-library", scope: "all", invalid: false },
    ]),
    [skill("in-library", 1_000)],
  );
  assert.equal(warning.level, "unknown");
  assert.equal(warning.boundBytes, null, "must not pretend the total is 1000");
  assert.match(warning.message, /can't be computed/);
});

test("the_unbind_consequence_names_the_agent_the_skill_and_the_next_session", () => {
  assert.equal(
    unbindConsequence("Catalog Reviewer", "ethereum-dev"),
    "Catalog Reviewer will stop loading 'ethereum-dev' on its next session.",
  );
  assert.equal(
    bindConsequence("Catalog Reviewer", "ethereum-dev"),
    "Catalog Reviewer will load 'ethereum-dev' on its next session.",
  );
});

test("a_queued_unbind_never_claims_the_relay_took_it", () => {
  const notice = bindingNotice(
    { type: "unbind", skillId: "ethereum-dev" },
    "Catalog Reviewer",
    "ethereum-dev",
    {
      publicationStatus: "queued",
      relayMessage: "relay rejected event: rate-limited",
      changed: true,
      bindings: [],
    },
  );
  assert.match(
    notice,
    /will stop loading 'ethereum-dev' on its next session\./,
  );
  assert.match(notice, /hasn't accepted it yet/);
  assert.match(notice, /rate-limited/);
  assert.ok(
    !/^Published/i.test(notice),
    "a queued edit must not read as an accepted publish",
  );

  const fallback = queuedSuffix(null);
  assert.match(fallback, /stays queued for retry/);
});

test("a_published_unbind_states_the_consequence_without_queue_noise", () => {
  const notice = bindingNotice(
    { type: "unbind", skillId: "ethereum-dev" },
    "Catalog Reviewer",
    "ethereum-dev",
    {
      publicationStatus: "published",
      changed: true,
      bindings: [],
    },
  );
  assert.equal(
    notice,
    "Catalog Reviewer will stop loading 'ethereum-dev' on its next session.",
  );
});

test("an_unchanged_edit_says_nothing_changed", () => {
  const notice = bindingNotice(
    { type: "bind", skillId: "review", scope: "all" },
    "Catalog Reviewer",
    "review",
    {
      publicationStatus: "unchanged",
      changed: false,
      bindings: [{ skillId: "review", scope: "all", invalid: false }],
    },
  );
  assert.match(notice, /^No change/);
});

test("clear_all_states_the_plural_consequence_and_flags_a_queued_relay", () => {
  assert.equal(
    clearNotice("Catalog Reviewer", {
      publicationStatus: "published",
      changed: true,
      bindings: [],
    }),
    "Catalog Reviewer will stop loading all of its skills on its next session.",
  );
  const queued = clearNotice("Catalog Reviewer", {
    publicationStatus: "queued",
    relayMessage: "relay unreachable",
    changed: true,
    bindings: [],
  });
  assert.match(queued, /hasn't accepted it yet \(relay unreachable\)/);
  assert.match(
    clearNotice("Catalog Reviewer", {
      publicationStatus: "unchanged",
      changed: false,
      bindings: [],
    }),
    /^No change/,
  );
});

test("pasted_content_wins_over_a_url_and_urls_must_be_https", () => {
  assert.deepEqual(
    parseSkillSource({ url: "https://x/SKILL.md", pasted: "# pasted\n" }),
    { source: { kind: "paste", value: "# pasted" }, error: null },
  );
  assert.deepEqual(
    parseSkillSource({ url: "https://x/SKILL.md", pasted: "" }),
    {
      source: { kind: "url", value: "https://x/SKILL.md" },
      error: null,
    },
  );
  const empty = parseSkillSource({ url: "", pasted: "   " });
  assert.equal(empty.source, null);
  assert.match(empty.error, /Paste a SKILL\.md/);
  const insecure = parseSkillSource({ url: "http://x/SKILL.md", pasted: "" });
  assert.equal(insecure.source, null);
  assert.match(insecure.error, /https:\/\//);
});

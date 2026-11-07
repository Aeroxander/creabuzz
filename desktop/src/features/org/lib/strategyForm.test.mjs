// Unit tests for the strategy (kind:44020) form seam: serialization,
// defensive parsing, the strict bound mirror of the CLI's
// TeamStrategy::validate, and the removal-path reference cleanup.
// Pure logic only — the React shell drives exactly these functions.
// Run with: node --import ./test-loader.mjs --experimental-strip-types --test src/features/org/lib/strategyForm.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_PHASES,
  MAX_ROSTER_SLOTS,
  STRATEGY_DESC_MAX_CHARS,
  STRATEGY_ID_MAX_CHARS,
  STRATEGY_NAME_MAX_CHARS,
  SLOT_NAME_MAX_CHARS,
  ROLE_PROMPT_MAX_CHARS,
  STEP_PROMPT_MAX_CHARS,
  TEAMWORK_PROMPT_MAX_CHARS,
  PARENT_STRATEGY_MAX_CHARS,
  addRole,
  addStep,
  charCount,
  defaultStrategyState,
  moveStepParticipant,
  parseStrategyJsonText,
  removeRole,
  removeStep,
  renameRole,
  setRolePrompt,
  setStepPerAgentPrompt,
  suggestStrategyId,
  toStrategyJson,
  strategyStateFromJson,
  toggleStepParticipant,
  validateStrategyState,
} from "./strategyForm.ts";

/** A state the CLI would accept as-is. */
function validState() {
  return {
    id: "mechanistic-step-audit",
    name: "Mechanistic step audit",
    description: "AIME-2024 bank strategy.",
    teamworkPrompt: "Audit every step.",
    roles: [
      { slot: "agent-0", prompt: "Independent solver and step auditor." },
      { slot: "agent-1", prompt: "Consensus challenger." },
    ],
    steps: [
      {
        participants: ["agent-1", "agent-0"],
        rounds: 1,
        flow: "local",
        prompt: "Audit the reasoning chains step by step.",
        perAgentPrompts: { "agent-1": "Challenge every consensus." },
      },
    ],
    finalWriter: "agent-1",
    parentStrategy: "",
  };
}

describe("validateStrategyState — full bound space (mirrors TeamStrategy::validate)", () => {
  it("accepts a valid state with no errors", () => {
    assert.deepEqual(validateStrategyState(validState()), {});
  });

  it("flags exactly the unfilled fields of the default scaffold", () => {
    assert.deepEqual(validateStrategyState(defaultStrategyState()), {
      id: "`id` is required",
      name: "`name` is required",
      description: "`description` is required",
      teamworkPrompt: "`teamworkPrompt` is required",
      "roles[0].prompt": "Role prompt is required",
      "steps[0].prompt": "Phase prompt is required",
    });
  });

  const cases = [
    // id (`strategy put --id`, trimmed 1..=64)
    {
      label: "id at 64 chars passes",
      patch: { id: "i".repeat(STRATEGY_ID_MAX_CHARS) },
      key: "id",
      want: false,
    },
    {
      label: "id over 64 chars fails",
      patch: { id: "i".repeat(STRATEGY_ID_MAX_CHARS + 1) },
      key: "id",
      want: true,
    },
    { label: "id blank fails", patch: { id: "   " }, key: "id", want: true },
    // name 1..=128
    {
      label: "name at 128 chars passes",
      patch: { name: "n".repeat(STRATEGY_NAME_MAX_CHARS) },
      key: "name",
      want: false,
    },
    {
      label: "name over 128 chars fails",
      patch: { name: "n".repeat(STRATEGY_NAME_MAX_CHARS + 1) },
      key: "name",
      want: true,
      message: "`name` must be 1..=128 chars (got 129)",
    },
    {
      label: "name blank fails",
      patch: { name: "  " },
      key: "name",
      want: true,
    },
    // description 1..=1024
    {
      label: "description at 1024 chars passes",
      patch: { description: "d".repeat(STRATEGY_DESC_MAX_CHARS) },
      key: "description",
      want: false,
    },
    {
      label: "description over 1024 chars fails",
      patch: { description: "d".repeat(STRATEGY_DESC_MAX_CHARS + 1) },
      key: "description",
      want: true,
    },
    {
      label: "description blank fails",
      patch: { description: "" },
      key: "description",
      want: true,
    },
    // teamworkPrompt 1..=8192
    {
      label: "teamworkPrompt at 8192 chars passes",
      patch: { teamworkPrompt: "t".repeat(TEAMWORK_PROMPT_MAX_CHARS) },
      key: "teamworkPrompt",
      want: false,
    },
    {
      label: "teamworkPrompt over 8192 chars fails",
      patch: { teamworkPrompt: "t".repeat(TEAMWORK_PROMPT_MAX_CHARS + 1) },
      key: "teamworkPrompt",
      want: true,
    },
    // parentStrategy optional 1..=64
    {
      label: "parentStrategy at 64 chars passes",
      patch: { parentStrategy: "p".repeat(PARENT_STRATEGY_MAX_CHARS) },
      key: "parentStrategy",
      want: false,
    },
    {
      label: "parentStrategy over 64 chars fails",
      patch: { parentStrategy: "p".repeat(PARENT_STRATEGY_MAX_CHARS + 1) },
      key: "parentStrategy",
      want: true,
    },
    {
      label: "parentStrategy whitespace-only fails",
      patch: { parentStrategy: " " },
      key: "parentStrategy",
      want: true,
    },
    {
      label: "parentStrategy empty is omitted, not an error",
      patch: { parentStrategy: "" },
      key: "parentStrategy",
      want: false,
    },
    // roles count 1..=6
    {
      label: "6 roster slots pass",
      patch: {
        roles: Array.from({ length: MAX_ROSTER_SLOTS }, (_, i) => ({
          slot: `s${i}`,
          prompt: "p",
        })),
        steps: [
          {
            participants: ["s0"],
            rounds: 1,
            flow: "local",
            prompt: "p",
            perAgentPrompts: {},
          },
        ],
        finalWriter: "s0",
      },
      key: "roles",
      want: false,
    },
    {
      label: "7 roster slots fail",
      patch: {
        roles: Array.from({ length: MAX_ROSTER_SLOTS + 1 }, (_, i) => ({
          slot: `s${i}`,
          prompt: "p",
        })),
      },
      key: "roles",
      want: true,
      message: "`roles` must have 1..=6 slot(s) (got 7)",
    },
    {
      label: "0 roster slots fail",
      patch: { roles: [] },
      key: "roles",
      want: true,
    },
    // slot name 1..=32
    {
      label: "slot name at 32 chars passes",
      patch: {
        roles: [
          { slot: "s".repeat(SLOT_NAME_MAX_CHARS), prompt: "p" },
          { slot: "agent-1", prompt: "p" },
        ],
        steps: [
          {
            participants: ["agent-1"],
            rounds: 1,
            flow: "local",
            prompt: "p",
            perAgentPrompts: {},
          },
        ],
        finalWriter: "agent-1",
      },
      key: "roles[0].slot",
      want: false,
    },
    {
      label: "slot name over 32 chars fails",
      patch: {
        roles: [
          { slot: "s".repeat(SLOT_NAME_MAX_CHARS + 1), prompt: "p" },
          { slot: "agent-1", prompt: "p" },
        ],
      },
      key: "roles[0].slot",
      want: true,
    },
    {
      label: "slot name blank fails",
      patch: { roles: [{ slot: "", prompt: "p" }, validState().roles[1]] },
      key: "roles[0].slot",
      want: true,
    },
    {
      label: "duplicate slot names fail",
      patch: {
        roles: [
          { slot: "agent-0", prompt: "p" },
          { slot: "agent-0", prompt: "q" },
        ],
        steps: [
          {
            participants: ["agent-0"],
            rounds: 1,
            flow: "local",
            prompt: "p",
            perAgentPrompts: {},
          },
        ],
        finalWriter: "agent-0",
      },
      key: "roles[1].slot",
      want: true,
    },
    // role prompt 1..=4096
    {
      label: "role prompt at 4096 chars passes",
      patch: {
        roles: [
          { slot: "agent-0", prompt: "r".repeat(ROLE_PROMPT_MAX_CHARS) },
          validState().roles[1],
        ],
      },
      key: "roles[0].prompt",
      want: false,
    },
    {
      label: "role prompt over 4096 chars fails",
      patch: {
        roles: [
          { slot: "agent-0", prompt: "r".repeat(ROLE_PROMPT_MAX_CHARS + 1) },
          validState().roles[1],
        ],
      },
      key: "roles[0].prompt",
      want: true,
    },
    {
      label: "role prompt blank fails",
      patch: {
        roles: [{ slot: "agent-0", prompt: "  " }, validState().roles[1]],
      },
      key: "roles[0].prompt",
      want: true,
    },
    // steps count 1..=6
    {
      label: "6 phases pass",
      patch: {
        steps: Array.from({ length: MAX_PHASES }, () => ({
          participants: ["agent-0"],
          rounds: 1,
          flow: "summary",
          prompt: "p",
          perAgentPrompts: {},
        })),
      },
      key: "steps",
      want: false,
    },
    {
      label: "7 phases fail",
      patch: {
        steps: Array.from({ length: MAX_PHASES + 1 }, () => ({
          participants: ["agent-0"],
          rounds: 1,
          flow: "local",
          prompt: "p",
          perAgentPrompts: {},
        })),
      },
      key: "steps",
      want: true,
      message: "`steps` must have 1..=6 phase(s) (got 7)",
    },
    {
      label: "0 phases fail",
      patch: { steps: [] },
      key: "steps",
      want: true,
    },
    // participants 1..=6, subset of roster
    {
      label: "6 participants pass",
      patch: {
        roles: Array.from({ length: MAX_ROSTER_SLOTS }, (_, i) => ({
          slot: `s${i}`,
          prompt: "p",
        })),
        steps: [
          {
            participants: ["s0", "s1", "s2", "s3", "s4", "s5"],
            rounds: 1,
            flow: "local",
            prompt: "p",
            perAgentPrompts: {},
          },
        ],
        finalWriter: "s5",
      },
      key: "steps[0].participants",
      want: false,
    },
    {
      label: "7 participants fail",
      patch: {
        roles: Array.from({ length: MAX_ROSTER_SLOTS + 1 }, (_, i) => ({
          slot: `s${i}`,
          prompt: "p",
        })),
        steps: [
          {
            participants: ["s0", "s1", "s2", "s3", "s4", "s5", "s6"],
            rounds: 1,
            flow: "local",
            prompt: "p",
            perAgentPrompts: {},
          },
        ],
        finalWriter: "s0",
      },
      key: "steps[0].participants",
      want: true,
    },
    {
      label: "0 participants fail",
      patch: {
        steps: [
          {
            participants: [],
            rounds: 1,
            flow: "local",
            prompt: "p",
            perAgentPrompts: {},
          },
        ],
      },
      key: "steps[0].participants",
      want: true,
    },
    {
      label: "participant outside the roster fails",
      patch: {
        steps: [
          {
            participants: ["agent-7"],
            rounds: 1,
            flow: "local",
            prompt: "p",
            perAgentPrompts: {},
          },
        ],
      },
      key: "steps[0].participants",
      want: true,
      message: 'Participant "agent-7" is not a defined role slot',
    },
    // rounds 1..=4
    {
      label: "rounds 4 passes",
      patch: {
        steps: [{ ...validState().steps[0], rounds: 4 }],
      },
      key: "steps[0].rounds",
      want: false,
    },
    {
      label: "rounds 5 fails",
      patch: {
        steps: [{ ...validState().steps[0], rounds: 5 }],
      },
      key: "steps[0].rounds",
      want: true,
      message: "Rounds must be 1..=4 (got 5)",
    },
    {
      label: "rounds 0 fails",
      patch: {
        steps: [{ ...validState().steps[0], rounds: 0 }],
      },
      key: "steps[0].rounds",
      want: true,
    },
    {
      label: "non-integer rounds fail",
      patch: {
        steps: [{ ...validState().steps[0], rounds: 2.5 }],
      },
      key: "steps[0].rounds",
      want: true,
    },
    // flow local | summary
    {
      label: "summary flow passes",
      patch: {
        steps: [{ ...validState().steps[0], flow: "summary" }],
      },
      key: "steps[0].flow",
      want: false,
    },
    {
      label: "unknown flow fails",
      patch: {
        steps: [{ ...validState().steps[0], flow: "banana" }],
      },
      key: "steps[0].flow",
      want: true,
      message: 'Flow must be "local" or "summary" (got "banana")',
    },
    {
      label: "missing flow fails",
      patch: {
        steps: [{ ...validState().steps[0], flow: "" }],
      },
      key: "steps[0].flow",
      want: true,
    },
    // step prompt 1..=4096
    {
      label: "phase prompt at 4096 chars passes",
      patch: {
        steps: [
          {
            ...validState().steps[0],
            prompt: "p".repeat(STEP_PROMPT_MAX_CHARS),
          },
        ],
      },
      key: "steps[0].prompt",
      want: false,
    },
    {
      label: "phase prompt over 4096 chars fails",
      patch: {
        steps: [
          {
            ...validState().steps[0],
            prompt: "p".repeat(STEP_PROMPT_MAX_CHARS + 1),
          },
        ],
      },
      key: "steps[0].prompt",
      want: true,
    },
    {
      label: "phase prompt blank fails",
      patch: {
        steps: [{ ...validState().steps[0], prompt: "   " }],
      },
      key: "steps[0].prompt",
      want: true,
    },
    // perAgentPrompts: keys ⊆ participants, values 1..=4096
    {
      label: "per-agent prompt at 4096 chars passes",
      patch: {
        steps: [
          {
            ...validState().steps[0],
            perAgentPrompts: { "agent-0": "a".repeat(STEP_PROMPT_MAX_CHARS) },
          },
        ],
      },
      key: "steps[0].perAgentPrompts[agent-0]",
      want: false,
    },
    {
      label: "per-agent prompt over 4096 chars fails",
      patch: {
        steps: [
          {
            ...validState().steps[0],
            perAgentPrompts: {
              "agent-0": "a".repeat(STEP_PROMPT_MAX_CHARS + 1),
            },
          },
        ],
      },
      key: "steps[0].perAgentPrompts[agent-0]",
      want: true,
    },
    {
      label: "per-agent prompt whitespace-only fails",
      patch: {
        steps: [
          {
            ...validState().steps[0],
            perAgentPrompts: { "agent-0": "  " },
          },
        ],
      },
      key: "steps[0].perAgentPrompts[agent-0]",
      want: true,
    },
    {
      label: "per-agent prompt for a non-participant fails",
      patch: {
        steps: [
          {
            ...validState().steps[0],
            participants: ["agent-0"],
            perAgentPrompts: { "agent-1": "x" },
          },
        ],
      },
      key: "steps[0].perAgentPrompts[agent-1]",
      want: true,
      message:
        'Per-agent prompt names "agent-1", which is not a participant of this phase',
    },
    // finalWriter ∈ roster
    {
      label: "finalWriter outside the roster fails",
      patch: { finalWriter: "agent-7" },
      key: "finalWriter",
      want: true,
      message: '`finalWriter` must be a defined role slot (got "agent-7")',
    },
    {
      label: "finalWriter blank fails",
      patch: { finalWriter: "" },
      key: "finalWriter",
      want: true,
    },
  ];

  for (const testCase of cases) {
    it(testCase.label, () => {
      const state = { ...validState(), ...testCase.patch };
      const errors = validateStrategyState(state);
      assert.equal(
        Boolean(errors[testCase.key]),
        testCase.want,
        `${testCase.key} -> ${JSON.stringify(errors)}`,
      );
      if (testCase.message !== undefined) {
        assert.equal(errors[testCase.key], testCase.message);
      }
    });
  }

  it("counts Unicode code points like Rust chars().count()", () => {
    assert.equal(charCount("\u00e9"), 1); // precomposed é
    assert.equal(charCount("e\u0301"), 2); // e + combining acute
    assert.equal(charCount("\u{1F44D}\u{1F3FD}"), 2); // thumbs-up + modifier
    const state = {
      ...validState(),
      name: "e\u0301".repeat(Math.floor(STRATEGY_NAME_MAX_CHARS / 2) + 1),
    };
    assert.equal(
      validateStrategyState(state).name,
      "`name` must be 1..=128 chars (got 130)",
    );
  });
});

describe("toStrategyJson", () => {
  it("emits the exact kind:44020 content object", () => {
    assert.deepEqual(toStrategyJson(validState()), {
      v: 1,
      name: "Mechanistic step audit",
      description: "AIME-2024 bank strategy.",
      teamworkPrompt: "Audit every step.",
      roles: {
        "agent-0": "Independent solver and step auditor.",
        "agent-1": "Consensus challenger.",
      },
      steps: [
        {
          participants: ["agent-1", "agent-0"],
          rounds: 1,
          flow: "local",
          prompt: "Audit the reasoning chains step by step.",
          perAgentPrompts: { "agent-1": "Challenge every consensus." },
        },
      ],
      finalWriter: "agent-1",
    });
  });

  it("omits perAgentPrompts when empty and parentStrategy when blank", () => {
    const state = {
      ...validState(),
      steps: [{ ...validState().steps[0], perAgentPrompts: {} }],
    };
    const json = toStrategyJson(state);
    assert.equal("perAgentPrompts" in json.steps[0], false);
    assert.equal("parentStrategy" in json, false);
  });

  it("omits whitespace-only per-agent prompts but keeps typed text verbatim", () => {
    const state = {
      ...validState(),
      steps: [
        {
          ...validState().steps[0],
          prompt: "  padded  ",
          perAgentPrompts: { "agent-0": "  ", "agent-1": "keep" },
        },
      ],
    };
    const step = toStrategyJson(state).steps[0];
    assert.equal(step.prompt, "  padded  ");
    assert.deepEqual(step.perAgentPrompts, { "agent-1": "keep" });
  });

  it("includes parentStrategy when set (reflection lineage)", () => {
    const json = toStrategyJson({
      ...validState(),
      parentStrategy: "sat-smoke-2",
    });
    assert.equal(json.parentStrategy, "sat-smoke-2");
  });
});

describe("strategyStateFromJson / parseStrategyJsonText", () => {
  it("round-trips a full strategy JSON losslessly", () => {
    const json = {
      v: 1,
      name: "Mechanistic step audit",
      description: "AIME-2024 bank strategy.",
      teamworkPrompt: "Audit every step.",
      roles: {
        "agent-0": "Independent solver and step auditor.",
        "agent-1": "Consensus challenger.",
      },
      steps: [
        {
          participants: ["agent-1", "agent-0"],
          rounds: 2,
          flow: "summary",
          prompt: "Audit the reasoning chains step by step.",
          perAgentPrompts: { "agent-1": "Challenge every consensus." },
        },
      ],
      finalWriter: "agent-1",
      parentStrategy: "sat-smoke-2",
    };
    const state = strategyStateFromJson(json, { id: "mechanistic-step-audit" });
    assert.deepEqual(validateStrategyState(state), {});
    assert.deepEqual(toStrategyJson(state), json);
    assert.equal(state.id, "mechanistic-step-audit");
  });

  it("never throws on empty, partial, or foreign shapes", () => {
    for (const value of [
      null,
      undefined,
      42,
      "str",
      [],
      {},
      { roles: "nope", steps: "nope" },
      {
        roles: { a: 5, b: null, c: { nested: true } },
        steps: [null, "x", { participants: [1, "a", null], rounds: "3" }],
      },
    ]) {
      const state = strategyStateFromJson(value, { id: "x" });
      assert.equal(state.id, "x");
      assert.ok(Array.isArray(state.roles));
      assert.ok(Array.isArray(state.steps));
      assert.equal(typeof state.name, "string");
      validateStrategyState(state); // must not throw either
    }
  });

  it("keeps bad rounds/flow raw so validation flags them (no silent rewrite)", () => {
    const state = strategyStateFromJson({
      v: 1,
      name: "n",
      description: "d",
      teamworkPrompt: "t",
      roles: { a: "p" },
      steps: [
        { participants: ["a"], rounds: 2.5, flow: "banana", prompt: "p" },
      ],
      finalWriter: "a",
    });
    assert.equal(state.steps[0].rounds, 2.5);
    assert.equal(state.steps[0].flow, "banana");
    const errors = validateStrategyState(state);
    assert.match(errors["steps[0].rounds"] ?? "", /Rounds must be/);
    assert.match(errors["steps[0].flow"] ?? "", /Flow must be/);
  });

  it("normalizes typed numeric strings for rounds losslessly", () => {
    const state = strategyStateFromJson({
      roles: { a: "p" },
      steps: [{ participants: ["a"], rounds: "3", flow: "local", prompt: "p" }],
    });
    assert.equal(state.steps[0].rounds, 3);
  });

  it("parseStrategyJsonText rejects invalid JSON and non-objects inline", () => {
    assert.equal(parseStrategyJsonText("{nope").ok, false);
    assert.equal(parseStrategyJsonText("[1,2]").ok, false);
    assert.equal(parseStrategyJsonText("null").ok, false);
    assert.equal(parseStrategyJsonText('"str"').ok, false);
    const ok = parseStrategyJsonText('{"roles":{}}', { id: "kept" });
    assert.equal(ok.ok, true);
    assert.equal(ok.state.id, "kept");
    assert.deepEqual(ok.state.roles, []);
  });
});

describe("form mutators — reference cleanup on every removal path", () => {
  it("removeRole drops participants, per-agent prompts, and fixes finalWriter", () => {
    const state = {
      ...validState(),
      steps: [
        {
          participants: ["agent-0", "agent-1"],
          rounds: 1,
          flow: "local",
          prompt: "p",
          perAgentPrompts: { "agent-0": "a", "agent-1": "b" },
        },
      ],
    };
    const next = removeRole(state, 0); // drop agent-0 (also the finalWriter's peer)
    assert.deepEqual(
      next.roles.map((r) => r.slot),
      ["agent-1"],
    );
    assert.deepEqual(next.steps[0].participants, ["agent-1"]);
    assert.deepEqual(next.steps[0].perAgentPrompts, { "agent-1": "b" });
    // finalWriter pointed at agent-1 (untouched) — stays.
    assert.equal(next.finalWriter, "agent-1");

    const emptied = removeRole(state, 1); // drop agent-1, the current finalWriter
    assert.equal(emptied.finalWriter, "agent-0");
    assert.deepEqual(emptied.steps[0].participants, ["agent-0"]);

    const gone = removeRole(removeRole(state, 0), 0);
    assert.deepEqual(gone.roles, []);
    assert.equal(gone.finalWriter, "");
    assert.deepEqual(gone.steps[0].participants, []);
  });

  it("removeRole is a no-op for an out-of-range index", () => {
    const state = validState();
    assert.equal(removeRole(state, 9), state);
  });

  it("renameRole rewrites participants (order kept), prompt keys, and finalWriter", () => {
    const state = {
      ...validState(),
      steps: [
        {
          participants: ["agent-1", "agent-0"],
          rounds: 1,
          flow: "local",
          prompt: "p",
          perAgentPrompts: { "agent-1": "b", "agent-0": "a" },
        },
      ],
    };
    const next = renameRole(state, 1, "critic"); // agent-1 -> critic
    assert.deepEqual(
      next.roles.map((r) => r.slot),
      ["agent-0", "critic"],
    );
    assert.deepEqual(next.steps[0].participants, ["critic", "agent-0"]);
    assert.deepEqual(next.steps[0].perAgentPrompts, {
      critic: "b",
      "agent-0": "a",
    });
    assert.equal(next.finalWriter, "critic");
  });

  it("toggleStepParticipant removes and clears the per-agent prompt (rule 2)", () => {
    const state = {
      ...validState(),
      steps: [
        {
          participants: ["agent-0", "agent-1"],
          rounds: 1,
          flow: "local",
          prompt: "p",
          perAgentPrompts: { "agent-1": "b" },
        },
      ],
    };
    const removed = toggleStepParticipant(state, 0, "agent-1");
    assert.deepEqual(removed.steps[0].participants, ["agent-0"]);
    assert.equal("agent-1" in removed.steps[0].perAgentPrompts, false);
    const added = toggleStepParticipant(removed, 0, "agent-1");
    assert.deepEqual(added.steps[0].participants, ["agent-0", "agent-1"]);
    assert.deepEqual(added.steps[0].perAgentPrompts, {});
  });

  it("setStepPerAgentPrompt drops the key for an empty override", () => {
    const state = validState();
    const next = setStepPerAgentPrompt(state, 0, "agent-1", "");
    assert.deepEqual(next.steps[0].perAgentPrompts, {});
    const kept = setStepPerAgentPrompt(next, 0, "agent-0", "x");
    assert.deepEqual(kept.steps[0].perAgentPrompts, { "agent-0": "x" });
  });

  it("moveStepParticipant reorders the response order and no-ops out of range", () => {
    const state = {
      ...validState(),
      steps: [
        {
          participants: ["a", "b", "c"],
          rounds: 1,
          flow: "local",
          prompt: "p",
          perAgentPrompts: {},
        },
      ],
    };
    assert.deepEqual(
      moveStepParticipant(state, 0, 2, 0).steps[0].participants,
      ["c", "a", "b"],
    );
    assert.deepEqual(moveStepParticipant(state, 0, 1, 1), state);
    assert.deepEqual(moveStepParticipant(state, 0, 3, 0), state);
    assert.deepEqual(moveStepParticipant(state, 0, 0, 3), state);
  });

  it("addStep/removeStep and addRole/setRolePrompt keep arrays immutable", () => {
    const state = validState();
    const withStep = addStep(state);
    assert.equal(withStep.steps.length, 2);
    assert.equal(state.steps.length, 1, "original state untouched");
    assert.equal(removeStep(withStep, 0).steps.length, 1);
    assert.equal(addRole(state).roles.length, 3); // validState has 2 roles
    assert.equal(setRolePrompt(state, 0, "new").roles[0].prompt, "new");
    assert.equal(state.roles[0].prompt, "Independent solver and step auditor.");
  });
});

describe("suggestStrategyId", () => {
  const cases = [
    ["Mechanistic Step Audit", "mechanistic-step-audit"],
    ["  spaced   out  ", "spaced-out"],
    ["!!!", "my-strategy"],
    ["", "my-strategy"],
    ["Ünïcodé", "n-cod"],
    ["x".repeat(80), "x".repeat(64)],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} -> ${expected}`, () => {
      assert.equal(suggestStrategyId(input), expected);
    });
  }
});

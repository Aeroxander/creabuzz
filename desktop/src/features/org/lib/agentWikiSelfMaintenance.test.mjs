// Unit tests for the Agent Wiki self-maintenance toggle logic: the pinned
// workflow definition (round-trip + docs drift), presence detection keyed on
// name AND action shape, and the schedule/status copy derived from real
// workflow state.
// Run with: node --import ./test-loader.mjs --experimental-strip-types --test src/features/org/lib/agentWikiSelfMaintenance.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parse as yamlParse } from "yaml";

import {
  AGENT_WIKI_SELF_MAINTENANCE_DEFINITION,
  AGENT_WIKI_SELF_MAINTENANCE_STEP_ACTION,
  SELF_MAINTENANCE_ERROR_EXCERPT_CHARS,
  SELF_MAINTENANCE_ERROR_FALLBACK,
  agentWikiSelfMaintenanceYaml,
  describeCronSchedule,
  findSelfMaintenanceWorkflow,
  isSelfMaintenanceDefinition,
  selfMaintenanceErrorMessage,
  selfMaintenanceScheduleLabel,
  selfMaintenanceStatusLabel,
} from "./agentWikiSelfMaintenance.ts";

function workflowDefinition(overrides = {}) {
  return {
    name: "agwiki-nightly",
    description:
      "Keep the Agent Wiki standup page current without a manual distill",
    trigger: { on: "schedule", cron: "0 9 * * 1-5" },
    steps: [{ id: "distill", action: "distill_agent_wiki", space: "default" }],
    enabled: true,
    ...overrides,
  };
}

describe("AGENT_WIKI_SELF_MAINTENANCE_DEFINITION", () => {
  it("round-trips through the YAML the create command consumes", () => {
    const parsed = yamlParse(agentWikiSelfMaintenanceYaml());
    assert.deepEqual(parsed, AGENT_WIKI_SELF_MAINTENANCE_DEFINITION);
  });

  it("pins the fields the product contract requires", () => {
    const def = AGENT_WIKI_SELF_MAINTENANCE_DEFINITION;
    assert.equal(def.name, "agwiki-nightly");
    assert.deepEqual(def.trigger, { on: "schedule", cron: "0 9 * * 1-5" });
    assert.deepEqual(def.steps, [
      { id: "distill", action: "distill_agent_wiki", space: "default" },
    ]);
    assert.equal(def.enabled, true);
  });

  it("matches the YAML block documented in docs/agent-wiki.md (drift guard)", () => {
    const doc = fs.readFileSync(
      new URL("../../../../../docs/agent-wiki.md", import.meta.url),
      "utf8",
    );
    const blocks = [...doc.matchAll(/```yaml\n([\s\S]*?)```/g)]
      .map((match) => match[1])
      .filter((block) => block.includes("name: agwiki-nightly"));
    assert.equal(
      blocks.length,
      1,
      "expected exactly one documented agwiki-nightly YAML block in docs/agent-wiki.md",
    );
    assert.deepEqual(
      yamlParse(blocks[0]),
      AGENT_WIKI_SELF_MAINTENANCE_DEFINITION,
      "docs/agent-wiki.md and the pinned definition have drifted — update whichever is stale",
    );
  });
});

describe("isSelfMaintenanceDefinition (name AND action shape)", () => {
  it("requires BOTH the pinned name and a distill_agent_wiki step", () => {
    const cases = [
      // [definition, expected]
      [workflowDefinition(), true],
      [workflowDefinition({ name: "Agwiki-Nightly" }), false],
      [workflowDefinition({ name: "nightly-standup" }), false],
      [workflowDefinition({ name: undefined }), false],
      [
        workflowDefinition({
          steps: [{ id: "distill", action: "send_message", text: "hi" }],
        }),
        false,
      ],
      [
        workflowDefinition({
          steps: [
            { id: "a", action: "send_message", text: "hi" },
            { id: "distill", action: "distill_agent_wiki", space: "default" },
          ],
        }),
        true,
      ],
      // Action shape only — right step under the wrong name is NOT the toggle.
      [
        workflowDefinition({
          name: "something-else",
          steps: [
            { id: "distill", action: "distill_agent_wiki", space: "default" },
          ],
        }),
        false,
      ],
      [workflowDefinition({ steps: [] }), false],
      [workflowDefinition({ steps: "distill" }), false],
      [workflowDefinition({ steps: [null, 7, "distill"] }), false],
      [workflowDefinition({ steps: [{ id: "distill" }] }), false],
    ];
    for (const [definition, expected] of cases) {
      assert.equal(
        isSelfMaintenanceDefinition(definition),
        expected,
        `definition ${JSON.stringify(definition)} should ${expected ? "" : "not "}count`,
      );
    }
    assert.equal(AGENT_WIKI_SELF_MAINTENANCE_STEP_ACTION, "distill_agent_wiki");
  });
});

describe("findSelfMaintenanceWorkflow", () => {
  it("returns null when no workflow matches both halves", () => {
    assert.equal(
      findSelfMaintenanceWorkflow([
        {
          id: "w1",
          channelId: "c1",
          definition: workflowDefinition({ name: "other" }),
        },
        {
          id: "w2",
          channelId: "c1",
          definition: workflowDefinition({
            steps: [{ id: "distill", action: "send_message", text: "hi" }],
          }),
        },
      ]),
      null,
    );
  });

  it("finds the matching workflow and picks a deterministic winner on duplicates", () => {
    const matchA = {
      id: "w-b",
      channelId: "chan-b",
      definition: workflowDefinition(),
    };
    const matchB = {
      id: "w-a",
      channelId: "chan-a",
      definition: workflowDefinition(),
    };
    const noise = {
      id: "w-c",
      channelId: "chan-a",
      definition: workflowDefinition({ name: "other" }),
    };
    // Lowest (channelId, id) wins regardless of list order.
    assert.equal(findSelfMaintenanceWorkflow([matchA, matchB, noise]), matchB);
    assert.equal(findSelfMaintenanceWorkflow([noise, matchA, matchB]), matchB);
  });
});

describe("describeCronSchedule", () => {
  it("expands only shapes it can state honestly", () => {
    const cases = [
      ["0 9 * * 1-5", "weekdays at 09:00 UTC"],
      ["0 9 * * *", "every day at 09:00 UTC"],
      ["0 9 * * 7", "Sun at 09:00 UTC"],
      ["30 8 * * 1", "Mon at 08:30 UTC"],
      ["0 0 * * 0,6", "weekends at 00:00 UTC"],
      ["0 9 * * 1,3", "Mon, Wed at 09:00 UTC"],
      ["0 9 * * 2-4", "Tue, Wed, Thu at 09:00 UTC"],
      // Honest fallbacks — never guess at shapes we do not expand.
      ["*/5 * * * *", "cron */5 * * * *"],
      ["0 9 1 * *", "cron 0 9 1 * *"],
      ["0 9 * 6 *", "cron 0 9 * 6 *"],
      ["99 99 * * *", "cron 99 99 * * *"],
      ["0 9 * * 8", "cron 0 9 * * 8"],
      ["0 9 * * 3-1", "cron 0 9 * * 3-1"],
      ["0 9 * * 1-5 ", "weekdays at 09:00 UTC"],
      ["0 9 * *", "cron 0 9 * *"],
      ["0 9 * * 1-5 extra", "cron 0 9 * * 1-5 extra"],
    ];
    for (const [cron, expected] of cases) {
      assert.equal(
        describeCronSchedule(cron),
        expected,
        `cron ${JSON.stringify(cron)} rendered wrong`,
      );
    }
  });
});

describe("selfMaintenanceScheduleLabel", () => {
  it("derives the schedule from the workflow's own trigger", () => {
    assert.equal(
      selfMaintenanceScheduleLabel(workflowDefinition()),
      "weekdays at 09:00 UTC",
    );
    assert.equal(
      selfMaintenanceScheduleLabel(
        workflowDefinition({ trigger: { on: "schedule", interval: "24h" } }),
      ),
      "every 24h",
    );
    assert.equal(
      selfMaintenanceScheduleLabel(
        workflowDefinition({ trigger: { on: "message_posted" } }),
      ),
      null,
    );
    assert.equal(
      selfMaintenanceScheduleLabel(
        workflowDefinition({ trigger: { on: "schedule" } }),
      ),
      null,
    );
    assert.equal(selfMaintenanceScheduleLabel({}), null);
  });
});

describe("selfMaintenanceStatusLabel", () => {
  it("renders the honest on/off line", () => {
    assert.equal(
      selfMaintenanceStatusLabel(false, null),
      "Nightly standup: off",
    );
    assert.equal(
      selfMaintenanceStatusLabel(false, "cron x"),
      "Nightly standup: off",
    );
    assert.equal(
      selfMaintenanceStatusLabel(true, "weekdays at 09:00 UTC"),
      "Nightly standup: on (weekdays at 09:00 UTC)",
    );
    assert.equal(
      selfMaintenanceStatusLabel(true, "weekdays at 09:00 UTC", "general"),
      "Nightly standup: on (weekdays at 09:00 UTC, #general)",
    );
    assert.equal(
      selfMaintenanceStatusLabel(true, null, "general"),
      "Nightly standup: on (#general)",
    );
    assert.equal(selfMaintenanceStatusLabel(true, null), "Nightly standup: on");
  });
});

describe("selfMaintenanceErrorMessage", () => {
  it("surfaces the command error verbatim and bounded", () => {
    assert.equal(
      selfMaintenanceErrorMessage(new Error("step 'distill': unknown action")),
      "step 'distill': unknown action",
    );
    assert.equal(
      selfMaintenanceErrorMessage("relay rejected the event"),
      "relay rejected the event",
    );
    const long = "x".repeat(SELF_MAINTENANCE_ERROR_EXCERPT_CHARS + 50);
    const excerpt = selfMaintenanceErrorMessage(new Error(long));
    assert.equal([...excerpt].length, SELF_MAINTENANCE_ERROR_EXCERPT_CHARS + 1);
    assert.ok(excerpt.endsWith("…"));
  });

  it("falls back to explicit copy when there is no detail", () => {
    assert.equal(
      selfMaintenanceErrorMessage(new Error("   ")),
      SELF_MAINTENANCE_ERROR_FALLBACK,
    );
    assert.equal(
      selfMaintenanceErrorMessage(""),
      SELF_MAINTENANCE_ERROR_FALLBACK,
    );
  });
});

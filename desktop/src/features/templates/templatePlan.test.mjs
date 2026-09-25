import assert from "node:assert/strict";
import { test } from "node:test";

import {
  deriveApplyUiState,
  stepLabel,
  stepUiState,
  whatYouGet,
} from "./templatePlan.ts";

const template = {
  id: "demo",
  name: "Demo",
  description: "d",
  channels: [
    { id: "general", name: "general", purpose: "chat", seed: "seeds/a.md" },
    { id: "random", name: "random", purpose: "off-topic" },
  ],
  personas: [{ id: "writer", name: "The Writer", prompt: "p.md" }],
  workflows: [{ file: "workflows/w.yaml" }],
  docs: [
    { file: "docs/a.md", title: "A" },
    { file: "docs/b.md", title: "B" },
  ],
  skills: [{ name: "s", source: "https://x/SKILL.md", applies_to: "all" }],
  welcome: "welcome.md",
};

test("whatYouGet lists every non-empty block", () => {
  assert.deepEqual(whatYouGet(template), [
    "2 channels",
    "1 agent",
    "1 workflow",
    "2 docs",
    "1 skill",
  ]);
});

test("whatYouGet omits empty blocks and pluralizes", () => {
  const empty = {
    ...template,
    personas: [],
    workflows: [],
    docs: [],
    skills: [],
    channels: [{ id: "one", name: "one", purpose: "p" }],
  };
  assert.deepEqual(whatYouGet(empty), ["1 channel"]);
});

// Table over the full action space — each maps to exactly one checklist state.
for (const [action, state] of [
  ["created", "done"],
  ["skipped", "skipped"],
  ["failed", "failed"],
  ["not-attempted", "waiting"],
]) {
  test(`step '${action}' renders as '${state}'`, () => {
    const step = { step: "channel", item: "general", action };
    assert.equal(stepUiState(step).state, state);
  });
}

test("step labels cover every step kind", () => {
  assert.equal(
    stepLabel({ step: "channel", item: "general", action: "created" }),
    "Channel #general",
  );
  assert.equal(
    stepLabel({ step: "seed", item: "seed:general", action: "created" }),
    "First message in #general",
  );
  assert.equal(
    stepLabel({ step: "welcome", item: "welcome", action: "created" }),
    "Welcome message",
  );
});

test("full success surfaces the welcome message and no resume", () => {
  const report = {
    status: "ok",
    template_id: "demo",
    resumed: false,
    steps: [
      { step: "channel", item: "general", action: "created" },
      {
        step: "welcome",
        item: "welcome",
        action: "skipped",
        reason: "already-exists",
      },
    ],
    welcome: { channel_id: "u", event_id: "e", content: "# Welcome" },
  };
  const ui = deriveApplyUiState(report);
  assert.equal(ui.kind, "ok");
  assert.equal(ui.welcome, "# Welcome");
  assert.equal(ui.error, null);
  assert.equal(ui.canResume, false);
});

test("partial failure reports the failed step and offers resume", () => {
  const report = {
    status: "partial",
    template_id: "demo",
    resumed: false,
    steps: [
      { step: "channel", item: "general", action: "created" },
      {
        step: "workflow",
        item: "w.yaml",
        action: "failed",
        error: "relay down",
      },
      { step: "doc", item: "d.md", action: "not-attempted" },
    ],
    failed_step: { step: "workflow", item: "w.yaml", error: "relay down" },
  };
  const ui = deriveApplyUiState(report);
  assert.equal(ui.kind, "partial");
  assert.equal(ui.welcome, null, "welcome is a full-success-only state");
  assert.equal(ui.error, "relay down");
  assert.equal(ui.canResume, true);
  assert.deepEqual(
    ui.steps.map((s) => s.state),
    ["done", "failed", "waiting"],
  );
});

test("validation failure (no steps) surfaces the named error and no resume", () => {
  const report = {
    status: "failed",
    template_id: "demo",
    resumed: false,
    steps: [],
    failed_step: {
      step: "validate",
      item: "",
      error: "skill is missing frontmatter name/description",
    },
  };
  const ui = deriveApplyUiState(report);
  assert.equal(ui.kind, "failed");
  assert.equal(ui.error, "skill is missing frontmatter name/description");
  assert.equal(ui.canResume, false);
});

test("fully skipped re-apply is ok without resume", () => {
  const report = {
    status: "ok",
    template_id: "demo",
    resumed: true,
    steps: [
      {
        step: "channel",
        item: "general",
        action: "skipped",
        reason: "already-exists",
      },
      { step: "skill", item: "s", action: "skipped", reason: "unchanged" },
    ],
  };
  const ui = deriveApplyUiState(report);
  assert.equal(ui.kind, "ok");
  assert.equal(ui.canResume, false);
  assert.deepEqual(
    ui.steps.map((s) => s.state),
    ["skipped", "skipped"],
  );
});

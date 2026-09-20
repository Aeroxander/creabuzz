import assert from "node:assert/strict";
import test from "node:test";

import { agentActivitySummary } from "./inbox.ts";

test("capabilities render name + status with tool list", () => {
  const summary = agentActivitySummary(
    44010,
    JSON.stringify({ name: "Ralph", status: "busy", tools: ["shell", "edit"] }),
  );
  assert.deepEqual(summary, {
    headline: "Ralph is busy",
    preview: "Tools: shell, edit",
  });
});

test("capabilities degrade honestly on malformed content", () => {
  const summary = agentActivitySummary(44010, "not json{{{");
  assert.equal(summary?.headline, "Agent is updated");
});

test("tasks render status + title with description preview", () => {
  const summary = agentActivitySummary(
    44011,
    JSON.stringify({
      title: "Fix login",
      status: "in_progress",
      description: "OAuth race\nmore",
    }),
  );
  assert.deepEqual(summary, {
    headline: "Task in_progress: Fix login",
    preview: "OAuth race",
  });
});

test("turn metrics never guess at encrypted content", () => {
  const summary = agentActivitySummary(44200, "NIP44CIPHERTEXT");
  assert.equal(summary?.headline, "Agent turn completed");
  assert.doesNotMatch(summary?.preview ?? "", /NIP44CIPHERTEXT/);
  assert.match(summary?.preview ?? "", /encrypted to the agent owner/);
});

test("workflow lifecycle headlines", () => {
  assert.equal(agentActivitySummary(46001, "")?.headline, "Workflow started");
  assert.equal(agentActivitySummary(46005, "")?.headline, "Workflow completed");
  assert.equal(agentActivitySummary(46006, "")?.headline, "Workflow failed");
});

test("unknown kinds return null so callers fall back", () => {
  assert.equal(agentActivitySummary(9, "hello"), null);
  assert.equal(agentActivitySummary(99999, "{}"), null);
});

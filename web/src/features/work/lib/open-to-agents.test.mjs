import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { byAgentOpen, isAgentCategory, topicKey } from "./open-to-agents.ts";

const RUST = readFileSync(
  new URL(
    "../../../../../crates/buzz-cli/src/commands/launchpad_inbox.rs",
    import.meta.url,
  ),
  "utf8",
);

test("a topic is compared as the command line compares it", () => {
  for (const [word, key] of [
    ["AI agents", "ai-agents"],
    ["AI Agents", "ai-agents"],
    ["  ai   agents ", "ai-agents"],
    ["AI agent or tool", "ai-agent-or-tool"],
    ["-- Games!! --", "games"],
    ["", ""],
  ])
    assert.equal(topicKey(word), key, word);
});

test("the comparison is the same algorithm as the command line's, which this test reads", () => {
  const normal = /fn normal\(word: &str\) -> String \{([\s\S]*?)\n\}/.exec(
    RUST,
  )?.[1];
  assert.ok(normal, "launchpad_inbox.rs has fn normal");
  assert.match(normal, /trim\(\)\.to_lowercase\(\)/);
  assert.match(normal, /is_alphanumeric\(\)/);
  assert.match(normal, /!out\.ends_with\('-'\)/);
  assert.match(normal, /trim_matches\('-'\)/);
  // The command line's own test: the topic "AI Agents" is found by --category.
  assert.match(RUST, /category: Some\("AI Agents"\.into\(\)\)/);
});

test("both AI categories count, a project without a category or with another does not", () => {
  assert.equal(isAgentCategory("AI agents"), true);
  assert.equal(isAgentCategory("AI agent or tool"), true);
  assert.equal(isAgentCategory("ai agents"), true);
  assert.equal(isAgentCategory("Software"), false);
  assert.equal(isAgentCategory("Agents of chaos"), false);
  assert.equal(isAgentCategory(null), false);
  assert.equal(isAgentCategory(undefined), false);
});

test("the filter keeps the requests of AI projects, looked up by project, in order, and Off keeps all", () => {
  const req = (id, project) => ({ id, project: { id: project, author: "f" } });
  const categories = {
    p1: "AI agents",
    p2: "Software",
    p4: "AI agent or tool",
  };
  const categoryOf = (project) => categories[project.id] ?? null;
  const all = [req("a", "p1"), req("b", "p2"), req("c", "p3"), req("d", "p4")];
  assert.deepEqual(
    byAgentOpen(all, true, categoryOf).map((r) => r.id),
    ["a", "d"],
  );
  assert.deepEqual(
    byAgentOpen(all, false, categoryOf).map((r) => r.id),
    ["a", "b", "c", "d"],
  );
  assert.deepEqual(byAgentOpen([], true, categoryOf), []);
});

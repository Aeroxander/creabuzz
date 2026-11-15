import assert from "node:assert/strict";
import { test } from "node:test";

import { agentPostCommands, isAiCategory, shellWord } from "./agent-post.ts";

test("both AI categories Start has offered count, in any case, and nothing else does", () => {
  assert.equal(isAiCategory("AI agent or tool"), true);
  assert.equal(isAiCategory("AI agents"), true);
  assert.equal(isAiCategory(" ai AGENTS "), true);
  assert.equal(isAiCategory("Software"), false);
  assert.equal(isAiCategory("AI"), false);
  assert.equal(isAiCategory(null), false);
  assert.equal(isAiCategory(undefined), false);
});

test("a plain word stays bare and anything else is quoted so the shell reads it as one word", () => {
  assert.equal(shellWord("nebula-os"), "nebula-os");
  assert.equal(shellWord("a b"), "'a b'");
  assert.equal(shellWord("it's"), `'it'\\''s'`);
  assert.equal(shellWord("x;rm -rf ~"), "'x;rm -rf ~'");
  assert.equal(shellWord("$(id)"), "'$(id)'");
});

test("the card shows the real subcommands, with the founder named and no promises", () => {
  const author = "ab".repeat(32);
  const [facts, post] = agentPostCommands({ id: "nebula-os", author });
  assert.equal(
    facts,
    `buzz launchpad updates facts nebula-os --author ${author}`,
  );
  assert.match(
    post,
    /^buzz launchpad updates post nebula-os --author [0-9a-f]{64} /,
  );
  assert.match(post, / --title "Week 1" /);
  assert.match(post, / --no-promises$/);
  // A project id that is not a plain word is quoted in both.
  const [quoted] = agentPostCommands({ id: "my project", author });
  assert.match(quoted, /facts 'my project' --author/);
});

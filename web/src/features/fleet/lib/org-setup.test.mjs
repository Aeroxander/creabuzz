import assert from "node:assert/strict";
import { test } from "node:test";

import { buildOrgTree, indexOrgNodes } from "./index-org.ts";
import {
  AUTONOMY_LEVELS,
  describeAutonomy,
  emptyDraft,
  helperIssue,
  nameIssue,
  rejectionMessage,
  reviewLines,
  setupRecords,
  slugify,
} from "./org-setup.ts";

const ME = "a".repeat(64);
const AGENT = "B".repeat(64);

const full = () => ({
  name: "Nebula Labs!",
  purpose: "Maps the night sky",
  helper: { pubkey: AGENT, role: "Researcher" },
  autonomy: "balanced",
});

test("names become short, address-safe ids", () => {
  assert.equal(slugify("Nebula Labs!"), "nebula-labs");
  assert.equal(slugify("  --Ünïcode  Café--"), "unicode-cafe");
  assert.equal(slugify("!!!"), "");
  assert.equal(slugify("x".repeat(80)).length, 40);
});

test("the name step says what is wrong in words", () => {
  const draft = emptyDraft();
  assert.equal(nameIssue(draft), "Give your organization a name.");
  assert.equal(
    nameIssue({ ...draft, name: "!!" }),
    "Use at least one letter or number in the name.",
  );
  assert.match(nameIssue({ ...draft, name: "x".repeat(61) }) ?? "", /under 60/);
  assert.match(
    nameIssue({ name: "Nebula", purpose: "p".repeat(141) }) ?? "",
    /under 140/,
  );
  assert.equal(nameIssue({ name: "Nebula", purpose: "" }), null);
});

test("the helper step needs a real helper and a role, or nothing at all", () => {
  assert.equal(helperIssue({ helper: null }), null);
  assert.match(
    helperIssue({ helper: { pubkey: "nope", role: "Researcher" } }) ?? "",
    /Pick one/,
  );
  assert.match(
    helperIssue({ helper: { pubkey: AGENT, role: " " } }) ?? "",
    /what this helper does/,
  );
  assert.equal(
    helperIssue({ helper: { pubkey: AGENT, role: "Researcher" } }),
    null,
  );
});

test("a finished draft is three records, team first", () => {
  const records = setupRecords(full(), ME);
  assert.deepEqual(
    records.map((r) => [r.step, r.kind]),
    [
      ["team", 37010],
      ["helper", 37010],
      ["limit", 37012],
    ],
  );
  const [team, helper, limit] = records;

  assert.deepEqual(team.tags, [
    ["d", "nebula-labs"],
    ["p", ME],
  ]);
  const teamBody = JSON.parse(team.content);
  assert.equal(teamBody.v, 1);
  assert.equal(teamBody.kind, "team");
  assert.deepEqual(teamBody.holders, [ME]);
  assert.equal(teamBody.ui.blurb, "Maps the night sky");

  // The helper's seat points at the team and names the helper in lower case.
  assert.deepEqual(helper.tags, [
    ["d", "nebula-labs-researcher"],
    ["p", AGENT.toLowerCase()],
  ]);
  const helperBody = JSON.parse(helper.content);
  assert.equal(helperBody.kind, "agent_seat");
  assert.equal(helperBody.parent, "nebula-labs");
  assert.deepEqual(helperBody.agentSeats, [AGENT.toLowerCase()]);
  assert.deepEqual(helperBody.holders, []);

  // The default limit covers every helper, per day, with only counters the server counts.
  assert.deepEqual(limit.tags, [["d", "*"]]);
  assert.deepEqual(JSON.parse(limit.content), {
    v: 1,
    subject: "*",
    window: "day",
    limits: { runs: 50, tasks: { create: 20 }, messages: 300 },
    onExceed: "require-approval",
  });
});

test("leaving the helper and the limit out leaves them out", () => {
  const records = setupRecords(
    { name: "Nebula", purpose: "", helper: null, autonomy: null },
    ME,
  );
  assert.deepEqual(
    records.map((r) => r.step),
    ["team"],
  );
  assert.equal("ui" in JSON.parse(records[0].content), false);
});

test("an unfinished draft cannot be turned into records", () => {
  assert.throws(
    () => setupRecords(emptyDraft(), ME),
    /Give your organization a name/,
  );
  assert.throws(
    () => setupRecords({ ...full(), helper: { pubkey: AGENT, role: "" } }, ME),
    /what this helper does/,
  );
});

test("what the page publishes is what the org chart reads back", () => {
  const records = setupRecords(full(), ME);
  const events = records
    .filter((r) => r.kind === 37010)
    .map((r, i) => ({
      pubkey: ME,
      created_at: 1000 + i,
      tags: r.tags,
      content: r.content,
    }));
  const forest = buildOrgTree(indexOrgNodes(events));
  assert.equal(forest.length, 1);
  assert.equal(forest[0].entry.name, "Nebula Labs!");
  assert.deepEqual(forest[0].entry.holders, [ME]);
  assert.equal(forest[0].children.length, 1);
  assert.equal(forest[0].children[0].entry.kind, "agent_seat");
  assert.deepEqual(forest[0].children[0].entry.agentSeats, [
    AGENT.toLowerCase(),
  ]);
});

test("every level is described by the numbers it actually sets", () => {
  for (const level of AUTONOMY_LEVELS) {
    const text = describeAutonomy(level.id);
    assert.ok(text.includes(`${level.perDay.runs} times`), text);
    assert.ok(text.includes(`${level.perDay.tasks} tasks`), text);
    assert.ok(text.includes(`${level.perDay.messages} messages`), text);
  }
  // More freedom never means a smaller limit.
  for (let i = 1; i < AUTONOMY_LEVELS.length; i++) {
    const a = AUTONOMY_LEVELS[i - 1].perDay;
    const b = AUTONOMY_LEVELS[i].perDay;
    assert.ok(b.runs > a.runs && b.tasks > a.tasks && b.messages > a.messages);
  }
});

test("the review reads back every choice, including the empty ones", () => {
  const lines = reviewLines(full(), "Ada's helper");
  assert.equal(lines[0], "A team called “Nebula Labs!”, with you in it.");
  assert.ok(lines.includes("Purpose: Maps the night sky"));
  assert.ok(lines.includes("Ada's helper joins as “Researcher”."));
  assert.ok(lines.at(-1)?.startsWith("Each helper can run 50 times"));
  const bare = reviewLines(
    { name: "Nebula", purpose: "", helper: null, autonomy: null },
    null,
  );
  assert.ok(bare.includes("No helpers yet. You can add them any time."));
  assert.match(bare.at(-1) ?? "", /no default limit/);
});

test("the server's short answers become what to do next", () => {
  assert.match(
    rejectionMessage("restricted: only the owner"),
    /owner or an admin/,
  );
  assert.match(rejectionMessage("invalid: org node content"), /Check the name/);
  assert.match(rejectionMessage("rate-limited: slow down"), /slow down/);
  assert.match(rejectionMessage("weird"), /The server said no: weird/);
  assert.match(rejectionMessage(undefined), /did not answer/);
});

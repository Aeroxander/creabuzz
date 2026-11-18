import assert from "node:assert/strict";
import { test } from "node:test";
import {
  teamTaskRows,
  readProjectWork,
  projectWorkFilters,
  projectTaskHistoryFilters,
} from "./project-work.ts";

const founder = "a".repeat(64),
  teammate = "b".repeat(64),
  stranger = "c".repeat(64);
const coordinate = `37001:${founder}:project`;
const scope = {
  coordinate,
  authors: [founder, teammate],
  channels: ["public-room"],
};
const delivery = {
  project: coordinate,
  output: "https://example.com/demo",
  claim: null,
};
let serial = 0;
const row = (pubkey, body, tags = [], at = ++serial) => ({
  id: (++serial).toString(16).padStart(64, "0"),
  pubkey,
  kind: 44011,
  created_at: at,
  tags: [["d", "task"], ...tags],
  content: JSON.stringify(body),
  sig: "",
});
const bodyOf = (records) => JSON.parse(records[0].event.content);

test("neither a project citation, teammate assignee nor public channel endorses an outsider's task", () => {
  for (const tags of [
    [],
    [["p", founder]],
    [["h", "public-room"]],
    [
      ["a", coordinate],
      ["p", teammate],
    ],
  ]) {
    assert.deepEqual(
      teamTaskRows(
        [row(stranger, { title: "Injected", delivery }, tags)],
        scope,
      ),
      [],
    );
  }
});

test("foreign status, output and backdated creator rows cannot alter team-recorded work", () => {
  const official = row(
    founder,
    { title: "Build", status: "open", delivery },
    [["p", teammate]],
    10,
  );
  const injected = row(
    stranger,
    {
      title: "Paid!",
      status: "done",
      delivery: { ...delivery, output: "https://attacker.example" },
    },
    [],
    20,
  );
  const backdated = row(stranger, { title: "I created this", delivery }, [], 1);
  const records = teamTaskRows([injected, official, backdated], scope);
  assert.equal(records.length, 1);
  assert.equal(records[0].creator, founder);
  assert.equal(records[0].linkedBy, founder);
  assert.equal(bodyOf(records).title, "Build");
  assert.equal(bodyOf(records).status, "open");
  assert.equal(bodyOf(records).delivery.output, delivery.output);
});

test("team updates preserve attribution to the person who added the reference", () => {
  const linked = row(
    founder,
    { title: "Build", status: "open", delivery },
    [],
    10,
  );
  const status = row(teammate, { status: "needs_approval" }, [], 20);
  const records = teamTaskRows([status, linked], scope);
  assert.equal(bodyOf(records).status, "needs_approval");
  assert.equal(records[0].linkedBy, founder);
  const otherProject = row(
    teammate,
    { delivery: { ...delivery, project: `37001:${stranger}:project` } },
    [],
    30,
  );
  assert.deepEqual(teamTaskRows([linked, status, otherProject], scope), []);
});

test("malformed task content cannot crash project discovery", () => {
  assert.deepEqual(
    teamTaskRows([row(founder, null), row(founder, { title: {} })], scope),
    [],
  );
});

function matches(filter, event) {
  if (!filter.authors.includes(event.pubkey)) return false;
  if (!filter.kinds.includes(event.kind)) return false;
  if (!filter["#h"] && event.tags.some((t) => t[0] === "h")) return false;
  return Object.entries(filter)
    .filter(([k]) => k.startsWith("#"))
    .every(([k, values]) =>
      event.tags.some(([tag, v]) => tag === k.slice(1) && values.includes(v)),
    );
}
const queryFrom = (events) => async (filter) =>
  events
    .filter((e) => matches(filter, e))
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, filter.limit);

test("scoped project discovery survives unrelated traffic and reads later pre-tag updates", async () => {
  const original = row(
    founder,
    { title: "Original", status: "open", delivery },
    [["a", coordinate]],
    1,
  );
  const latest = row(founder, { status: "needs_approval" }, [], 2);
  const unrelated = Array.from({ length: 250 }, (_, n) => ({
    ...row(founder, { title: "Other work" }, [], 10 + n),
    tags: [["d", `other-${n}`]],
  }));
  const filters = [];
  const result = await readProjectWork(scope, async (f) => {
    filters.push(f);
    return queryFrom([original, latest, ...unrelated])(f);
  });
  assert.equal(result.records.length, 1);
  assert.equal(bodyOf(result.records).status, "needs_approval");
  assert.equal(result.truncated, true);
  assert.equal(result.incomplete, 0);
  assert(filters.some((f) => f["#a"]?.includes(coordinate)));
  assert(filters.some((f) => f["#d"]?.includes("task")));
  assert(filters.every((f) => f.authors.length > 0));
});

test("later team unlinking wins over stale project tags and scoped subscriptions retain privacy", async () => {
  const original = row(
    founder,
    { title: "Build", delivery },
    [
      ["a", coordinate],
      ["h", "public-room"],
    ],
    1,
  );
  const moved = row(
    founder,
    { delivery: { ...delivery, project: `37001:${founder}:elsewhere` } },
    [["h", "public-room"]],
    2,
  );
  const result = await readProjectWork(scope, queryFrom([original, moved]));
  assert.deepEqual(result.records, []);
  const filters = [
    ...projectWorkFilters(scope).slice(0, -1),
    ...projectTaskHistoryFilters(scope, ["task"]),
  ];
  assert(filters.every((f) => f["#a"] || f["#h"] || f["#d"]));
  assert(filters.every((f) => f.authors.includes(founder)));
});

test("failed reads propagate, partial channel reads stay incomplete", async () => {
  await assert.rejects(
    readProjectWork(scope, async () => {
      throw new Error("refused");
    }),
    /Could not read/,
  );
  const result = await readProjectWork(scope, async (f) => {
    if (f["#h"]) throw new Error("private channel refused");
    return [];
  });
  assert.equal(result.incomplete, 1);
  assert.deepEqual(result.records, []);
});

import assert from "node:assert/strict";
import test from "node:test";

import { idWord } from "@creaton/core/launchpad/work.ts";

import { mergeTaskRows } from "./task-planning.ts";
import {
  offeredPartOfKey,
  partOfChoices,
  partOfFromKey,
  partOfKey,
  readPartOf,
  taskPartOfTags,
} from "./task-part-of.ts";
import { taskDeliveryTags } from "./task-delivery.ts";

const FOUNDER = "a".repeat(64);
const project = `37001:${FOUNDER}:docs-project`;
const mandate = `0x${"b".repeat(40)}`;
const area = idWord("first-hour-notes");
const partOf = { project, mandate, area };

let seq = 0;
const row = (at, body, tags = []) => {
  seq += 1;
  return {
    id: seq.toString(16).padStart(64, "0"),
    pubkey: FOUNDER,
    created_at: at,
    kind: 44011,
    tags: [["d", "task-1"], ...tags],
    content: JSON.stringify(body),
    sig: "",
  };
};

test("a task's Part of link writes, reads back, and survives a row that leaves it out", () => {
  const linked = row(100, { title: "Write the notes", status: "open", partOf });
  const pickedUp = row(200, {
    title: "Write the notes",
    status: "in_progress",
  });
  const merged = JSON.parse(mergeTaskRows([pickedUp, linked]).event.content);
  assert.deepEqual(readPartOf(merged.partOf), partOf);
  // Unlinking is an explicit null, and it sticks.
  const unlinked = row(300, { status: "open", partOf: null });
  const after = JSON.parse(
    mergeTaskRows([linked, pickedUp, unlinked]).event.content,
  );
  assert.equal(readPartOf(after.partOf), null);
});

test("an old task without a Part of link still reads, as not linked", () => {
  const old = row(100, { title: "Old task", status: "open", reward: 5 });
  const merged = JSON.parse(mergeTaskRows([old]).event.content);
  assert.equal(readPartOf(merged.partOf), null);
  assert.equal(readPartOf(undefined), null);
});

test("a malformed link reads as none instead of pointing somewhere arbitrary", () => {
  assert.equal(readPartOf({ ...partOf, project: "arbitrary" }), null);
  assert.equal(readPartOf({ ...partOf, mandate: "0x12" }), null);
  assert.equal(readPartOf({ ...partOf, area: "docs" }), null);
  assert.equal(readPartOf("docs"), null);
  // Addresses compare lower case.
  assert.deepEqual(
    readPartOf({
      ...partOf,
      mandate: mandate.toUpperCase().replace("0X", "0x"),
    }),
    partOf,
  );
});

test("the link is indexed by the project's `a` tag, once, beside a delivery link", () => {
  const tags = [
    ["d", "task-1"],
    ["h", "room"],
  ];
  assert.deepEqual(taskPartOfTags(tags, partOf), [...tags, ["a", project]]);
  assert.deepEqual(taskPartOfTags(tags, null), tags);
  const both = taskPartOfTags(
    taskDeliveryTags(tags, { project, output: null, claim: null }),
    partOf,
  );
  assert.equal(both.filter((t) => t[0] === "a").length, 1);
});

test("a picker value round-trips to the same link", () => {
  assert.deepEqual(partOfFromKey(partOfKey(partOf)), partOf);
  assert.equal(partOfFromKey(""), null);
  assert.equal(partOfFromKey("nonsense"), null);
});

const projectRecord = (expiresAt, shares) => ({
  manager: `0x${"c".repeat(40)}`,
  budget: 0n,
  reserved: 0n,
  expiresAt,
  checkHash: `0x${"d".repeat(64)}`,
  shareBudget: shares,
  sharesAwarded: 0n,
});

test("the choices are each contributor project's open work areas, by title", () => {
  const work = {
    chainTime: 1_000,
    mandates: [
      {
        address: mandate.toUpperCase().replace("0X", "0x"),
        closed: false,
        isMilestonePanel: false,
        expiresAt: 5_000,
        projects: [
          { id: area, record: projectRecord(4_000, 10n) },
          // Ended: not offered.
          { id: idWord("old-area"), record: projectRecord(500, 10n) },
        ],
      },
    ],
  };
  const choices = partOfChoices([
    { coordinate: project, name: "Docs", work },
    { coordinate: `37001:${FOUNDER}:other`, name: "Other", work: undefined },
  ]);
  assert.equal(choices.length, 1);
  assert.equal(choices[0].name, "Docs");
  assert.deepEqual(
    choices[0].areas.map((a) => [a.title, partOfKey(a.link)]),
    [["First hour notes", partOfKey(partOf)]],
  );
});

test("the choices name an area by the title its Work tab shows, when one is published", () => {
  const work = {
    chainTime: 1_000,
    mandates: [
      {
        address: mandate,
        closed: false,
        isMilestonePanel: false,
        expiresAt: 5_000,
        projects: [{ id: area, record: projectRecord(4_000, 10n) }],
      },
    ],
  };
  const titles = new Map([["first-hour-notes", "Write the first-hour guide"]]);
  const [choice] = partOfChoices([
    { coordinate: project, name: "Docs", work, titles },
  ]);
  assert.equal(choice.areas[0].title, "Write the first-hour guide");
});

test("a choice whose area is no longer offered reads as none", () => {
  const choices = [
    {
      coordinate: project,
      name: "Docs",
      areas: [{ link: partOf, title: "x" }],
    },
  ];
  assert.equal(offeredPartOfKey(choices, partOfKey(partOf)), partOfKey(partOf));
  assert.equal(offeredPartOfKey([], partOfKey(partOf)), "");
  assert.equal(offeredPartOfKey(choices, ""), "");
});

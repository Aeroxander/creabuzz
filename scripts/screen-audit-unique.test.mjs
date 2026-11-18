import assert from "node:assert/strict";
import { test } from "node:test";

import {
  capturesFromIndex,
  unexplainedDuplicates,
} from "./screen-audit-unique.mjs";

const line = (record) => JSON.stringify(record);
const hashes = (table) => (record) =>
  table[`${record.stop}-${record.variant}`] ?? null;

test("the last line for a stop and width wins, and checked stops have no picture", () => {
  const captures = capturesFromIndex(
    [
      line({ stop: "b01-signup", variant: "phone", problem: "timeout" }),
      line({ stop: "b01-signup", variant: "phone", problem: "" }),
      line({ stop: "h06-sale-wizard", variant: "phone", checked: "absent" }),
      "",
    ].join("\n"),
  );
  assert.deepEqual(captures, [
    { stop: "b01-signup", variant: "phone", problem: "" },
  ]);
});

test("decision stops sharing one picture fail (the phone kind cards were hidden)", () => {
  const stops = [
    "g18-new-decision",
    "g19-decision-budget",
    "g20-decision-project",
  ];
  const captures = stops.map((stop) => ({ stop, variant: "phone" }));
  const table = Object.fromEntries(
    stops.map((stop) => [`${stop}-phone`, "aaa"]),
  );
  const problems = unexplainedDuplicates(captures, hashes(table));
  assert.equal(problems.length, 1);
  assert.deepEqual(
    problems[0].captures,
    stops.map((stop) => `${stop}-phone`).sort(),
  );
});

test("a redirect may equal the page it lands on", () => {
  const captures = [
    { stop: "h01-discover", variant: "desktop" },
    { stop: "h10-markets", variant: "desktop", redirected: true },
  ];
  const table = { "h01-discover-desktop": "x", "h10-markets-desktop": "x" };
  assert.deepEqual(unexplainedDuplicates(captures, hashes(table)), []);
});

test("sameAs explains a duplicate only when it names another member of the group", () => {
  const table = {
    "g01-overview-phone": "x",
    "g10-people-phone": "x",
    "g07-contrib-phone": "x",
  };
  const declared = [
    { stop: "g01-overview", variant: "phone" },
    { stop: "g10-people", variant: "phone", sameAs: "g01-overview" },
  ];
  assert.deepEqual(unexplainedDuplicates(declared, hashes(table)), []);
  // A look-alike declared for a stop that is not in the group explains nothing.
  const wrong = [
    { stop: "g07-contrib", variant: "phone" },
    { stop: "g10-people", variant: "phone", sameAs: "g01-overview" },
  ];
  assert.equal(unexplainedDuplicates(wrong, hashes(table)).length, 1);
});

test("different pictures and missing files pass", () => {
  const captures = [
    { stop: "a01", variant: "desktop" },
    { stop: "a02", variant: "desktop" },
    { stop: "a03", variant: "desktop" },
  ];
  const table = { "a01-desktop": "x", "a02-desktop": "y" };
  assert.deepEqual(unexplainedDuplicates(captures, hashes(table)), []);
});

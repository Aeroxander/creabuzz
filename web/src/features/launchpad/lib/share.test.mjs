import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptedWords,
  parseScorecardSlug,
  projectSharePath,
  shareWords,
} from "./share.ts";

const base = { name: "Nebula", app: "Creaton", url: "https://x.test/p" };

test("the share sentence states the record and ends with the link", () => {
  assert.equal(
    shareWords({ ...base, streak: 4, kept: 3, answered: 4 }),
    "Nebula on Creaton: 4 weeks in a row, 3 of 4 promises kept. https://x.test/p",
  );
  assert.equal(
    shareWords({ ...base, streak: 1, kept: 1, answered: 1 }),
    "Nebula on Creaton: 1 of 1 promise kept. https://x.test/p",
  );
});

test("with nothing on the record yet it claims nothing", () => {
  assert.equal(
    shareWords({ ...base, streak: null, kept: null, answered: null }),
    "Nebula on Creaton: follow along as it gets built. https://x.test/p",
  );
  assert.equal(
    shareWords({ ...base, streak: 0, kept: 0, answered: 0 }),
    "Nebula on Creaton: follow along as it gets built. https://x.test/p",
  );
});

test("the link names the project and its founder", () => {
  assert.equal(
    projectSharePath({ id: "my project", author: "ab".repeat(32) }),
    `/p/my%20project-${"ab".repeat(8)}`,
  );
});

test("a scorecard address reads back as the project id and the start of its founder's id", () => {
  assert.deepEqual(parseScorecardSlug(`open-atlas-${"ab".repeat(8)}`), {
    id: "open-atlas",
    founderStart: "ab".repeat(8),
  });
  // Too short a founder part, or none, names no project.
  assert.equal(parseScorecardSlug("open-atlas"), null);
  assert.equal(parseScorecardSlug(`atlas-${"ab".repeat(7)}`), null);
  assert.equal(parseScorecardSlug(`-${"ab".repeat(8)}`), null);
});

test("a brand-new project's words say it just started and claim nothing else", () => {
  assert.equal(
    shareWords({
      ...base,
      streak: 3,
      kept: 2,
      answered: 2,
      variant: "started",
    }),
    "Nebula on Creaton: just started. Follow along as it gets built. https://x.test/p",
  );
});

test("an accepted-work sentence names the piece or counts them, and states no price", () => {
  assert.equal(
    shareWords({
      ...base,
      streak: null,
      kept: null,
      answered: null,
      variant: "accepted",
      workTitle: "Write the guide",
    }),
    "Nebula on Creaton: Work accepted: Write the guide. https://x.test/p",
  );
  assert.equal(
    shareWords({
      ...base,
      streak: null,
      kept: 1,
      answered: 1,
      variant: "accepted",
      accepted: 2,
    }),
    "Nebula on Creaton: 2 pieces of work accepted, 1 of 1 promise kept. https://x.test/p",
  );
  assert.equal(acceptedWords({ accepted: 0 }), null);
  assert.equal(acceptedWords({ accepted: 1 }), "1 piece of work accepted");
});

test("given a variant, weeks in a row need two answered promises; without one they do not", () => {
  assert.equal(
    shareWords({ ...base, streak: 5, kept: 1, answered: 1, variant: "kept" }),
    "Nebula on Creaton: 1 of 1 promise kept. https://x.test/p",
  );
  assert.equal(
    shareWords({ ...base, streak: 5, kept: 2, answered: 2, variant: "kept" }),
    "Nebula on Creaton: 5 weeks in a row, 2 of 2 promises kept. https://x.test/p",
  );
  assert.equal(
    shareWords({ ...base, streak: 3, kept: null, answered: null }),
    "Nebula on Creaton: 3 weeks in a row. https://x.test/p",
  );
});

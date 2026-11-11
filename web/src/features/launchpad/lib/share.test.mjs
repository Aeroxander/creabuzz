import assert from "node:assert/strict";
import test from "node:test";

import { projectSharePath, shareWords } from "./share.ts";

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
    `/launchpad/my%20project?author=${"ab".repeat(32)}`,
  );
});

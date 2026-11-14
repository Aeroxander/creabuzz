import assert from "node:assert/strict";
import { test } from "node:test";

import { hasLiveRunAncestor } from "./e2e-run.mjs";

/**
 * The orphan predicate behind `reapOrphanServers` — the only thing standing
 * between "kill the squatter left by a killed run" and "kill a live run's
 * server". Table-driven over the process shapes seen in the wild (a run
 * killed with SIGKILL leaves `server -> 1`; a live run is
 * `server -> sh -> playwright -> e2e-run -> …`).
 */

/** Build a `pid -> {pid, ppid, command}` snapshot from `[pid, ppid, cmd]`. */
function snapshot(rows) {
  const byPid = new Map();
  for (const [pid, ppid, command] of rows) {
    byPid.set(pid, { pid, ppid, command });
  }
  return byPid;
}

const cases = [
  {
    name: "orphan: server reparented to launchd after its run was killed",
    proc: [100, 1, "node scripts/e2e-static-server.mjs"],
    rows: [
      [100, 1, "node scripts/e2e-static-server.mjs"],
      [1, 0, "/sbin/launchd"],
    ],
    expected: false,
  },
  {
    name: "orphan: owning process tree is entirely gone (no parent in ps)",
    proc: [100, 4242, "node scripts/e2e-static-server.mjs"],
    rows: [[100, 4242, "node scripts/e2e-static-server.mjs"]],
    expected: false,
  },
  {
    name: "active: playwright run is a grandparent (server -> sh -> playwright)",
    proc: [100, 101, "node scripts/e2e-static-server.mjs"],
    rows: [
      [100, 101, "node scripts/e2e-static-server.mjs"],
      [101, 102, "sh -c node scripts/e2e-static-server.mjs"],
      [
        102,
        103,
        "node /repo/node_modules/@playwright/test/cli.js test --project=smoke",
      ],
      [103, 1, "pnpm test:e2e:smoke"],
    ],
    expected: true,
  },
  {
    name: "active: e2e-run.mjs wrapper itself is the direct parent",
    proc: [100, 101, "node scripts/e2e-static-server.mjs"],
    rows: [
      [100, 101, "node scripts/e2e-static-server.mjs"],
      [101, 1, "node scripts/e2e-run.mjs --project=smoke"],
    ],
    expected: true,
  },
  {
    name: "self command must not count as a run owner (starts at parent)",
    proc: [100, 1, "node playwright/e2e-static-server.mjs"],
    rows: [
      [100, 1, "node playwright/e2e-static-server.mjs"],
      [1, 0, "/sbin/launchd"],
    ],
    expected: false,
  },
  {
    name: "bounded: run marker beyond the 40-level cap is not walked",
    proc: [100, 101, "node scripts/e2e-static-server.mjs"],
    rows: [
      ...Array.from({ length: 45 }, (_, i) => [100 + i, 101 + i, `level-${i}`]),
      [145, 1, "node /repo/node_modules/@playwright/test/cli.js test"],
    ],
    expected: false,
  },
  {
    name: "cycle-safe: self-parenting entry terminates instead of hanging",
    proc: [100, 100, "node scripts/e2e-static-server.mjs"],
    rows: [[100, 100, "node scripts/e2e-static-server.mjs"]],
    expected: false,
  },
];

for (const { name, proc, rows, expected } of cases) {
  test(name, () => {
    const [pid, ppid, command] = proc;
    assert.equal(
      hasLiveRunAncestor({ pid, ppid, command }, snapshot(rows)),
      expected,
    );
  });
}

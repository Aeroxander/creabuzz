import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * The launchpad query binds the production seam.
 *
 * `launch-query.test.mjs` pins the filter's shape; this pins that
 * `fetchLaunches` actually sends it — a pure helper nobody calls protects
 * nothing (Review-Proven Rule 3).
 */

const source = readFileSync(
  fileURLToPath(new URL("../use-launches.ts", import.meta.url)),
  "utf8",
);

function fetchLaunchesBody() {
  const start = source.indexOf("export async function fetchLaunches");
  assert.notEqual(start, -1, "fetchLaunches must exist");
  const end = source.indexOf("export function useLaunches", start);
  return source.slice(start, end === -1 ? undefined : end);
}

test("fetchLaunches queries through launchQueryFilter over the relay WS URL", () => {
  const body = fetchLaunchesBody();
  assert.match(
    body,
    /queryEvents\(relayWsUrl\(\),\s*launchQueryFilter\(\)\)/,
    "the directory read must use the pinned, explicit-kinded filter",
  );
});

test("the tombstone read is explicit-kinded too", () => {
  const start = source.indexOf("async function fetchTombstones");
  assert.notEqual(start, -1, "fetchTombstones must exist");
  const body = source.slice(
    start,
    source.indexOf("export async function fetchLaunches"),
  );
  assert.match(body, /kinds:\s*\[5\]/, "deletions must name their kind");
});

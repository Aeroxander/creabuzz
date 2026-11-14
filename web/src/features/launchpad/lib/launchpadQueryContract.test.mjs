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

function between(from, to) {
  const start = source.indexOf(from);
  assert.notEqual(start, -1, `${from} must exist`);
  const end = source.indexOf(to, start);
  return source.slice(start, end === -1 ? undefined : end);
}

test("a page of projects is read through projectPageFilter, project records alone", () => {
  const body = between(
    "export async function fetchProjectPage",
    "/** What is recorded against the projects",
  );
  assert.match(
    body,
    /queryEvents\(\s*relayWsUrl\(\),\s*projectPageFilter\(until \?\? undefined\),?\s*\)/,
    "the page read must use the pinned, explicit-kinded, bounded filter",
  );
});

test("news and reports are read through their own pinned filters, apart from the projects", () => {
  const body = between(
    "export async function fetchLaunchMirrors",
    "function composeLaunches",
  );
  assert.match(body, /queryEvents\(relayWsUrl\(\), launchUpdatesFilter\(\)\)/);
  assert.match(body, /queryEvents\(relayWsUrl\(\), launchReportsFilter\(\)\)/);
  // A full read is said, never passed off as everything.
  assert.match(body, /updates\.length >= LAUNCH_QUERY_LIMIT/);
  assert.match(body, /reports\.length >= LAUNCH_QUERY_LIMIT/);
});

test("the list hook pages with nextProjectPage and keeps a failed later page apart from the list's own failure", () => {
  const body = between(
    "export function useLaunches",
    "const scoreRootsQueryKey",
  );
  assert.match(
    body,
    /queryFn: \(\{ pageParam \}\) => fetchProjectPage\(pageParam\)/,
  );
  assert.match(
    body,
    /getNextPageParam: \(_last, pages\) => nextProjectPage\(pages\)/,
  );
  assert.match(body, /records\.isFetchNextPageError \? null : records\.error/);
  assert.match(
    body,
    /moreError: records\.isFetchNextPageError \? records\.error : null/,
  );
});

test("the tombstone read is explicit-kinded too", () => {
  const body = between("async function fetchTombstones", "const NO_TOMBSTONES");
  assert.match(body, /kinds:\s*\[5\]/, "deletions must name their kind");
});

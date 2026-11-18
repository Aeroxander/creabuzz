import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * A server that refused is not a server that "did not answer". QueryError only
 * tells the two apart when it is handed the failure itself (`error=`); given
 * just a message string it always shows the caller's "did not answer" words.
 *
 * JSX cannot be rendered under `node --test`, so the wiring is the seam: every
 * QueryError on these panels must pass the query's own error.
 */

const ROOT = new URL("../../../../", import.meta.url);

function read(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, ROOT)), "utf8");
}

const PANELS = [
  ["src/features/fleet/ui/WorkBoard.tsx", "work-load-error", "loadError"],
  ["src/features/fleet/ui/FleetView.tsx", "fleet-load-error", "loadError"],
  [
    "src/features/fleet/ui/FleetView.tsx",
    "fleet-tasks-load-error",
    "taskLoadError",
  ],
  ["src/features/search/ui/SearchResults.tsx", "search-error", "error"],
];

/**
 * The props of the `<QueryError ... />` element carrying this test id. Ends at
 * the element's own `/>` (brace depth 0), so a nested `<SignRecovery />` inside
 * a prop does not cut the element short.
 */
function queryErrorProps(source, testId) {
  const blocks = [];
  let at = source.indexOf("<QueryError");
  while (at !== -1) {
    let depth = 0;
    let end = at;
    for (; end < source.length; end++) {
      const c = source[end];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (depth === 0 && source.startsWith("/>", end)) break;
    }
    blocks.push(source.slice(at, end));
    at = source.indexOf("<QueryError", end);
  }
  const block = blocks.find((b) => b.includes(`testId="${testId}"`));
  assert.ok(block, `no QueryError with testId="${testId}"`);
  return block;
}

for (const [path, testId, errorName] of PANELS) {
  test(`${testId} hands QueryError the failure so a refusal is named`, () => {
    const props = queryErrorProps(read(path), testId);
    assert.match(
      props,
      new RegExp(`\\berror=\\{${errorName}\\}`),
      `${path} ${testId} must pass error={${errorName}}`,
    );
  });
}

/**
 * Handed the error, QueryError tells a signed-out reader to sign in "below"
 * and promises to retry. Rule 6: that sign-in must actually be there, and the
 * retry must have something to run, or the instruction is a dead end.
 */
for (const [path, testId] of PANELS) {
  test(`${testId} offers the sign-in it asks for and retries after it`, () => {
    const source = read(path);
    const props = queryErrorProps(source, testId);
    assert.match(
      props,
      /recovery=\{\(onUnlocked\) => \(\s*<SignRecovery[\s\S]*?autoResume[\s\S]*?onUnlocked=\{onUnlocked\}[\s\S]*?showHeadline=\{false\}/,
      `${path} ${testId} must pass a SignRecovery that resumes on unlock`,
    );
    assert.match(
      props,
      /\bonRetry=\{/,
      `${path} ${testId} must pass onRetry so unlocking re-runs the read`,
    );
    assert.match(
      props,
      /relayUrl=\{relayWsUrl\(\)\}/,
      `${path} ${testId} must show the server it asked`,
    );
    assert.match(
      source,
      /import \{ SignRecovery \} from "@\/features\/identity\/ui\/SignRecovery"/,
    );
  });
}

test("the tasks panel's retry remounts the section that owns the task read", () => {
  const source = read("src/features/fleet/ui/FleetView.tsx");
  const section = source.match(/<TasksSection\b[\s\S]*?\/>/)?.[0] ?? "";
  assert.match(section, /key=\{tasksEpoch\}/);
  assert.match(section, /onRetry=\{\(\) => setTasksEpoch\(/);
  // The read lives inside TasksSection, not in FleetView, or a new key would
  // not restart it.
  const fleetView = source.slice(source.indexOf("export function FleetView("));
  assert.doesNotMatch(fleetView, /useAgentTasks\(/);
});

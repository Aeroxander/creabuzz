import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Rule 6 contract: every surface that can demand a signature presents the
 * recovery inline — "Unlock your passkey before this browser can sign." must
 * never be a terminal state.
 *
 * JSX cannot be rendered under `node --test`, so the wiring is the seam:
 * each listed surface must either mount `SignRecovery` beside its error or
 * pass a `recovery` render prop to `QueryError` (which renders it beside the
 * message and retries the query on success).
 */

const ROOT = new URL("../../../../", import.meta.url);

function read(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, ROOT)), "utf8");
}

/** Dialogs/rows whose publish failure is rendered inline. */
const INLINE_SURFACES = [
  ["src/features/launchpad/ui/CreateLaunchDialog.tsx", "create a launch"],
  ["src/features/launchpad/ui/RecordBidDialog.tsx", "record a bid"],
  ["src/features/launchpad/ui/ManagePanel.tsx", "record a claim/verdict"],
  ["src/features/projects/ui/JoinDialog.tsx", "join a role"],
  ["src/features/projects/ui/PitchDialog.tsx", "pitch a project"],
  [
    "src/features/projects/ui/ProjectDetailPage.tsx",
    "approve/decline a request",
  ],
];

/** Query surfaces whose failure state carries the unlock action. */
const QUERY_SURFACES = [
  ["src/features/launchpad/ui/LaunchesPage.tsx", "launchpad"],
  ["src/features/projects/ui/BoardPage.tsx", "project board"],
  ["src/features/discover/ui/DiscoverPage.tsx", "discover"],
  ["src/features/projects/ui/ProjectDetailPage.tsx", "project detail"],
  ["src/features/communities/ui/CommunityHomePage.tsx", "community shell"],
  ["src/features/channels/ui/ChannelTimeline.tsx", "channel timeline"],
];

for (const [path, label] of INLINE_SURFACES) {
  test(`the ${label} flow renders SignRecovery beside its failure`, () => {
    const source = read(path);
    assert.match(
      source,
      /<SignRecovery/,
      `${path} must mount the inline passkey recovery`,
    );
    assert.match(
      source,
      /import \{ SignRecovery \} from "@\/features\/identity\/ui\/SignRecovery"/,
      `${path} must import the shared recovery component`,
    );
  });
}

for (const [path, label] of QUERY_SURFACES) {
  test(`the ${label} failure state carries the unlock action and the relay URL`, () => {
    const source = read(path);
    assert.match(
      source,
      /recovery=\{\(onUnlocked\)/,
      `${path} must pass recovery`,
    );
    assert.match(
      source,
      /showHeadline=\{false\}/,
      `${path} must not repeat the message`,
    );
    assert.match(
      source,
      /relayUrl=\{relayWsUrl\(\)\}/,
      `${path} must show the relay it asked`,
    );
    assert.match(
      source,
      /error=\{/,
      `${path} must pass the raw error for classification`,
    );
  });
}

test("the create-launch failure is rendered inside the dialog, not only as a toast", () => {
  const source = read("src/features/launchpad/ui/CreateLaunchDialog.tsx");
  assert.match(source, /publishError\?: string \| null/);
  assert.match(source, /message=\{publishError\}/);
  assert.match(source, /onUnlocked=\{\(\) => submit\(\)\}/);
  // Auto-resume: unlocking re-runs the intent the reader was performing.
  const page = read("src/features/launchpad/ui/LaunchesPage.tsx");
  assert.match(page, /publishError=\{\s*\n?\s*create\.isError/);
});

test("the bid dialog resumes the exact action that failed", () => {
  const source = read("src/features/launchpad/ui/RecordBidDialog.tsx");
  assert.match(source, /resumeRef\.current = submit;/);
  assert.match(source, /onUnlocked=\{\(\) => \{/);
});

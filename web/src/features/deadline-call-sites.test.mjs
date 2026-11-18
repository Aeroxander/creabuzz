import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Every server read and write at these call sites goes through `timedFetchStreamed` (`shared/lib/timed-fetch.ts`),
 * whose deadline covers the body as well as the headers: a connection that is accepted and then never answered, or
 * stalls mid-reply, ends with "the server did not answer" instead of a screen that waits forever. The hooks import Vite
 * aliases, so the node runner cannot load them; this reads their source. The deadline itself is tested in
 * `shared/lib/timed-fetch.test.mjs`, the git client's in `repos/lib/git-http.test.mjs`.
 */

const here = new URL(".", import.meta.url);
const source = (path) => readFileSync(new URL(path, here), "utf8");

/** A bare `fetch(` call: not `.fetch(`, not `timedFetch(`, not a name ending in fetch. */
const BARE_FETCH = /(^|[^.\w])fetch\(/m;

const SITES = {
  "identity/lib/siwe.ts": 3,
  "identity/ui/PolicyLinks.tsx": 1,
  "communities/use-bans.ts": 1,
  "communities/use-communities.ts": 1,
  "communities/use-access.ts": 2,
  "communities/use-self-serve.ts": 2,
  "moderation/use-moderation-queue.ts": 1,
  "moderation/use-escalated-reports.ts": 2,
  "repos/use-repo-refs.ts": 1,
  "board/use-board-reports.ts": 1,
  "workflows/use-workflow-runs.ts": 2,
  "launchpad/ask-ai.ts": 1,
  "launchpad/ui/EnforcementCard.tsx": 1,
  "launchpad/ui/TrustGateCard.tsx": 1,
  "channels/use-unread-rooms.ts": 2,
};

for (const [path, count] of Object.entries(SITES)) {
  test(`${path}: every server request has a deadline over its body too`, () => {
    const text = source(path);
    assert.doesNotMatch(text, BARE_FETCH, "a plain fetch has no deadline");
    assert.doesNotMatch(
      text,
      /\btimedFetch\(/,
      "a headers-only deadline leaves the body read unbounded",
    );
    assert.equal(
      (text.match(/\btimedFetchStreamed\(/g) ?? []).length,
      count,
      "each request site sends through timedFetchStreamed",
    );
  });
}

test("a body that never finished is a failed read, not 'the server did not say'", () => {
  // These read an optional document: an unreadable one means "not offered", but a timed-out one must stay a failure
  // so it is asked again instead of being cached as an answer.
  for (const path of [
    "communities/use-access.ts",
    "moderation/use-escalated-reports.ts",
    "channels/use-unread-rooms.ts",
  ]) {
    const text = source(path);
    assert.match(
      text,
      /\.json\(\)\.catch\(\(error: unknown\) => \{\s*if \(isServerTimeout\(error\)/,
      `${path} rethrows a body timeout`,
    );
  }
  assert.match(
    source("launchpad/ask-ai.ts"),
    /response\.json\(\)\.catch\(inTime\)/,
    "a stalled AI answer ends in the same words as no answer",
  );
});

test("a timeout is said as 'did not answer', not 'could not reach'", () => {
  for (const path of [
    "communities/use-bans.ts",
    "communities/use-access.ts",
    "communities/use-self-serve.ts",
  ]) {
    assert.match(
      source(path),
      /isServerTimeout\(error\)\s*\?\s*SERVER_DID_NOT_ANSWER/,
      path,
    );
  }
});

test("git clone and fetch run under one deadline with an aborting client", () => {
  const text = source("repos/git-client.ts");
  assert.doesNotMatch(
    text,
    /isomorphic-git\/http\/web/,
    "isomorphic-git's own client sends no signal",
  );
  assert.match(text, /withGitDeadline\(\(http\) =>\s*fetch\(\{/);
  assert.match(text, /withGitDeadline\(\(http\) =>\s*clone\(\{/);
});

test("identity/lib/siwe.ts: wallet registration waits long enough for the server's on-chain signature checks", () => {
  const text = source("identity/lib/siwe.ts");
  assert.match(text, /const REGISTRATION_TIMEOUT_MS = 30_000;/);
  assert.match(
    text,
    /timedFetchStreamed\(registrationUrl, \{[^}]*timeoutMs: REGISTRATION_TIMEOUT_MS,/,
  );
});

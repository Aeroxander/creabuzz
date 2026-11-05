import assert from "node:assert/strict";
import test from "node:test";

import { acceptJoinPolicy, POLICY_TIMEOUT_MS } from "./accept-policy.ts";
import { InviteRequestError, inviteProblem } from "./invite-errors.ts";

const AGREEMENT = { code: "abc", version: "v2", ageConfirmed: true };

/**
 * A server that takes the request and never answers: only the request's own signal ends it.
 * AbortSignal.timeout runs on an unref'd timer, so a pending request alone does not keep Node
 * running; the server holds the loop open while it waits, as a real socket would. The hold is
 * let go when the signal aborts and by release(), so nothing outlives the test.
 */
function silentServer() {
  const asked = [];
  let keepAlive;
  const release = () => clearInterval(keepAlive);
  const request = (url, init) => {
    asked.push({ url, init });
    keepAlive = setInterval(() => {}, 1_000);
    return new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => {
        release();
        reject(init.signal.reason);
      });
    });
  };
  return { asked, request, release };
}

test("agreeing to the terms waits as long as loading them does", () => {
  assert.equal(POLICY_TIMEOUT_MS, 10_000);
});

// A bounded test of its own: without the bound in the code this one waits for good, and is failed by its own timeout.
test("a server that never answers the agreement is given up on, and the page says so in words", {
  timeout: 5_000,
}, async (t) => {
  const { asked, request, release } = silentServer();
  // Also runs when the test is failed by its own timeout, so a missing bound cannot leave the process alive.
  t.after(release);
  const started = Date.now();
  const failure = await acceptJoinPolicy(AGREEMENT, {
    request,
    timeoutMs: 30,
  })
    .then(
      () => null,
      (error) => error,
    )
    .finally(release);
  assert.ok(failure, "the request must end with a failure, not wait for good");
  assert.equal(failure.name, "TimeoutError");
  assert.ok(Date.now() - started < 2_000);
  assert.equal(
    inviteProblem(failure).text,
    "The server didn't answer in time. Check your connection and try again.",
  );
  // What was sent is what the server reads.
  assert.equal(asked[0].url, "/api/invites/accept-policy");
  assert.deepEqual(JSON.parse(asked[0].init.body), {
    code: "abc",
    policy_version: "v2",
    age_confirmed: true,
  });
});

test("the receipt comes back, and refusals keep their codes", async () => {
  const answer = (status, json) => async () =>
    new Response(JSON.stringify(json), { status });
  assert.equal(
    await acceptJoinPolicy(AGREEMENT, {
      request: answer(200, { receipt: "r1" }),
    }),
    "r1",
  );
  const changed = await acceptJoinPolicy(AGREEMENT, {
    request: answer(400, { error: "bad" }),
  }).catch((error) => error);
  assert.ok(changed instanceof InviteRequestError);
  assert.equal(changed.message, "join_policy_not_accepted");
  const expired = await acceptJoinPolicy(AGREEMENT, {
    request: answer(410, { error: "invite_expired" }),
  }).catch((error) => error);
  assert.equal(expired.message, "invite_expired");
  assert.equal(expired.status, 410);
});

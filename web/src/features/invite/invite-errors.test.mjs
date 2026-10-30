import assert from "node:assert/strict";
import test from "node:test";

import { InviteRequestError, inviteProblem } from "./invite-errors.ts";

test("an invite that cannot be used says why, with nothing technical to show", () => {
  for (const [code, words] of [
    ["invite_exhausted", /reached its use limit/],
    ["invite_expired", /has expired/],
    ["invite_invalid", /is invalid/],
  ]) {
    const problem = inviteProblem(new InviteRequestError(code, 403));
    assert.match(problem.text, words);
    assert.equal(problem.detail, null);
    assert.equal(problem.reloadTerms, false);
  }
});

test("terms that changed, or an agreement that did not reach the server, load the terms again and ask for new ticks", () => {
  const changed = inviteProblem(
    new InviteRequestError("join_policy_not_accepted", 400),
  );
  assert.equal(
    changed.text,
    "The terms changed. Read them and tick the box again.",
  );
  assert.equal(changed.reloadTerms, true);

  const required = inviteProblem(
    new InviteRequestError("join_policy_required", 403),
  );
  assert.match(required.text, /agree to its terms/);
  assert.doesNotMatch(required.text, /join_policy/);
  assert.equal(required.reloadTerms, true);

  assert.equal(
    inviteProblem(new InviteRequestError("join_policy_not_configured", 404))
      .reloadTerms,
    true,
  );
});

test("the server's request limit and the invite's own limit are said in words", () => {
  assert.equal(
    inviteProblem(
      new InviteRequestError("rate-limited: quota exceeded; retry in 7s", 429),
    ).text,
    "You're doing that a bit fast. Try again in 7 seconds.",
  );
  const claims = inviteProblem(
    new InviteRequestError("too many invite claim attempts, slow down", 429),
  );
  assert.match(claims.text, /Wait a minute, then try again/);
  assert.equal(claims.detail, null);
  // Any other 429 is still a limit, not a mystery.
  assert.match(
    inviteProblem(new InviteRequestError("HTTP 429", 429)).text,
    /Wait a minute/,
  );
});

test("a refusal this page does not know gets plain words, and the server's own words go under Technical details", () => {
  const problem = inviteProblem(
    new InviteRequestError(
      "relay: no community is configured for this host",
      404,
    ),
  );
  assert.match(problem.text, /^Couldn't join with this invite\./);
  assert.equal(
    problem.detail,
    "relay: no community is configured for this host",
  );
  assert.equal(problem.reloadTerms, false);
  // Never the raw sentinel as the message itself.
  assert.doesNotMatch(problem.text, /relay|HTTP/);
});

test("a server that did not answer is told apart from one that refused", () => {
  const timeout = new Error("signal timed out");
  timeout.name = "TimeoutError";
  assert.match(inviteProblem(timeout).text, /didn't answer in time/);
  assert.match(
    inviteProblem(new TypeError("Failed to fetch")).text,
    /Couldn't reach the server/,
  );
});

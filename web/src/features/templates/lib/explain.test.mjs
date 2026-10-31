import test from "node:test";
import assert from "node:assert/strict";

import { explainStepFailure } from "./explain.ts";

const step = (kind) => ({ kind, item: "x", action: "create" });

test("a refusal says what to do next, and that what went through is kept", () => {
  const org = explainStepFailure(
    step("org"),
    new Error("restricted: only the owner may publish an org root"),
  );
  assert.match(org, /owner or an admin can set up the team/);
  assert.match(org, /Whatever already went through is kept/);
  assert.match(
    explainStepFailure(step("channel"), new Error("restricted: nope")),
    /can't create channels/,
  );
  assert.match(
    explainStepFailure(step("persona"), new Error("restricted: nope")),
    /permission/,
  );
  assert.match(
    explainStepFailure(step("doc"), new Error("rate-limited: slow down")),
    /slow down/,
  );
  assert.match(
    explainStepFailure(
      step("doc"),
      new Error("The connection closed before the server answered"),
    ),
    /connection dropped/,
  );
  assert.match(
    explainStepFailure(step("doc"), new Error("")),
    /did not answer/,
  );
  assert.match(
    explainStepFailure(step("doc"), new Error("invalid: bad tag")),
    /^Bad tag\. Whatever already went through is kept/,
  );
  // The server's internal failure is said plainly, never its code.
  const internal = explainStepFailure(
    step("doc"),
    new Error("error: database error: down"),
  );
  assert.doesNotMatch(internal, /error:|database/);
  assert.match(internal, /turned this step down/);
});

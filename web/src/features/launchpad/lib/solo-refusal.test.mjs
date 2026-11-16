import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkRefusalOf, SOMEONE_ELSE_CHECKS } from "./solo-refusal.ts";

const OWN_WORK =
  "restricted: a task's work must be confirmed by someone other than its helper";
const AGENT_LIMIT =
  "restricted: an agent account cannot check work, grant more time, or sign goals and promises; a person on the team must";

test("the server's two refusals of a check are told apart from every other failure", () => {
  assert.equal(checkRefusalOf(new Error(OWN_WORK)), "own-work");
  assert.equal(checkRefusalOf(new Error(`  ${AGENT_LIMIT} `)), "agent");
  assert.equal(checkRefusalOf(OWN_WORK), "own-work");
  assert.equal(checkRefusalOf(new Error("blocked: try later")), null);
  assert.equal(checkRefusalOf(new Error("rate-limited: slow down")), null);
  assert.equal(checkRefusalOf(undefined), null);
});

test("the words for it name what to do and carry no retry", () => {
  assert.match(SOMEONE_ELSE_CHECKS, /^Someone else is on this project now/);
  assert.doesNotMatch(SOMEONE_ELSE_CHECKS, /try again/i);
});

test("the server's own text is the text matched here", () => {
  const rust = readFileSync(
    fileURLToPath(
      new URL(
        "../../../../../crates/buzz-relay/src/handlers/launch_update_authority.rs",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  assert.ok(rust.includes(OWN_WORK), "OWN_WORK text changed on the server");
  assert.ok(
    rust.includes(AGENT_LIMIT),
    "AGENT_LIMIT text changed on the server",
  );
});

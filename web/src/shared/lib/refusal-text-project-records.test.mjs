import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { failureWords } from "./readable-error.ts";
import { restrictionOf, restrictionText } from "./refusal-text.ts";

const relay = (file) =>
  readFileSync(
    new URL(
      `../../../../crates/buzz-relay/src/handlers/${file}`,
      import.meta.url,
    ),
    "utf8",
  );

/** The server's own wording for each refusal, and what the app must say for it. */
const REFUSALS = [
  [
    "restricted: only this project's founder can post this",
    /Only this project's founder can post goals and promises\. Ask the founder/,
  ],
  [
    "restricted: only this project's team can post this",
    /Only this project's team can post this\. .*ask the founder to add you/,
  ],
  [
    "restricted: a task's work must be confirmed by someone other than its helper",
    /can't confirm it.*Ask someone else on the project's team/,
  ],
  [
    "restricted: only the helper this task names can post this",
    /Only the person this task names can do this\. .*ask the project's team/,
  ],
  [
    "invalid: this record names a project that is not on this server",
    /not on this server.*Check you are in the right community/,
  ],
  [
    "invalid: this step names a task that is not on this server",
    /no longer on this server.*Reload the page/,
  ],
  [
    "invalid: this step names a task from another project",
    /belongs to another project.*Open the task from its own project/,
  ],
];

test("each refusal of a project record is said in plain words with a next step, never as the server's code", () => {
  for (const [message, words] of REFUSALS) {
    const text = restrictionText(message);
    assert.match(text ?? "", words, message);
    assert.doesNotMatch(text, /restricted|invalid:/);
    // The same through the paths a failed send takes.
    assert.equal(restrictionOf(new Error(message)), text);
    assert.equal(failureWords(new Error(message)).text, text);
  }
  assert.equal(restrictionOf(new Error("Server publish timed out")), null);
  assert.equal(restrictionOf(undefined), null);
});

test("the wording mapped here is the wording the server sends", () => {
  const source = relay("launch_update_authority.rs").replace(/\s+/g, " ");
  for (const [message] of REFUSALS)
    assert.ok(
      source.includes(`"${message}"`),
      `the server no longer says: ${message}`,
    );
  assert.ok(
    relay("ingest.rs").includes(
      "invalid: deletion events must reference exactly one target via e or a tag",
    ),
  );
  assert.ok(relay("side_effects.rs").includes("a deletion cannot be deleted"));
});

test("a removal the server refuses says what happened", () => {
  assert.match(
    restrictionText(
      "invalid: deletion events must reference exactly one target via e or a tag (got e=2, a=0)",
    ),
    /one record at a time.*Nothing was removed/,
  );
  assert.match(
    restrictionText("a deletion cannot be deleted; deleting one has no effect"),
    /A removal can't be removed/,
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import { withNameFollowing } from "./profile-names.ts";

const edit = (display_name, name) => ({ display_name, name, about: "" });

test("the other name follows a renamed one when they were the same", () => {
  assert.deepEqual(
    withNameFollowing(edit("Nia P.", "Nia Patel"), {
      display_name: "Nia Patel",
      name: "Nia Patel",
    }),
    edit("Nia P.", "Nia P."),
  );
});

test("it follows when there was none", () => {
  assert.equal(withNameFollowing(edit("Mo", ""), {}).name, "Mo");
  assert.equal(withNameFollowing(edit("Mo", ""), undefined).name, "Mo");
});

test("a name set to something else elsewhere is kept", () => {
  assert.deepEqual(
    withNameFollowing(edit("Dev Tester", "dev"), {
      display_name: "Dev Tester",
      name: "dev",
    }),
    edit("Dev Tester", "dev"),
  );
});

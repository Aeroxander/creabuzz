import assert from "node:assert/strict";
import { test } from "node:test";

import {
  avatarName,
  bylineHandle,
  bylineName,
  SOMEONE,
} from "./person-name.ts";

test("a byline is the chosen name, or Someone while the profile loads or when there is none, never a key", () => {
  assert.equal(bylineName({ display_name: "Frida Lund" }), "Frida Lund");
  assert.equal(bylineName({ name: "frida" }), "frida");
  assert.equal(bylineName(undefined), SOMEONE);
  assert.equal(bylineName({}), SOMEONE);
});

test("no initials are built from a key, and no key stands in for a username", () => {
  assert.equal(avatarName(undefined), "");
  assert.equal(avatarName({ name: "Mo Haddad" }), "Mo Haddad");
  assert.equal(bylineHandle(undefined), null);
  assert.equal(
    bylineHandle({ nip05: "mo@creaton.example" }),
    "mo@creaton.example",
  );
});

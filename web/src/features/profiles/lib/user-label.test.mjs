import assert from "node:assert/strict";
import test from "node:test";

import { handleToAtName, pickUserHandle, pickUserName } from "./user-label.ts";

test("a display name is the username", () => {
  assert.equal(
    pickUserName({
      display_name: "Tyler",
      name: "tyler",
      nip05: "tyler@buzz.dev",
    }),
    "Tyler",
  );
});

test("the kind-0 name carries profiles that never set a display name", () => {
  assert.equal(pickUserName({ name: "tyler" }), "tyler");
});

test("the unique community username is the last resort before the pubkey", () => {
  assert.equal(pickUserName({ nip05: "tyler@buzz.dev" }), "tyler@buzz.dev");
});

test("surrounding whitespace never becomes part of the label", () => {
  assert.equal(pickUserName({ display_name: "  Tyler  " }), "Tyler");
});

test("a blank display name falls through instead of labelling someone empty", () => {
  assert.equal(pickUserName({ display_name: "   ", name: "tyler" }), "tyler");
  assert.equal(
    pickUserName({ display_name: "", nip05: "tyler@buzz.dev" }),
    "tyler@buzz.dev",
  );
});

test("a profile with no username at all reports none", () => {
  assert.equal(pickUserName({}), null);
  assert.equal(pickUserName(undefined), null);
  assert.equal(pickUserName(null), null);
  assert.equal(
    pickUserName({ display_name: " ", name: "", nip05: "  " }),
    null,
  );
});

test("the secondary handle is the NIP-05 username only", () => {
  assert.equal(
    pickUserHandle({ display_name: "Tyler", nip05: " tyler@buzz.dev " }),
    "tyler@buzz.dev",
  );
  assert.equal(pickUserHandle({ display_name: "Tyler" }), null);
  assert.equal(pickUserHandle(undefined), null);
});

test("an `@name` short form needs a real handle behind it", () => {
  assert.equal(handleToAtName("tyler@buzz.dev"), "@tyler");
  assert.equal(handleToAtName("  tyler@buzz.dev  "), "@tyler");
  assert.equal(handleToAtName(""), null);
  assert.equal(handleToAtName(undefined), null);
  // Malformed values are absent, not a bare `@`.
  assert.equal(handleToAtName("tyler"), null);
  assert.equal(handleToAtName("tyler@"), null);
  assert.equal(handleToAtName("@buzz.dev"), null);
});

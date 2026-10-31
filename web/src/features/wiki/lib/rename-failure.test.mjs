import assert from "node:assert/strict";
import test from "node:test";

import { RelayAnsweredError } from "../../../shared/lib/relay-failure.ts";
import {
  DELETE_FAILED_TEXT,
  RENAME_FAILED_TEXT,
  RenameIncompleteError,
  deleteFailureText,
  renameFailureText,
  renameInTwoWrites,
} from "./rename-failure.ts";

// What "Couldn't rename page" and "Couldn't delete page" go on to say.

const TIMED_OUT = "restricted: you are timed out until 1893456000";

test("a refused rename or delete says why, not that the server did not answer", () => {
  for (const say of [renameFailureText, deleteFailureText]) {
    assert.match(
      say(new Error(TIMED_OUT)),
      /^You are muted everywhere in this community until .*2030.*\. You can still read; you can post again then\.$/,
    );
    assert.equal(
      say(new Error("blocked: you are banned from this community")),
      "You are banned from this community.",
    );
    assert.equal(
      say(new Error("rate-limited: quota exceeded; retry in 4s")),
      "You're doing that a bit fast. Try again in 4 seconds.",
    );
  }
});

test("no answer or the server's internal failure says nothing changed, and to try again", () => {
  for (const raw of [
    new Error("Server query timed out after 15000ms"),
    new Error("WebSocket connection failed"),
    new RelayAnsweredError("error: database error: down"),
  ]) {
    assert.equal(renameFailureText(raw), RENAME_FAILED_TEXT);
    assert.equal(deleteFailureText(raw), DELETE_FAILED_TEXT);
  }
});

test("a rename that saved the new page but could not delete the old one says so", async () => {
  const writes = [];
  const refused = new Error(TIMED_OUT);
  const failure = await renameInTwoWrites(
    async () => writes.push("save new"),
    async () => {
      writes.push("delete old");
      throw refused;
    },
  ).catch((error) => error);
  assert.deepEqual(writes, ["save new", "delete old"]);
  assert.ok(failure instanceof RenameIncompleteError);
  assert.equal(failure.cause, refused);
  assert.match(
    renameFailureText(failure),
    /^Saved under the new name, but the old name is still there\. You are muted everywhere in this community until /,
  );
  // Without plain words for why: just what happened.
  assert.equal(
    renameFailureText(
      new RenameIncompleteError(new Error("WebSocket connection failed")),
    ),
    "Saved under the new name, but the old name is still there.",
  );
});

test("a refused save stops before the delete: nothing was renamed", async () => {
  const writes = [];
  const failure = await renameInTwoWrites(
    async () => {
      writes.push("save new");
      throw new Error("error: database error: down");
    },
    async () => writes.push("delete old"),
  ).catch((error) => error);
  assert.deepEqual(writes, ["save new"]);
  assert.ok(!(failure instanceof RenameIncompleteError));
  assert.equal(renameFailureText(failure), RENAME_FAILED_TEXT);
});

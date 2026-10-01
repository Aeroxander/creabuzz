import assert from "node:assert/strict";
import test from "node:test";

import {
  DELETE_LABEL,
  PURGE_LABEL,
  deleteDialogCopy,
  purgeConfirmed,
  purgeDialogCopy,
  restoreDialogCopy,
} from "./delete-copy.ts";

test("the restorable delete dialog tells authors where the page goes", () => {
  // The default delete for authors AND admins: a tombstone, not a purge.
  const copy = deleteDialogCopy("home");
  assert.equal(copy.title, "Delete “home”?");
  assert.equal(
    copy.description,
    "Moves the page to Recently deleted. Anyone on the team can restore it.",
  );
  assert.equal(copy.confirmLabel, "Delete page");
  // Nothing in the author copy promises permanent removal.
  assert.ok(!copy.description.includes("cannot be restored"));
});

test("the admin purge dialog is a separate, permanent intent", () => {
  const copy = purgeDialogCopy("home");
  assert.equal(copy.title, "Delete “home” permanently?");
  assert.equal(copy.confirmLabel, PURGE_LABEL);
  // The dialog says the content is removed from the server and cannot return.
  assert.ok(copy.description.includes("removed from the server"));
  assert.ok(copy.description.includes("cannot be restored"));
  // Distinct from the restorable dialog in every field.
  const restorable = deleteDialogCopy("home");
  assert.notEqual(copy.title, restorable.title);
  assert.notEqual(copy.description, restorable.description);
  assert.notEqual(copy.confirmLabel, restorable.confirmLabel);
});

test("purge confirmation is typed and exact", () => {
  assert.equal(purgeConfirmed("home", "home"), true);
  assert.equal(purgeConfirmed("  home  ", "home"), true);
  assert.equal(purgeConfirmed("hom", "home"), false);
  assert.equal(purgeConfirmed("Home", "home"), false);
  assert.equal(purgeConfirmed("", "home"), false);
});

test("the restore dialog is a plain, non-destructive confirm", () => {
  const copy = restoreDialogCopy("home");
  assert.equal(copy.title, "Restore this page?");
  assert.equal(
    copy.description,
    "“home” returns to the wiki as a new revision.",
  );
  assert.equal(copy.confirmLabel, "Restore");
});

test("the toolbar labels name the two intents", () => {
  assert.equal(DELETE_LABEL, "Delete");
  assert.equal(PURGE_LABEL, "Delete permanently");
});

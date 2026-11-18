import assert from "node:assert/strict";
import test from "node:test";

import { mergeProfileContent } from "./merge-profile.ts";

test("a name edit keeps the fields this screen does not know about", () => {
  // The regression: publishing only name/about deleted the avatar and handle.
  const current = {
    name: "Old",
    display_name: "Old",
    picture: "https://example.com/a.png",
    nip05: "alice@example.com",
    lud16: "alice@walletofsatoshi.com",
    banner: "https://example.com/b.png",
  };
  const merged = mergeProfileContent(current, {
    name: "Alice",
    about: "hi",
  });
  assert.equal(merged.name, "Alice");
  assert.equal(merged.display_name, "Alice");
  assert.equal(merged.about, "hi");
  assert.equal(merged.picture, "https://example.com/a.png");
  assert.equal(merged.nip05, "alice@example.com");
  assert.equal(merged.lud16, "alice@walletofsatoshi.com");
  assert.equal(merged.banner, "https://example.com/b.png");
});

test("an empty about clears it, an absent about leaves it", () => {
  const current = { about: "old about", picture: "p" };
  assert.equal(mergeProfileContent(current, { about: "  " }).about, undefined);
  assert.equal(mergeProfileContent(current, { name: "x" }).about, "old about");
});

test("picture is tri-state", () => {
  const current = { picture: "keep-me" };
  assert.equal(
    mergeProfileContent(current, { picture: null }).picture,
    undefined,
  );
  assert.equal(
    mergeProfileContent(current, { picture: "" }).picture,
    undefined,
  );
  assert.equal(mergeProfileContent(current, { picture: "new" }).picture, "new");
  assert.equal(mergeProfileContent(current, { name: "x" }).picture, "keep-me");
});

test("an empty name removes the name fields rather than storing blanks", () => {
  const merged = mergeProfileContent(
    { name: "Old", display_name: "Old" },
    { name: "  " },
  );
  assert.equal(merged.name, undefined);
  assert.equal(merged.display_name, undefined);
});

test("a profile with no prior content publishes just the patch", () => {
  assert.deepEqual(mergeProfileContent(null, { name: "Bob" }), {
    name: "Bob",
    display_name: "Bob",
  });
});

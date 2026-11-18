import assert from "node:assert/strict";
import test from "node:test";

import {
  PICTURE_MAX_BYTES,
  pictureFileProblem,
  pictureLinkProblem,
} from "./picture-check.ts";

test("a picture file of a kind every browser shows, and not too big, is taken", () => {
  for (const type of [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "IMAGE/PNG",
  ]) {
    assert.equal(pictureFileProblem({ type, size: 200_000 }), null, type);
  }
  assert.equal(
    pictureFileProblem({ type: "image/png", size: PICTURE_MAX_BYTES }),
    null,
  );
});

test("anything else is turned away in words, before it is read or sent", () => {
  assert.match(
    pictureFileProblem({ type: "application/pdf", size: 10 }),
    /isn't a picture.*PNG, JPEG, GIF or WebP/,
  );
  assert.match(pictureFileProblem({ type: "", size: 10 }), /isn't a picture/);
  assert.match(
    pictureFileProblem({ type: "image/heic", size: 10 }),
    /isn't a picture/,
  );
  assert.equal(
    pictureFileProblem({ type: "image/jpeg", size: PICTURE_MAX_BYTES + 1 }),
    "That picture is 11 MB. Choose one under 10 MB.",
  );
});

test("a pasted link must be a web address, and an empty one removes the picture", () => {
  assert.equal(pictureLinkProblem(""), null);
  assert.equal(pictureLinkProblem("   "), null);
  assert.equal(pictureLinkProblem("https://example.com/me.png"), null);
  assert.equal(pictureLinkProblem("http://example.com/me.png"), null);
  assert.match(pictureLinkProblem("me.png"), /isn't a web address/);
  assert.match(
    pictureLinkProblem("javascript:alert(1)"),
    /isn't a web address/,
  );
});

test("the picture a profile already has is never refused, so one set elsewhere keeps working", () => {
  assert.equal(pictureLinkProblem("ipfs://abc", "ipfs://abc"), null);
  assert.match(
    pictureLinkProblem("ipfs://other", "ipfs://abc"),
    /isn't a web address/,
  );
});

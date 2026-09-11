import assert from "node:assert/strict";
import test from "node:test";

import {
  MEBIBYTE,
  UPLOAD_LIMITS,
  uploadLimitFor,
  uploadSizeError,
} from "./upload-limits.ts";

test("the ceiling follows the media type", () => {
  assert.equal(uploadLimitFor("image/png"), UPLOAD_LIMITS.image);
  assert.equal(uploadLimitFor("IMAGE/PNG"), UPLOAD_LIMITS.image);
  assert.equal(uploadLimitFor("image/gif"), UPLOAD_LIMITS.gif);
  assert.equal(uploadLimitFor("video/mp4"), UPLOAD_LIMITS.video);
  assert.equal(uploadLimitFor("application/pdf"), UPLOAD_LIMITS.file);
  assert.equal(uploadLimitFor(""), UPLOAD_LIMITS.file);
});

test("an oversized file is refused before it is read", () => {
  const gif = { size: 11 * MEBIBYTE, type: "image/gif" };
  const message = uploadSizeError(gif);
  assert.match(String(message), /11 MB/);
  assert.match(String(message), /10 MB limit/);
  assert.match(String(message), /image\/gif/);
});

test("a file at or under the ceiling is accepted", () => {
  assert.equal(
    uploadSizeError({ size: UPLOAD_LIMITS.image, type: "image/png" }),
    null,
  );
  assert.equal(uploadSizeError({ size: 1, type: "video/mp4" }), null);
  // A small GIF is fine; the GIF ceiling is stricter than the image one.
  assert.equal(
    uploadSizeError({ size: 5 * MEBIBYTE, type: "image/gif" }),
    null,
  );
  assert.notEqual(
    uploadSizeError({ size: 20 * MEBIBYTE, type: "image/gif" }),
    null,
  );
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  mediaRefusalText,
  UPLOAD_NOT_A_PICTURE_TEXT,
  UPLOAD_NOT_ALLOWED_TEXT,
  UPLOAD_PAUSED_TEXT,
  UPLOAD_TOO_BIG_TEXT,
  UPLOAD_TOO_FAST_TEXT,
  UPLOAD_TOO_MANY_TEXT,
  UPLOAD_UNAVAILABLE_TEXT,
  UPLOAD_WRONG_KIND_TEXT,
  uploadFailureWords,
} from "./media-refusal.ts";
import { uploadSizeError } from "./upload-limits.ts";

// What a picture upload (profile picture, a post's picture, a chat attachment) says when the server refuses it.

const mediaErrors = readFileSync(
  new URL("../../../../crates/buzz-media/src/error.rs", import.meta.url),
  "utf8",
);
const FALLBACK =
  "Couldn't upload the picture. Try again, or paste a link to one instead.";

test("the server's media refusals are said in plain words, its own kept as detail", () => {
  const cases = [
    // Not on an invite-only server's list, and a ban: the server says the same for both.
    ["relay membership required", UPLOAD_NOT_ALLOWED_TEXT],
    ["upload rate limit exceeded", UPLOAD_TOO_FAST_TEXT],
    ["upload concurrency limit reached", UPLOAD_TOO_MANY_TEXT],
    ["media service temporarily unavailable", UPLOAD_UNAVAILABLE_TEXT],
    ["community writes are fenced", UPLOAD_PAUSED_TEXT],
    ["invalid image data", UPLOAD_NOT_A_PICTURE_TEXT],
    ["unknown content type", UPLOAD_WRONG_KIND_TEXT],
    ["disallowed content type: audio/mpeg", UPLOAD_WRONG_KIND_TEXT],
    ["file too large: 99 bytes (max 10)", UPLOAD_TOO_BIG_TEXT],
    ["image dimensions too large", UPLOAD_TOO_BIG_TEXT],
    ["upload failed (413)", UPLOAD_TOO_BIG_TEXT],
  ];
  for (const [raw, text] of cases) {
    assert.equal(mediaRefusalText(raw), text, raw);
    assert.deepEqual(uploadFailureWords(new Error(raw), FALLBACK), {
      text,
      detail: raw,
    });
  }
});

test("the limits say to wait, not to try again at once", () => {
  for (const raw of [
    "upload rate limit exceeded",
    "upload concurrency limit reached",
  ]) {
    const { text } = uploadFailureWords(new Error(raw), FALLBACK);
    assert.match(text, /Wait/);
    assert.notEqual(text, FALLBACK);
  }
});

test("the words matched are the server's own", () => {
  // If the server's words change, these stop matching and people see the fallback again.
  for (const words of [
    "relay membership required",
    "upload rate limit exceeded",
    "upload concurrency limit reached",
    "media service temporarily unavailable",
    "community writes are fenced",
    "invalid image data",
    "unknown content type",
    "disallowed content type: {0}",
    "image dimensions too large",
  ])
    assert.ok(
      mediaErrors.includes(`#[error("${words}")]`),
      `buzz-media no longer says "${words}"`,
    );
  assert.match(mediaErrors, /#\[error\("file too large: \{size\} bytes/);
});

test("anything else gets the caller's words; the app's own sentence is kept", () => {
  assert.deepEqual(
    uploadFailureWords(new Error("authentication failed"), FALLBACK),
    { text: FALLBACK, detail: "authentication failed" },
  );
  assert.deepEqual(uploadFailureWords(new Error("Failed to fetch"), FALLBACK), {
    text: FALLBACK,
    detail: "Failed to fetch",
  });
  assert.equal(
    uploadFailureWords(new Error("internal error"), FALLBACK).text,
    FALLBACK,
  );
  const tooBig = uploadSizeError({ size: 60 * 1024 * 1024, type: "image/png" });
  assert.deepEqual(uploadFailureWords(new Error(tooBig), FALLBACK), {
    text: tooBig,
    detail: null,
  });
  assert.equal(mediaRefusalText("relay membership required please"), null);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  mediaRefusalText,
  UPLOAD_HIDDEN_DETAILS_TEXT,
  uploadFailureWords,
} from "./media-refusal.ts";

const mediaErrors = readFileSync(
  new URL("../../../../crates/buzz-media/src/error.rs", import.meta.url),
  "utf8",
);

test("a picture the server refuses for a hidden detail is said in plain words, with the server's words kept", () => {
  const raw = "media contains metadata or a non-canonical metadata channel";
  assert.ok(mediaErrors.includes(raw), "the server still says it this way");
  assert.equal(mediaRefusalText(raw), UPLOAD_HIDDEN_DETAILS_TEXT);
  assert.deepEqual(uploadFailureWords(new Error(raw), "fallback"), {
    text: UPLOAD_HIDDEN_DETAILS_TEXT,
    detail: raw,
  });
});

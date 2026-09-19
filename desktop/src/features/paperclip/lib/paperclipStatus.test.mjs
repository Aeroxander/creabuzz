import assert from "node:assert/strict";
import test from "node:test";

import { parsePaperclipStatus } from "./paperclipStatus.ts";

test("parses a running status with an http url", () => {
  assert.deepEqual(
    parsePaperclipStatus({
      state: "running",
      url: "http://127.0.0.1:3100",
      error: null,
    }),
    {
      state: "running",
      url: "http://127.0.0.1:3100",
      error: null,
    },
  );
});

test("demotes a running status with a missing url to stopped", () => {
  assert.deepEqual(
    parsePaperclipStatus({ state: "running", url: null, error: null }),
    {
      state: "stopped",
      url: null,
      error: null,
    },
  );
});

test("rejects non-http urls even when the backend claims running", () => {
  assert.equal(
    parsePaperclipStatus({
      state: "running",
      url: "file:///etc/passwd",
      error: null,
    }).url,
    null,
  );
  assert.equal(
    parsePaperclipStatus({
      state: "running",
      url: "javascript:alert(1)",
      error: null,
    }).url,
    null,
  );
});

test("preserves the backend error message for error state", () => {
  assert.equal(
    parsePaperclipStatus({
      state: "error",
      url: null,
      error: "port 3100 in use",
    }).error,
    "port 3100 in use",
  );
});

test("substitutes a fallback message when error state has no message", () => {
  assert.equal(
    parsePaperclipStatus({ state: "error", url: null, error: null }).error,
    "Paperclip failed to start",
  );
});

test("unknown shapes are treated as stopped", () => {
  assert.deepEqual(parsePaperclipStatus(undefined), {
    state: "stopped",
    url: null,
    error: null,
  });
  assert.deepEqual(parsePaperclipStatus("running"), {
    state: "stopped",
    url: null,
    error: null,
  });
  assert.deepEqual(parsePaperclipStatus({ state: "paused" }), {
    state: "stopped",
    url: null,
    error: null,
  });
});

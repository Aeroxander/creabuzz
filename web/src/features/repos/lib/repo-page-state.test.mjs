import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { repoPageState } from "./repo-page-state.ts";

describe("repoPageState", () => {
  it("a failed read is an error with a retry, never 'not found'", () => {
    assert.equal(
      repoPageState({
        isLoading: false,
        error: new Error("timeout"),
        found: false,
      }),
      "error",
    );
  });

  it("an answered read without the repository is 'missing'", () => {
    assert.equal(
      repoPageState({ isLoading: false, error: null, found: false }),
      "missing",
    );
  });

  it("a repository already read stays when a later refresh fails", () => {
    assert.equal(
      repoPageState({ isLoading: false, error: new Error("x"), found: true }),
      "ready",
    );
  });

  it("loading wins, and a found repository is ready", () => {
    assert.equal(
      repoPageState({ isLoading: true, error: new Error("x"), found: false }),
      "loading",
    );
    assert.equal(
      repoPageState({ isLoading: false, error: null, found: true }),
      "ready",
    );
  });
});

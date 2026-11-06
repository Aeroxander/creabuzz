import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TERMS_NOT_LOADED } from "./account-copy.ts";

describe("the sign-up note for terms that could not be loaded", () => {
  it("says that no terms were agreed to", () => {
    assert.match(TERMS_NOT_LOADED, /could not be loaded/);
    assert.match(TERMS_NOT_LOADED, /not agreeing to any terms/);
  });

  it("says what happens next: asked when the server answers, no posting until then", () => {
    assert.match(TERMS_NOT_LOADED, /asked to agree/);
    assert.match(TERMS_NOT_LOADED, /cannot post or act/);
  });
});

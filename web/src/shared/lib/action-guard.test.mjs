import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  assertMayAct,
  setActionsBlocked,
  TermsNotAgreedError,
} from "./action-guard.ts";

beforeEach(() => setActionsBlocked(false));

describe("acting while changed terms are not agreed to", () => {
  it("lets every action through by default", () => {
    assert.doesNotThrow(() => assertMayAct());
  });

  it("refuses with words that say what happened and what to do next", () => {
    setActionsBlocked(true);
    assert.throws(
      () => assertMayAct(),
      (error) =>
        error instanceof TermsNotAgreedError &&
        /terms/i.test(error.message) &&
        /agree/i.test(error.message),
    );
  });

  it("lets actions through again once the terms are agreed to", () => {
    setActionsBlocked(true);
    setActionsBlocked(false);
    assert.doesNotThrow(() => assertMayAct());
  });
});

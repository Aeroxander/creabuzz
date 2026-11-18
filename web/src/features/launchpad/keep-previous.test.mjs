import assert from "node:assert/strict";
import test from "node:test";

import { keepIfSame } from "./keep-previous.ts";

const query = (...key) => ({ queryKey: key });

test("the last answer stays on screen while the next loads, if it was about the same DAO", () => {
  const keep = keepIfSame(2, "0xdao");
  const before = { claims: 3 };
  // The wallet connected: the key changed, the DAO did not.
  assert.equal(keep(before, query("launchpad", "work", "0xdao", null)), before);
});

test("an answer about another DAO is never shown in place of this one", () => {
  const keep = keepIfSame(2, "0xdao");
  assert.equal(
    keep({ claims: 3 }, query("launchpad", "work", "0xother", null)),
    undefined,
  );
});

test("with nothing before it there is nothing to keep", () => {
  const keep = keepIfSame(2, "0xdao");
  assert.equal(keep(undefined, undefined), undefined);
  assert.equal(keep({ claims: 1 }, undefined), undefined);
});

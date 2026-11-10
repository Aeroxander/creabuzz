import assert from "node:assert/strict";
import { test } from "node:test";

import { listedProject, notListedYet } from "./listing.ts";

/** What the short form makes: a draft with no sale terms at all. */
const quick = {
  stage: "draft",
  auction: null,
  token: null,
  requiredRaised: null,
  floorPrice: null,
  funding: null,
  tokenPlan: null,
  listing: null,
};
const draftSale = { ...quick, requiredRaised: "1000", floorPrice: "1" };
const raise = { ...draftSale, stage: "live", auction: "0xa1", token: "0xa2" };
const contributor = {
  ...quick,
  stage: "graduated",
  token: "0xc1",
  funding: { path: "contributors" },
  tokenPlan: { mode: "dao" },
};

test("a project started with the short form is listed in every build", () => {
  assert.equal(listedProject(quick, "draft", true), true);
  assert.equal(listedProject(quick, "draft", false), true);
});

test("a sale still being set up is not listed", () => {
  assert.equal(listedProject(draftSale, "draft", true), false);
  assert.equal(listedProject(draftSale, "draft", false), false);
});

test("a founder's 'Not listed yet' keeps any project out, whatever its stage or build", () => {
  for (const record of [quick, raise, contributor]) {
    const hidden = { ...record, listing: "unlisted" };
    assert.equal(notListedYet(hidden), true);
    for (const raises of [true, false])
      assert.equal(listedProject(hidden, hidden.stage, raises), false);
  }
});

test("only the exact word unlists: a record that never said is listed", () => {
  assert.equal(notListedYet({}), false);
  assert.equal(notListedYet({ listing: null }), false);
});

test("a contributor-only build still leaves a raise out; a build with raises lists it", () => {
  assert.equal(listedProject(raise, "live", true), true);
  assert.equal(listedProject(raise, "live", false), false);
  assert.equal(listedProject(contributor, "graduated", false), true);
});

test("the stage in effect decides, not the record's saved word", () => {
  // A sale whose record still says draft but which has opened (its receipts say so) is listed.
  assert.equal(listedProject(draftSale, "live", true), true);
});

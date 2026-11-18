import assert from "node:assert/strict";
import { test } from "node:test";

import { fundingLine, listedHere } from "./contributor-only.ts";

const bare = {
  stage: "draft",
  auction: null,
  token: null,
  requiredRaised: null,
  floorPrice: null,
  funding: null,
  tokenPlan: null,
};
const idea = { ...bare };
const contributor = {
  ...bare,
  stage: "graduated",
  token: "0x00000000000000000000000000000000000000c1",
  funding: {
    stance: "not-raising",
    seeking: ["contributors"],
    path: "contributors",
    opensAt: null,
    note: null,
  },
  tokenPlan: { mode: "dao" },
};
const raise = {
  ...bare,
  stage: "funding",
  auction: "0x00000000000000000000000000000000000000a1",
  token: "0x00000000000000000000000000000000000000a2",
  requiredRaised: "400000000000",
  floorPrice: "1000",
  funding: {
    stance: "raising",
    seeking: ["backers"],
    path: null,
    opensAt: null,
    note: null,
  },
  tokenPlan: { mode: "dao" },
};
// A sale whose terms are set but whose auction is not deployed yet: still a raise, never listed without raises.
const plannedRaise = { ...raise, stage: "draft", auction: null };

test("a build that offers raises lists every launch", () => {
  for (const record of [idea, contributor, raise, plannedRaise]) {
    assert.equal(listedHere(record, true), true);
  }
});

test("a contributor-only build lists contributor projects and ideas, never a raise", () => {
  assert.equal(listedHere(contributor, false), true);
  assert.equal(listedHere(idea, false), true);
  assert.equal(listedHere(raise, false), false);
  assert.equal(listedHere(plannedRaise, false), false);
  // A record that claims "contributors only" but links an auction is a sale, whatever it says.
  assert.equal(
    listedHere({ ...contributor, auction: raise.auction }, false),
    false,
  );
});

const resolved = (stance, seeking) => ({
  stance,
  seeking,
  path: null,
  note: null,
  opensAt: null,
  raisingNow: stance === "raising",
});

test("with raises the funding line is the whole declaration", () => {
  assert.equal(
    fundingLine(resolved("not-raising", ["contributors"]), true),
    "Not raising · looking for contributors",
  );
  assert.equal(fundingLine(resolved("raising", []), true), "Raising now");
});

test("a contributor-only build says who a project is looking for and nothing about raising", () => {
  assert.equal(
    fundingLine(resolved("not-raising", ["contributors"]), false),
    "Looking for contributors",
  );
  assert.equal(
    fundingLine(
      resolved("not-raising", ["contributors", "backers", "advisors"]),
      false,
    ),
    "Looking for contributors, advisors",
  );
  assert.equal(fundingLine(resolved("raising", ["backers"]), false), null);
  assert.equal(fundingLine(resolved("not-raising", []), false), null);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  investingFactoryFor,
  investingOffered,
  investingSwitchOn,
} from "./investing-offered.ts";

const FACTORY = `0x${"3a".repeat(20)}`;
const named = JSON.stringify({ 11155111: FACTORY });
const ON = { VITE_INVESTING: "1", VITE_BACKING_POOL_FACTORY: named };

test("a default build offers no investing at all", () => {
  assert.equal(investingOffered({}), false);
  assert.equal(investingOffered(undefined), false);
  assert.equal(investingOffered({ VITE_CONTRIBUTOR_ONLY: "1" }), false);
  assert.equal(investingSwitchOn({}), false);
});

test("a named factory alone offers nothing: the switch is also needed", () => {
  assert.equal(investingOffered({ VITE_BACKING_POOL_FACTORY: named }), false);
  for (const off of ["", " ", "0", "true", "yes", "11"]) {
    assert.equal(
      investingOffered({ ...ON, VITE_INVESTING: off }),
      false,
      JSON.stringify(off),
    );
  }
});

test("the switch alone offers nothing: there must be a pool factory to read", () => {
  assert.equal(investingOffered({ VITE_INVESTING: "1" }), false);
  for (const bad of ["", "  ", "{", "[]", '{"11155111":"nope"}']) {
    assert.equal(
      investingOffered({ VITE_INVESTING: "1", VITE_BACKING_POOL_FACTORY: bad }),
      false,
      JSON.stringify(bad),
    );
  }
});

test("the switch with a factory offers investing, in the contributor-only build too", () => {
  assert.equal(investingOffered(ON), true);
  assert.equal(investingOffered({ ...ON, VITE_CONTRIBUTOR_ONLY: "1" }), true);
});

test("the factory for a project's own network is never guessed", () => {
  assert.equal(investingFactoryFor("11155111", ON), FACTORY);
  assert.equal(investingFactoryFor(11155111, ON), FACTORY);
  assert.equal(investingFactoryFor("31337", ON), null);
  assert.equal(investingFactoryFor(null, ON), null);
  // With the switch off a named factory is not offered, even for its own network.
  assert.equal(
    investingFactoryFor("11155111", { VITE_BACKING_POOL_FACTORY: named }),
    null,
  );
});

// What the server says (BUZZ_INVESTING in its information document) wins over the build's switch, both ways.
const BUILT_OFF = { VITE_BACKING_POOL_FACTORY: named };

test("the server saying yes turns investing on in a build that names a pool factory and has no switch", () => {
  assert.equal(investingSwitchOn(BUILT_OFF, true), true);
  assert.equal(investingOffered(BUILT_OFF, true), true);
  assert.equal(investingFactoryFor(11155111, BUILT_OFF, true), FACTORY);
});

test("the server saying no turns investing off in a build whose switch is on", () => {
  assert.equal(investingSwitchOn(ON, false), false);
  assert.equal(investingOffered(ON, false), false);
  assert.equal(investingFactoryFor(11155111, ON, false), null);
});

test("a server that says nothing leaves the build's switch in charge", () => {
  assert.equal(investingOffered(ON, null), true);
  assert.equal(investingOffered(BUILT_OFF, null), false);
  assert.equal(investingOffered({}, null), false);
});

test("the server's yes alone offers nothing: the build still has to name a pool factory", () => {
  assert.equal(investingOffered({}, true), false);
  assert.equal(investingOffered({ VITE_CONTRIBUTOR_ONLY: "1" }, true), false);
  assert.equal(
    investingOffered({ VITE_BACKING_POOL_FACTORY: "{" }, true),
    false,
  );
});

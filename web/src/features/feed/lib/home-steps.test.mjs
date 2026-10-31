import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ROLE,
  hasChosenName,
  parseRole,
  stepsFor,
  wayInDone,
} from "./home-steps.ts";

const none = {
  named: false,
  lookedAtProject: false,
  follows: false,
  published: false,
};

test("someone starts as a helper until they say otherwise, and an old or bad stored value does not break it", () => {
  assert.equal(DEFAULT_ROLE, "helper");
  assert.equal(parseRole(null), "helper");
  assert.equal(parseRole("founder"), "founder");
  assert.equal(parseRole("helper"), "helper");
  assert.equal(parseRole("backer"), "helper");
  assert.equal(parseRole("admin"), "helper");
});

test("neither list asks for money, a sale or an AI helper", () => {
  for (const role of ["helper", "founder"]) {
    for (const step of stepsFor(role, none)) {
      assert.doesNotMatch(
        `${step.label} ${step.hint}`.toLowerCase(),
        /back|bid|sale|money|token|funding|ai helper|refund/,
        `${role}: ${step.label}`,
      );
    }
  }
});

test("a helper looks at a project and follows one; a founder starts theirs", () => {
  assert.deepEqual(
    stepsFor("helper", none).map((s) => s.id),
    ["name", "look", "follow"],
  );
  assert.deepEqual(
    stepsFor("founder", none).map((s) => s.id),
    ["name", "publish"],
  );
  assert.equal(
    stepsFor("founder", none).find((s) => s.id === "publish").to,
    "/start/contributor",
  );
});

test("nothing is ticked that has not happened", () => {
  for (const role of ["helper", "founder"]) {
    assert.ok(
      stepsFor(role, none).every((s) => !s.done),
      role,
    );
  }
});

test("a helper's way in is done once they have a name and follow someone", () => {
  assert.equal(wayInDone(stepsFor("helper", { ...none, named: true })), false);
  assert.equal(
    wayInDone(stepsFor("helper", { ...none, named: true, follows: true })),
    true,
  );
});

test("following counts as having looked, so the list never asks for a look that obviously happened", () => {
  const steps = stepsFor("helper", { ...none, follows: true });
  assert.equal(steps.find((s) => s.id === "look").done, true);
});

test("a founder's way in is done once they have a name and a published project", () => {
  assert.equal(wayInDone(stepsFor("founder", { ...none, named: true })), false);
  assert.equal(
    wayInDone(stepsFor("founder", { ...none, named: true, published: true })),
    true,
  );
});

test("the name step is done only for a name the person chose, not for any profile at all", () => {
  // No profile, or one with only words about them or a picture: the app shows a short key there, which is no name.
  assert.equal(hasChosenName(undefined), false);
  assert.equal(hasChosenName(null), false);
  assert.equal(hasChosenName({}), false);
  assert.equal(hasChosenName({ about: "I paint." }), false);
  assert.equal(hasChosenName({ picture: "https://example.com/me.png" }), false);
  assert.equal(hasChosenName({ name: "   ", display_name: "" }), false);
  // A name, under either field a profile may use.
  assert.equal(hasChosenName({ name: "Robin" }), true);
  assert.equal(hasChosenName({ display_name: "Robin Hale" }), true);
});

test("adding a name opens the profile editor in place, with no directions to follow", () => {
  for (const role of ["helper", "founder"]) {
    const name = stepsFor(role, none).find((s) => s.id === "name");
    assert.equal(name.editsProfile, true);
    assert.equal(name.to, null);
    assert.doesNotMatch(name.hint, /account menu/i);
  }
});

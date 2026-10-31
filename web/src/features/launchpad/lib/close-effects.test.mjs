import assert from "node:assert/strict";
import test from "node:test";

import { closeEffects } from "./close-effects.ts";

const claim = (status, project = "p1", sharesAwarded = false) => ({
  project,
  sharesAwarded,
  record: { status },
});
const project = (shareBudget, sharesAwarded) => ({
  record: { shareBudget, sharesAwarded },
});

test("paid work still waiting for its Shares award is counted: closing would end the award", () => {
  const effects = closeEffects({
    claims: [
      claim("Paid"),
      claim("Paid"),
      claim("Paid", "p1", true),
      claim("Open"),
      claim("Paid", null),
    ],
    projects: [],
  });
  // Two paid claims in a project and not yet awarded; the awarded, open and project-less ones are not.
  assert.equal(effects.awardsLost, 2);
});

test("allowance left unused across the projects is totalled", () => {
  const effects = closeEffects({
    claims: [],
    projects: [project(100n, 40n), project(50n, 50n), project(10n, 0n)],
  });
  assert.equal(effects.allowanceLost, 70n);
});

test("a budget with nothing waiting loses nothing, and a cut-off history says the counts may be low", () => {
  assert.deepEqual(closeEffects({ claims: [], projects: [] }), {
    awardsLost: 0,
    allowanceLost: 0n,
    unallocatedLost: 0n,
    incomplete: false,
  });
  assert.equal(
    closeEffects({ claims: [], projects: [], truncated: true }).incomplete,
    true,
  );
});

test("the Shares not yet given to any work area are given up too, and counted apart from those left in work areas", () => {
  const effects = closeEffects({
    claims: [],
    projects: [project(30_000n, 0n), project(20_000n, 8_000n)],
    created: { shareBudget: 300_000n },
    sharesAllocated: 50_000n,
  });
  assert.equal(effects.allowanceLost, 42_000n);
  assert.equal(effects.unallocatedLost, 250_000n);
});

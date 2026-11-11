import assert from "node:assert/strict";
import test from "node:test";

import { emptyExisting, planApply } from "@creaton/core/templates/apply.ts";
import { TEMPLATE_CATALOG } from "@creaton/core/templates/catalog.generated.ts";
import { TEMPLATE_INDEX } from "@creaton/core/templates/catalog-index.generated.ts";

import {
  canBackLaunch,
  discoverFilters,
  visibleSections,
} from "../../features/discover/lib/directory.ts";
import { mirrorOffered } from "../../features/feed/lib/mirror.ts";
import {
  fundingLine,
  listedHere,
} from "../../features/launchpad/lib/contributor-only.ts";
import {
  allowedTabs,
  founderSettings,
  ideaShowsTeamSurfaces,
} from "../../features/launchpad/lib/launch-tabs.ts";
import { raisesOffered } from "../../features/launchpad/lib/raises-offered.ts";
import { remixesOffered } from "../../features/launchpad/lib/remixes-offered.ts";
import {
  portfolioInNav,
  portfolioLabel,
} from "../../features/portfolio/lib/portfolio-label.ts";
import { startSteps } from "../../features/start/lib/start-steps.ts";
import {
  presetsFor,
  templateCounts,
} from "../../features/templates/lib/template-copy.ts";
import {
  notContributorOnlyBuild,
  courtOffered,
  identityDemoOffered,
  linkDeviceOffered,
} from "./build-gates.ts";

/**
 * The pilot build as a whole: the settings the hosted image builds with, passed through every gate the way its call site
 * passes them (`raisesOffered()` into the boolean rules, `!notContributorOnlyBuild()` into community setup). Each rule
 * has its own test beside it; this one fails when a gate stops reading the pilot's setting, or when the pilot's settings
 * stop switching it, which no single rule's test would see. The browser side is `tests/e2e/pilot-build.spec.ts`, run
 * against a build made with these settings by `scripts/web-pilot-e2e.sh`.
 */

/** What the hosted image's Dockerfile sets for the web build that changes what is offered. */
const PILOT = { VITE_CONTRIBUTOR_ONLY: "1" };
const raises = raisesOffered(PILOT);

const contributorProject = {
  stage: "graduated",
  auction: null,
  token: `0x${"5e".repeat(20)}`,
  requiredRaised: null,
  floorPrice: null,
  funding: {
    stance: "not-raising",
    seeking: ["contributors"],
    path: "contributors",
  },
  tokenPlan: { mode: "dao" },
};
const idea = {
  stage: "draft",
  auction: null,
  token: null,
  requiredRaised: null,
  floorPrice: null,
};
const raise = {
  stage: "live",
  auction: `0x${"ac".repeat(20)}`,
  token: `0x${"70".repeat(20)}`,
  requiredRaised: "6000000",
  floorPrice: "1000",
  tokenPlan: { mode: "dao" },
};

test("the pilot's settings switch off raises and everything beyond contributor projects", () => {
  assert.equal(raises, false);
  assert.equal(notContributorOnlyBuild(PILOT), false);
  assert.equal(remixesOffered(PILOT), false);
  // A built image is not a dev server.
  assert.equal(identityDemoOffered(PILOT, false), false);
  assert.equal(linkDeviceOffered(PILOT), false);
  assert.equal(courtOffered(PILOT, false), false);
});

test("the pilot lists contributor projects and ideas, never a raise, and offers nothing to back", () => {
  assert.equal(listedHere(contributorProject, raises), true);
  assert.equal(listedHere(idea, raises), true);
  assert.equal(listedHere(raise, raises), false);
  assert.equal(canBackLaunch("live", raises), false);
  assert.equal(canBackLaunch("funding", raises), false);
  assert.deepEqual(
    discoverFilters(raises).map((f) => f.label),
    ["All", "Projects", "Ideas"],
  );
  for (const filter of ["all", "fundraising", "ideas"]) {
    const sections = visibleSections(filter, raises);
    assert.equal(sections.daos, false, `${filter} shows DAOs`);
    assert.equal(sections.projects, false, `${filter} shows the pitch board`);
    assert.equal(sections.launches, true, `${filter} hides the projects`);
  }
  const line = fundingLine(
    { stance: "not-raising", seeking: ["contributors", "backers"] },
    raises,
  );
  assert.equal(line, "Looking for contributors");
});

test("the pilot's Start page offers a contributor project and an idea, and no raise", () => {
  const keys = startSteps(
    { madeProject: false, hasIdea: false, hasSale: false },
    raises,
  ).map((step) => step.key);
  assert.ok(!keys.includes("raise"), `steps: ${keys.join(", ")}`);
  assert.ok(keys.includes("idea"), `steps: ${keys.join(", ")}`);
});

test("the pilot's project pages: no helpers on an idea, small settings, the same contributor tabs", () => {
  assert.equal(allowedTabs("idea", raises)?.has("agents"), false);
  assert.equal(founderSettings("idea", raises), "settings");
  assert.equal(founderSettings("contributor", raises), "settings");
  assert.equal(ideaShowsTeamSurfaces(raises), false);
});

test("the pilot shows You only with an account, and copies nothing to other apps", () => {
  assert.equal(portfolioLabel(), "You");
  assert.equal(portfolioInNav(raises, false), false);
  assert.equal(portfolioInNav(raises, true), true);
  assert.equal(mirrorOffered({ raisesOffered: raises, access: "open" }), false);
});

test("community setup in the pilot counts and writes no AI helpers, for every bundled team", () => {
  for (const summary of TEMPLATE_INDEX) {
    assert.doesNotMatch(
      templateCounts(summary, raises),
      /helper/i,
      `${summary.id}'s counts`,
    );
  }
  for (const preset of presetsFor(raises)) {
    assert.doesNotMatch(preset.blurb, /\bAI\b|helper/i, preset.id);
  }
  // `use-template-apply.ts` asks for the contributor-only plan with `!notContributorOnlyBuild()`.
  const contributorOnly = !notContributorOnlyBuild(PILOT);
  for (const entry of Object.values(TEMPLATE_CATALOG)) {
    const steps = planApply(entry, emptyExisting(), { contributorOnly }).map(
      (step) => `${step.kind}:${step.item}`,
    );
    const helperSteps = steps.filter(
      (step) =>
        /^(persona|skill|workflow):/.test(step) ||
        step.startsWith("org:org:seat:") ||
        step === "org:org:budget",
    );
    assert.deepEqual(helperSteps, [], `${entry.template.id} plans helpers`);
  }
});

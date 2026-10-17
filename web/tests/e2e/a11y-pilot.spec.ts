import { expect, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { expectAccessible } from "../helpers/a11y";
import { createMockRelay } from "./mock-relay";

/**
 * The pages a pilot tester meets first, scanned by axe in light and dark: Home's checklist for a backer and for a
 * founder, a project's Overview with its milestones, and the Milestones tab.
 */

const NSEC = "22".repeat(32);
const ME = getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);
const FOUNDER = "ab".repeat(32);

const record = {
  id: "record-nebula",
  pubkey: FOUNDER,
  created_at: 100,
  kind: 37001,
  tags: [
    ["d", "nebula"],
    ["name", "Nebula"],
    ["t", "dao-launchpad"],
    ["chain", "11155111"],
  ],
  content: JSON.stringify({
    pitch: "An open-source tool that maps the night sky for everyone.",
    reviewerTerms:
      "Three reviewers, none on the team. Each agreed to answer within 7 days. Unpaid.",
    currency: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    stage: "live",
    floorPrice: "792281625140000",
    tickSpacing: "79228162514",
    requiredRaised: "299999999998",
    tokenPlan: {
      mode: "dao",
      name: "Nebula",
      symbol: "NEB",
      supply: "200000000",
    },
    unlocks: {
      mode: "milestones",
      allocationPct: 20,
      milestones: [
        { claim: "m1", label: "A public beta that works", percent: 50 },
        { claim: "m2", label: "Version 1.0 released", percent: 50 },
      ],
      months: null,
    },
  }),
  sig: "sig",
};

async function open(
  page: import("@playwright/test").Page,
  path: string,
  colorScheme: "light" | "dark",
) {
  const relay = createMockRelay();
  relay.seed(record);
  relay.seed({
    id: "profile-me",
    pubkey: ME,
    created_at: 50,
    kind: 0,
    tags: [],
    content: JSON.stringify({ name: "Mira Okafor" }),
    sig: "sig",
  });
  await relay.install(page);
  await page.emulateMedia({ colorScheme });
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
  }, NSEC);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(path);
}

for (const scheme of ["light", "dark"] as const) {
  test(`Home's checklist is accessible for a backer and for a founder (${scheme})`, async ({
    page,
  }) => {
    await open(page, "/", scheme);
    const list = page.getByTestId("home-getting-started");
    await expect(list).toBeVisible({ timeout: 20_000 });
    await expectAccessible(page, `home, backer, ${scheme}`);
    await list.getByTestId("home-role-founder").click();
    await expect(list.getByTestId("home-step-publish")).toBeVisible();
    await expectAccessible(page, `home, founder, ${scheme}`);
  });

  test(`a project's Overview with its milestones, and the Milestones tab, are accessible (${scheme})`, async ({
    page,
  }) => {
    await open(page, `/launchpad/nebula?author=${FOUNDER}`, scheme);
    await expect(page.getByTestId("launch-milestone-summary")).toBeVisible({
      timeout: 20_000,
    });
    await expectAccessible(page, `project overview, ${scheme}`);
    await page.getByTestId("launch-milestone-summary-open").click();
    await expect(page.getByTestId("milestones-tab")).toBeVisible();
    await expectAccessible(page, `milestones tab, ${scheme}`);
  });
}

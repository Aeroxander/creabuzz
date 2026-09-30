import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { createMockRelay } from "./mock-relay";

/**
 * Discover — the directory page, wired to the same four record sources the
 * derivation binds (kind:47005 `summon` receipts, kind:37018 deployments,
 * kind:37001 launches, kind:37015 pitches).
 *
 * What this spec proves end to end: the page renders all three sections from
 * one bounded query, the filter chips show exactly their own section, and
 * every CTA routes to a dialog/route that already exists — the join deep link
 * lands on the *real* JoinDialog, not a copy of it.
 */

const FOUNDER_NSEC = "11".repeat(32);
const FOUNDER = getPublicKey(hexBytes(FOUNDER_NSEC));
const BOB = "b".repeat(64);
const DAO = `0x${"11".repeat(20)}`;
const SUMMONER = `0x${"22".repeat(20)}`;
const CHAIN = "11155111";
const SEPOLIA = "https://sepolia.etherscan.io";
const SUMMON_TX = `0x${"c".repeat(64)}`;
/** Recent timestamps so the cards read "1 hour ago", not "690 months ago". */
const NOW = Math.floor(Date.now() / 1000);
const DEPLOY_TX = `0x${"d".repeat(64)}`;

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(
    hex.match(/.{2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? [],
  );
}

type Relay = ReturnType<typeof createMockRelay>;

function nodeEvent() {
  return {
    id: "d-node-1",
    pubkey: FOUNDER,
    created_at: NOW - 3_600,
    kind: 37010,
    tags: [
      ["d", "nebula"],
      ["name", "Nebula"],
      ["seat", FOUNDER],
    ],
    content: JSON.stringify({
      v: 1,
      name: "Nebula",
      kind: "team",
      holders: [FOUNDER],
      agent_seats: [],
    }),
    sig: "sig",
  };
}

function pitchEvent() {
  return {
    id: "d-pitch-1",
    pubkey: FOUNDER,
    created_at: NOW - 3_500,
    kind: 37015,
    tags: [
      ["d", "nebula"],
      ["name", "Nebula"],
      ["role", "founder", "The founder", "40"],
      ["role", "writer", "The writer", "12"],
      ["role", "designer", "The designer", "8"],
    ],
    content: JSON.stringify({
      v: 1,
      summary: "A social app for stargazers.",
      description: "Telescopes, meet timelines.",
      founderRole: "founder",
    }),
    sig: "sig",
  };
}

function grantEvent() {
  return {
    id: "d-grant-1",
    pubkey: FOUNDER,
    created_at: NOW - 3_400,
    kind: 37011,
    tags: [
      ["d", "nebula/designer"],
      ["grantee", BOB],
      ["org", "8"],
      ["role", "designer"],
      ["p", BOB],
    ],
    content: JSON.stringify({
      v: 1,
      issuer: FOUNDER,
      grantee: BOB,
      via: "nebula",
      verbs: [],
      parentGrant: null,
      expires: null,
      revoked: false,
    }),
    sig: "sig",
  };
}

/** A live launch for `nebula` — the receipt below graduates it. */
function launchEvent() {
  return {
    id: "d-launch-1",
    pubkey: FOUNDER,
    created_at: NOW - 3_200,
    kind: 37001,
    tags: [
      ["d", "nebula"],
      ["name", "Nebula Launch"],
      ["t", "dao-launchpad"],
      ["chain", CHAIN],
    ],
    content: JSON.stringify({
      pitch: "Telescopes, meet timelines.",
      stage: "live",
      currency: "USDC",
      budget: "1000000",
      requiredRaised: "6000000",
    }),
    sig: "sig",
  };
}

/** A second raise that is still open — `quasar` has no receipt yet. */
function quasarLaunchEvent() {
  return {
    id: "d-launch-2",
    pubkey: FOUNDER,
    created_at: NOW - 3_150,
    kind: 37001,
    tags: [
      ["d", "quasar"],
      ["name", "Quasar"],
      ["t", "dao-launchpad"],
      ["chain", CHAIN],
    ],
    content: JSON.stringify({
      pitch: "A telescope you can rent by the night.",
      stage: "live",
      currency: "USDC",
      budget: "2000000",
      requiredRaised: "12000000",
    }),
    sig: "sig",
  };
}

/** The summon receipt that proves the DAO address for `nebula`. */
function summonReceiptEvent() {
  return {
    id: "d-receipt-1",
    pubkey: FOUNDER,
    created_at: NOW - 3_100,
    kind: 47005,
    tags: [
      ["a", `37001:${FOUNDER}:nebula`],
      ["kind", "summon"],
      ["tx", SUMMON_TX],
    ],
    content: JSON.stringify({
      table: "summon",
      project: "nebula",
      summoner: SUMMONER,
      chain: CHAIN,
      dao: DAO,
      holders: [
        { pubkey: FOUNDER, role: "founder", pct: 40, address: DAO },
        { pubkey: BOB, role: "designer", pct: 8, address: DAO },
      ],
    }),
    sig: "sig",
  };
}

/** The Summoner's deployment for a second project, `orion` — no receipt. */
function deploymentEvent() {
  return {
    id: "d-deploy-1",
    pubkey: FOUNDER,
    created_at: NOW - 3_000,
    kind: 37018,
    tags: [
      ["d", `${CHAIN}:summoner`],
      ["chain", CHAIN],
      ["role", "summoner"],
      ["address", SUMMONER],
      ["tx", DEPLOY_TX],
    ],
    content: JSON.stringify({
      v: 1,
      block: 42,
      project: "orion",
      note: "summoned by the Summoner",
    }),
    sig: "sig",
  };
}

async function install(relay: Relay, page: Page, nsec: string = FOUNDER_NSEC) {
  await page.addInitScript(
    ([viewerNsec]) =>
      window.localStorage.setItem("buzz.identity.nsec", viewerNsec),
    [nsec],
  );
  await relay.install(page);
  relay.seed(nodeEvent());
  relay.seed(pitchEvent());
  relay.seed(grantEvent());
  relay.seed(launchEvent());
  relay.seed(quasarLaunchEvent());
  relay.seed(summonReceiptEvent());
  relay.seed(deploymentEvent());
}

test("the directory lists DAOs, live launches, and open projects", async ({
  page,
}) => {
  const relay = createMockRelay();
  await install(relay, page);

  await page.goto("/");
  const entry = page.getByRole("link", { name: "Discover" });
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(page).toHaveURL(/\/discover$/);

  // Section 1 — DAOs: the receipt's address, mono, with an explorer link.
  const daoList = page.getByTestId("discover-dao-list");
  await expect(daoList).toBeVisible();
  await expect(page.getByTestId("discover-dao")).toHaveCount(2);
  const nebula = page.getByTestId("discover-dao").filter({
    hasText: "Nebula",
  });
  await expect(nebula.getByTestId("discover-dao-title")).toHaveText("Nebula");
  const daoLink = nebula.getByRole("link", { name: new RegExp(DAO) });
  await expect(daoLink).toBeVisible();
  await expect(daoLink).toHaveAttribute("href", `${SEPOLIA}/address/${DAO}`);
  // Team size comes from the equity map (founder + the granted designer).
  await expect(nebula).toContainText("2 seats · equity map");

  // A deployment-only project is listed *and* labelled as a contract — it is
  // never dressed up as a treasury.
  const orion = page.getByTestId("discover-dao").filter({
    hasText: "orion",
  });
  await expect(orion).toContainText("Contract · summoner");
  await expect(orion).toContainText(SUMMONER);

  // Section 2 — launches: stage, target, and a CTA that matches the stage.
  await expect(page.getByTestId("discover-launch")).toHaveCount(2);

  // The summon receipt graduates this raise: the card says "Graduated" (not
  // the record's stale "live") and offers "View launch", never a bid the
  // auction would refuse.
  const graduated = page
    .getByTestId("discover-launch")
    .filter({ hasText: "Nebula Launch" });
  await expect(graduated.getByTestId("discover-launch-title")).toHaveText(
    "Nebula Launch",
  );
  await expect(graduated).toContainText("Graduated");
  await expect(graduated).toContainText("Target 6 USDC");
  await expect(
    graduated.getByRole("link", { name: /View launch/ }),
  ).toBeVisible();

  // The open raise offers the bid deep link.
  const openRaise = page
    .getByTestId("discover-launch")
    .filter({ hasText: "Quasar" });
  await expect(openRaise).toContainText("Live");
  await expect(openRaise).toContainText("Target 12 USDC");
  await expect(
    openRaise.getByRole("link", { name: /Back this launch/ }),
  ).toBeVisible();

  // Section 3 — open projects: the pitch, the open roles, the ask.
  const projectCard = page.getByTestId("discover-project");
  await expect(projectCard).toBeVisible();
  await expect(page.getByTestId("discover-project-title")).toHaveText("Nebula");
  await expect(page.getByTestId("discover-project-hiring")).toContainText(
    "Hiring",
  );
  await expect(projectCard.getByTestId("role-chip-open")).toHaveText(
    "The writer · 12%",
  );
  await expect(
    projectCard.getByRole("link", { name: "Request to join" }),
  ).toBeVisible();

  // Every row parsed — the honest counts line only appears when something
  // could not be listed.
  await expect(page.getByTestId("discover-counts")).toHaveCount(0);
});

test("each filter chip shows exactly its own section", async ({ page }) => {
  const relay = createMockRelay();
  await install(relay, page);

  await page.goto("/discover");

  await page.getByTestId("discover-filter-hiring").click();
  await expect(page.getByTestId("discover-project-list")).toBeVisible();
  await expect(page.getByTestId("discover-dao-list")).toHaveCount(0);
  await expect(page.getByTestId("discover-launch-list")).toHaveCount(0);

  await page.getByTestId("discover-filter-daos").click();
  await expect(page.getByTestId("discover-dao-list")).toBeVisible();
  await expect(page.getByTestId("discover-project-list")).toHaveCount(0);
  await expect(page.getByTestId("discover-launch-list")).toHaveCount(0);

  await page.getByTestId("discover-filter-fundraising").click();
  await expect(page.getByTestId("discover-launch-list")).toBeVisible();
  await expect(page.getByTestId("discover-dao-list")).toHaveCount(0);
  await expect(page.getByTestId("discover-project-list")).toHaveCount(0);

  await page.getByTestId("discover-filter-all").click();
  await expect(page.getByTestId("discover-dao-list")).toBeVisible();
  await expect(page.getByTestId("discover-launch-list")).toBeVisible();
  await expect(page.getByTestId("discover-project-list")).toBeVisible();
});

test("'Back this launch' deep-links the launchpad's bid action", async ({
  page,
}) => {
  const relay = createMockRelay();
  await install(relay, page);

  await page.goto("/discover");
  await page
    .getByTestId("discover-launch")
    .filter({ hasText: "Quasar" })
    .getByRole("link", { name: /Back this launch/ })
    .click();

  await expect(page).toHaveURL(/\/launchpad\/quasar\?/);
  await expect(page).toHaveURL(/action=bid/);
});

test("'Request to join' opens the real join dialog through the deep link", async ({
  page,
}) => {
  const relay = createMockRelay();
  // A visitor, not the founder: a founder has nothing to request, and the
  // deep link must not open a dialog for them either.
  await install(relay, page, "22".repeat(32));

  await page.goto("/discover");
  await page
    .getByTestId("discover-project")
    .getByRole("link", { name: "Request to join" })
    .click();

  await expect(page).toHaveURL(/\/projects\/nebula\?/);
  await expect(page).toHaveURL(/action=join/);
  // The JoinDialog itself — the field it owns, not a Discover-side copy.
  await expect(page.getByLabel("Why you")).toBeVisible({ timeout: 10_000 });
});

test("an empty relay says so and offers the pitch dialog", async ({ page }) => {
  const relay = createMockRelay();
  await page.addInitScript(
    ([nsec]) => window.localStorage.setItem("buzz.identity.nsec", nsec),
    [FOUNDER_NSEC],
  );
  await relay.install(page);

  await page.goto("/discover");
  const empty = page.getByTestId("discover-empty");
  await expect(empty).toBeVisible();
  await expect(empty).toContainText(
    "No projects on this relay yet — start one",
  );

  await empty.getByRole("button", { name: "Pitch a project" }).click();
  await expect(page.getByLabel("Project name")).toBeVisible();
});

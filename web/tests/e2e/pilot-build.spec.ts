import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { expectAccessible } from "../helpers/a11y";
import { COMMUNITY_HOST, createMockRelay } from "./mock-relay";

/**
 * The pilot build in the browser: the app built the way the hosted image builds it (`VITE_CONTRIBUTOR_ONLY=1`), against
 * a stubbed server. Run by `scripts/web-pilot-e2e.sh`, which makes that build in a folder of its own and serves it on
 * :4186 (E2E_DIST / E2E_PORT), so it never touches the shared suite's build on :4173. The default build's specs prove the
 * raise screens work; this one proves a pilot member never meets them, and meets what replaced them: Discover's projects
 * and ideas, Start's contributor project, "Your projects", the community Tasks board as plain to-dos, and setup with no AI
 * helpers. The rules themselves are unit-tested with the same settings (`src/app/lib/pilot-gates.test.mjs`).
 */

test.skip(
  process.env.E2E_PILOT_BUILD !== "1",
  "needs the contributor-only build: run scripts/web-pilot-e2e.sh",
);

const NSEC = "57".repeat(32);
const ME = getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);
const FOUNDER = "ab".repeat(32);
const ADMIN = "b".repeat(64);
const NOW = Math.floor(Date.now() / 1000);
const PHONE = { width: 390, height: 844 };
const CHANNEL_ID = "0f0f0f0f-1111-2222-3333-444444444444";

type Relay = ReturnType<typeof createMockRelay>;

function launch(
  d: string,
  name: string,
  content: Record<string, unknown>,
  extraTags: string[][] = [],
  createdAt = NOW - 3_600,
) {
  return {
    id: `launch-${d}`,
    pubkey: FOUNDER,
    created_at: createdAt,
    kind: 37001,
    tags: [
      ["d", d],
      ["name", name],
      ["t", "dao-launchpad"],
      ["chain", "31337"],
      ...extraTags,
    ],
    content: JSON.stringify(content),
    sig: "sig",
  };
}

const contributorProject = launch(
  "docs-commons",
  "Docs Commons",
  {
    pitch: "Open docs for everyone, written by the people who use them.",
    stage: "graduated",
    funding: {
      stance: "not-raising",
      seeking: ["contributors"],
      path: "contributors",
    },
    tokenPlan: {
      mode: "dao",
      name: "Docs Commons",
      symbol: "DOCS",
      supply: "100000",
    },
  },
  [
    ["admission", "community"],
    ["token", `0x${"5e".repeat(20)}`],
    ["treasury", `0x${"da".repeat(20)}`],
  ],
);

const idea = launch(
  "night-sky",
  "Night Sky Atlas",
  {
    pitch: "A map of the night sky anyone can add to.",
    stage: "draft",
  },
  [],
  NOW - 3_000,
);

/** A raise another build published to the same server: the pilot never lists it, and never offers to back it. */
const raise = launch(
  "quasar",
  "Quasar Telescope",
  {
    pitch: "A telescope you can rent by the night.",
    stage: "live",
    currency: "USDC",
    budget: "2000000",
    requiredRaised: "12000000",
    floorPrice: "1000",
    tokenPlan: { mode: "dao", name: "Quasar", symbol: "QSR", supply: "1000" },
  },
  [["auction", `0x${"ac".repeat(20)}`]],
  NOW - 2_000,
);

const general = {
  id: "chan-general",
  pubkey: ADMIN,
  created_at: 100,
  kind: 39000,
  tags: [
    ["d", CHANNEL_ID],
    ["name", "general"],
  ],
  content: "",
  sig: "sig",
};

/** The signed-in person owns the community, so whatever is missing is missing because of the build, not their role. */
const owner = {
  id: "members-owner",
  pubkey: ADMIN,
  created_at: 100,
  kind: 13534,
  tags: [["-"], ["member", ME, "owner"]],
  content: "",
  sig: "sig",
};

/** A task on the community board that an older build gave a points reward. */
const task = {
  id: `${"1".repeat(8)}${"e".repeat(56)}`,
  pubkey: ME,
  created_at: 1_700_000_200,
  kind: 44011,
  tags: [
    ["d", "task-docs"],
    ["p", ME],
  ],
  content: JSON.stringify({
    title: "Write the setup guide",
    description: "Plain words, one page",
    status: "done",
    milestone: "Public beta",
    reward: 40,
  }),
  sig: "0".repeat(128),
};

async function signIn(page: Page) {
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
    window.localStorage.setItem("buzz.identity.backedUp", "1");
  }, NSEC);
}

/**
 * A chain that answers every read with nothing: no logs, empty words. The pages here only need to render; what the
 * chain says about a project is the contributor journeys' business.
 */
async function quietChain(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "buzz.launchpad.rpc",
      `${window.location.origin}/test-rpc`,
    );
  });
  await page.route("**/test-rpc", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as
      | { id: number; method: string }
      | { id: number; method: string }[];
    const answer = ({ id, method }: { id: number; method: string }) => ({
      jsonrpc: "2.0",
      id,
      result:
        method === "eth_chainId"
          ? "0x7a69"
          : method === "eth_blockNumber"
            ? "0x20"
            : method === "eth_getLogs"
              ? []
              : method === "eth_getBlockByNumber"
                ? { number: "0x20", timestamp: `0x${NOW.toString(16)}` }
                : `0x${"0".repeat(64)}`,
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        Array.isArray(body) ? body.map(answer) : answer(body),
      ),
    });
  });
}

async function openCommunity(page: Page, relay: Relay) {
  relay.seed(general);
  relay.seed(owner);
  await relay.install(page);
  await signIn(page);
  await page.goto(`/c/${COMMUNITY_HOST}`);
  await page.getByTestId("content-pane").waitFor();
  if (await page.getByTestId("open-channel-list").isVisible()) {
    await page.getByTestId("open-channel-list").click();
  }
  // The owner's own entries are there, so the absent ones are absent for the build.
  await expect(page.getByTestId("work-toggle")).toBeVisible({
    timeout: 20_000,
  });
}

test("a community has no AI helpers or Org page, says Notices, and its setup counts no helpers", async ({
  page,
}) => {
  const relay = createMockRelay();
  await openCommunity(page, relay);
  await expect(page.getByTestId("start-project-toggle")).toBeVisible();
  await expect(page.getByTestId("fleet-toggle")).toHaveCount(0);
  await expect(page.getByTestId("org-toggle")).toHaveCount(0);
  await expect(page.getByTestId("dms-toggle")).toHaveText("Notices");

  await page.getByTestId("start-project-toggle").click();
  const picker = page.getByTestId("start-project");
  await expect(picker).toBeVisible();
  await expect(picker).toContainText("4 rooms · 2 boards · 3 shared pages");
  await expect(picker).not.toContainText(/AI helper/i);
  await page.getByTestId("template-preview-toggle").click();
  await expect(page.getByTestId("template-preview")).not.toContainText(
    /AI helper|helper limit/i,
  );
});

test("the community Tasks board is plain to-dos: no points, no claim, no addresses or network names", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(task);
  await openCommunity(page, relay);
  await page.getByTestId("work-toggle").click();
  await page.getByTestId("work-view-list").click();
  await page.getByText("Write the setup guide").first().click();
  const content = page.getByTestId("content-pane");
  await expect(content).toContainText("Write the setup guide");
  await expect(content.getByTestId("task-reward")).toHaveCount(0);
  await expect(content.getByTestId("task-claim")).toHaveCount(0);
  await expect(content).not.toContainText(/points/i);
  await expect(content).not.toContainText("0x");
  await expect(content).not.toContainText("network (");
});

test("the communities page offers no Repositories", async ({ page }) => {
  const relay = createMockRelay();
  await relay.install(page);
  await signIn(page);
  await page.goto("/c");
  await expect(page.getByRole("heading", { name: "Communities" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("link", { name: "Repositories" })).toHaveCount(0);
});

test("Discover lists projects and ideas, never a raise or a way to back one, and starts a project", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(contributorProject);
  relay.seed(idea);
  relay.seed(raise);
  await quietChain(page);
  await relay.install(page);
  await signIn(page);
  await page.goto("/discover");
  for (const [id, label] of [
    ["all", "All"],
    ["fundraising", "Projects"],
    ["ideas", "Ideas"],
  ]) {
    await expect(page.getByTestId(`discover-filter-${id}`)).toHaveText(label);
  }
  await expect(page.getByTestId("discover-filter-daos")).toHaveCount(0);
  await expect(page.getByTestId("discover-filter-hiring")).toHaveCount(0);
  const list = page.getByTestId("discover-launch-list");
  await expect(list).toContainText("Docs Commons", { timeout: 20_000 });
  await expect(list).toContainText("Night Sky Atlas");
  await expect(page.getByText("Quasar Telescope")).toHaveCount(0);
  await expect(page.getByText(/Back this launch/)).toHaveCount(0);
  await expect(page.getByTestId("discover-start-project")).toHaveAttribute(
    "href",
    "/start/contributor",
  );

  await page.getByTestId("discover-filter-ideas").click();
  await expect(list).toContainText("Night Sky Atlas");
  await expect(list).not.toContainText("Docs Commons");
});

test("with no ideas yet, the Ideas list says so and offers to share one", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(contributorProject);
  await quietChain(page);
  await relay.install(page);
  await signIn(page);
  await page.goto("/discover");
  await expect(page.getByTestId("discover-launch-list")).toContainText(
    "Docs Commons",
    { timeout: 20_000 },
  );
  await page.getByTestId("discover-filter-ideas").click();
  const empty = page.getByTestId("discover-launches-empty");
  await expect(empty).toContainText(
    "No ideas yet. Share one and it shows up here.",
  );
  await expect(empty.getByTestId("discover-share-idea")).toBeVisible();
});

test("the sale list and its wizard are not served: the address leads to Discover", async ({
  page,
}) => {
  const relay = createMockRelay();
  await relay.install(page);
  await signIn(page);
  for (const path of ["/launchpad", "/launchpad?start=sale"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/discover$/, { timeout: 20_000 });
    await expect(page.getByTestId("discover-filter-all")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Set up a sale/ }),
    ).toHaveCount(0);
    await expect(page.getByTestId("wizard-step-token")).toHaveCount(0);
  }
});

test("Start offers building with contributors, and no raise", async ({
  page,
}) => {
  const relay = createMockRelay();
  await relay.install(page);
  await signIn(page);
  await page.goto("/start");
  await page.getByText("More ways to start").click();
  const contributor = page.getByTestId("start-contributor");
  await expect(contributor).toContainText("Build with contributors", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("start-go-contributor")).toBeVisible();
  await expect(page.getByTestId("start-step-raise")).toHaveCount(0);
  await expect(page.getByTestId("start-steps")).not.toContainText(
    /raise|sale|backer/i,
  );
});

test("Start's contributor page defines Shares once, in the header, with the pilot build's words", async ({
  page,
}) => {
  const relay = createMockRelay();
  await relay.install(page);
  await signIn(page);
  await page.goto("/start/contributor");
  const intro = page.getByTestId("contributor-no-raise");
  await expect(intro).toContainText("How Shares work", { timeout: 20_000 });
  await expect(
    page
      .getByRole("heading", { level: 1 })
      .locator("xpath=following-sibling::p"),
  ).toHaveText(
    "Set up a project where reviewed work earns Shares, which are votes in the project.",
  );
  await expect(intro).not.toContainText(/are votes|voting tokens/i);
  await expect(
    page.getByText(/votes in the project|voting tokens/i),
  ).toHaveCount(1);
});

test("Home's navigation says Your projects, and only to someone with an account", async ({
  page,
}) => {
  const relay = createMockRelay();
  await relay.install(page);
  await page.goto("/");
  await expect(page.getByTestId("app-nav-home")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("app-nav-portfolio")).toHaveCount(0);

  await signIn(page);
  await page.goto("/");
  await expect(page.getByTestId("app-nav-portfolio")).toHaveText(
    /Your projects/,
    {
      timeout: 20_000,
    },
  );
});

test("a contributor project's Funds tab shows no Trading card: trading is off in the pilot build", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(contributorProject);
  await quietChain(page);
  await relay.install(page);
  await signIn(page);
  await page.goto(`/launchpad/docs-commons?author=${FOUNDER}&tab=treasury`);
  await expect(
    page.getByRole("tab", { name: "Funds", exact: true }),
  ).toHaveAttribute("aria-selected", "true", { timeout: 20_000 });
  // The Funds tab itself is there; the card, and its line about a network without trading, are not.
  await expect(page.getByTestId("contributor-funds")).toBeVisible();
  await expect(page.getByTestId("trading")).toHaveCount(0);
  await expect(page.getByText(/Trading isn't set up/)).toHaveCount(0);
});

for (const scheme of ["light", "dark"] as const) {
  test(`a contributor project's page is accessible on a phone (${scheme})`, async ({
    page,
  }) => {
    const relay = createMockRelay();
    relay.seed(contributorProject);
    await quietChain(page);
    await relay.install(page);
    await signIn(page);
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize(PHONE);
    await page.goto(`/launchpad/docs-commons?author=${FOUNDER}`);
    await expect(
      page.getByRole("heading", { name: "Docs Commons" }).first(),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Back this launch/)).toHaveCount(0);
    // Nothing wider than the phone: a page that scrolls sideways hides half of every line.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await expectAccessible(page, `contributor project on a phone, ${scheme}`);
  });
}

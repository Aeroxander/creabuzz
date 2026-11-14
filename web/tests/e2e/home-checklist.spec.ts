import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { createMockRelay } from "./mock-relay";

/**
 * Home's top block. Signed in, there is no "Get started" list at all, however new the account is; signed out, the
 * welcome still says what the product is for. The one door for starting something (the Start page) is covered below.
 */

const OWNER_NSEC = "55".repeat(32);
const OWNER = getPublicKey(
  Uint8Array.from(OWNER_NSEC.match(/.{2}/g) ?? [], (b) =>
    Number.parseInt(b, 16),
  ),
);

async function openHome(
  page: import("@playwright/test").Page,
  storage: Record<string, string> = {},
) {
  const relay = createMockRelay();
  relay.seed({
    id: "profile-1",
    pubkey: OWNER,
    created_at: 100,
    kind: 0,
    tags: [],
    content: JSON.stringify({ name: "Mira Okafor" }),
    sig: "sig",
  });
  await relay.install(page);
  await page.route("http://127.0.0.1:8545/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x10" }),
    }),
  );
  await page.addInitScript(
    ([nsec, extra]) => {
      window.localStorage.setItem("buzz.identity.nsec", nsec);
      for (const [key, value] of Object.entries(extra)) {
        window.localStorage.setItem(key, value);
      }
    },
    [OWNER_NSEC, storage] as const,
  );
  await page.goto("/");
}

/** Opens "More ways to start" unless it is already open (the page remembers it for the visit). */
async function openMoreWays(page: Page) {
  const more = page.getByTestId("start-more");
  if ((await more.getAttribute("open")) === null)
    await more.locator("summary").click();
}

test("a signed-in person never sees a Get started block on Home, however new the account", async ({
  page,
}) => {
  await openHome(page);
  // Home has rendered for them: its top area and the composer are there.
  await expect(page.getByTestId("home-top")).toBeAttached({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
  // Give anything that would load and then appear time to do so.
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("home-getting-started")).toHaveCount(0);
  await expect(page.getByText("Get started")).toHaveCount(0);
  await expect(page.getByTestId("home-welcome")).toHaveCount(0);
});

test.describe("the one door for starting something", () => {
  test("the Start button opens the steps in order, with the first one next", async ({
    page,
  }) => {
    await openHome(page);
    await page.getByTestId("app-nav-start").click();
    await expect(page).toHaveURL(/\/start$/);
    // The short form leads; the steps toward a raise are among the other ways to start.
    await openMoreWays(page);
    const steps = page.getByTestId("start-steps").getByRole("listitem");
    await expect(steps).toHaveCount(4);
    const titles = await steps.locator("h2").allTextContents();
    expect(titles).toEqual([
      "Set up a place to work",
      "Share your idea",
      "Raise money",
      "Run it together",
    ]);
    // Nothing has been done yet, so the first step is the next one and nothing is ticked.
    await expect(page.getByTestId("start-next")).toHaveCount(1);
    await expect(page.getByTestId("start-step-workspace")).toContainText(
      "Next",
    );
    await expect(page.getByTestId("start-steps")).not.toContainText("Done");
  });

  test("the idea and raise steps open their own dialogs, and a reload does not open them again", async ({
    page,
  }) => {
    await openHome(page);
    await page.goto("/start");
    await openMoreWays(page);
    await page.getByTestId("start-go-idea").click();
    await expect(page.getByLabel("What is it called?")).toBeVisible({
      timeout: 20_000,
    });
    // The link's parameter is spent as soon as the dialog opens.
    await expect(page).toHaveURL(/\/launchpad$/);
    await page.reload();
    await expect(page.getByTestId("start-idea")).toBeVisible();
    await expect(page.getByLabel("What is it called?")).toHaveCount(0);

    await page.goto("/start");
    await openMoreWays(page);
    await page.getByTestId("start-go-raise").click();
    await expect(
      page.locator('div[data-testid="wizard-step-token"]'),
    ).toBeVisible({ timeout: 20_000 });
  });

  test("an idea that was published ticks its step and moves the next one to raising money", async ({
    page,
  }) => {
    // A project was already made in this browser, so the idea is the only thing left before the sale.
    await openHome(page, {
      "creaton.first-steps": JSON.stringify(["project"]),
    });
    await page.goto("/start");
    await openMoreWays(page);
    await expect(page.getByTestId("start-step-workspace")).toContainText(
      "Done",
    );
    await expect(page.getByTestId("start-step-idea")).toContainText("Next");
    await page.getByTestId("start-go-idea").click();
    await page.getByLabel("What is it called?").fill("Nebula");
    await page
      .getByLabel("Say it in one sentence")
      .fill("An open-source tool that maps the night sky for everyone.");
    await page.getByRole("button", { name: "Put it out there" }).click();
    await page.waitForURL(/\/launchpad\/.+/, { timeout: 20_000 });

    await page.getByTestId("app-nav-start").click();
    await expect(page.getByTestId("start-step-idea")).toContainText("Done", {
      timeout: 20_000,
    });
    await expect(page.getByTestId("start-step-raise")).toContainText("Next");
    await expect(page.getByTestId("start-next")).toHaveCount(1);
  });
});

test("someone who is not signed in is told what this is in one sentence, with two ways in", async ({
  page,
}) => {
  const relay = createMockRelay();
  await relay.install(page);
  await page.goto("/");
  const welcome = page.getByTestId("home-welcome");
  await expect(welcome).toBeVisible({ timeout: 15_000 });
  await expect(welcome.getByRole("heading")).toContainText("Real projects,");
  await expect(welcome).toContainText("shows whether it kept its word");
  await expect(welcome).not.toContainText("tokens");
  await expect(welcome).not.toContainText("AI helpers");
  await expect(welcome).not.toContainText(/earn/i);
  // Two ways in, and no account asked for before there is a reason to have one.
  await expect(welcome.getByRole("link")).toHaveText([
    "Start a project",
    "Find work",
  ]);
  await expect(
    page.getByRole("button", { name: "Create your account" }),
  ).toHaveCount(0);
});

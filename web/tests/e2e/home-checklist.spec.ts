import { expect, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { createMockRelay } from "./mock-relay";

/**
 * Home's "Get started" list for someone who has just signed up. It asks different things of someone who came to back
 * projects and someone who came to build one. Every box is ticked only for something that really happened, the first
 * three are the way in, and the rest are for later and never hold the list open.
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

test("a new account starts as a backer: asked to look at a project and follow or back one, never to start a project or run a helper", async ({
  page,
}) => {
  await openHome(page);
  const list = page.getByTestId("home-getting-started");
  await expect(list).toBeVisible({ timeout: 20_000 });
  // The name is real (the profile above), the rest has not happened.
  await expect(list).toContainText("1 of 3 done");
  await expect(list.getByText("Look at a project")).toBeVisible();
  await expect(list.getByText("Follow a project, or back one")).toBeVisible();
  // Backing money is for later and never holds the list open.
  await expect(
    list.getByText("Optional, for when you have read"),
  ).toBeVisible();
  // A backer is not asked to do a founder's work.
  await expect(list).not.toContainText("ready-made team");
  await expect(list).not.toContainText("AI helper");
  await expect(list.getByRole("link", { name: "Go" }).first()).toHaveAttribute(
    "href",
    "/discover",
  );
});

test("a founder is asked to publish a project and set up its funding agreement; workspace and helper wait", async ({
  page,
}) => {
  await openHome(page);
  const list = page.getByTestId("home-getting-started");
  await expect(list).toBeVisible({ timeout: 20_000 });
  await list.getByTestId("home-role-founder").click();
  await expect(list).toContainText("1 of 3 done");
  await expect(list.getByText("Publish your project")).toBeVisible();
  await expect(list.getByText("Set up your funding agreement")).toBeVisible();
  // The workspace and the AI helper are still there, marked optional, and not counted.
  await expect(list.getByTestId("home-step-workspace")).toContainText(
    "Optional.",
  );
  await expect(list.getByTestId("home-step-helper")).toContainText("Optional.");
  // The choice is remembered, and a backer is not shown the founder's list on the next visit by accident.
  await page.reload();
  await expect(page.getByTestId("home-role-founder")).toHaveAttribute(
    "aria-pressed",
    "true",
    { timeout: 20_000 },
  );
});

test("looking at a project in this browser ticks that box", async ({
  page,
}) => {
  await openHome(page, {
    "creaton.first-steps": JSON.stringify(["looked-at-project"]),
  });
  const list = page.getByTestId("home-getting-started");
  await expect(list).toContainText("2 of 3 done", { timeout: 20_000 });
});

test.describe("the one door for starting something", () => {
  test("the Start button opens the steps in order, with the first one next", async ({
    page,
  }) => {
    await openHome(page);
    await page.getByTestId("app-nav-start").click();
    await expect(page).toHaveURL(/\/start$/);
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

  test("Home's checklist links to it", async ({ page }) => {
    await openHome(page);
    await page.getByTestId("home-start-link").click();
    await expect(page).toHaveURL(/\/start$/);
  });
});

test("someone who is not signed in is told what the product is for: backing teams whose tokens unlock with their milestones", async ({
  page,
}) => {
  const relay = createMockRelay();
  await relay.install(page);
  await page.goto("/");
  const welcome = page.getByTestId("home-welcome");
  await expect(welcome).toBeVisible({ timeout: 15_000 });
  // Funding and milestone accountability come first; the helpers are one of three supporting ideas, not the headline.
  await expect(welcome.getByRole("heading")).toContainText("Back teams.");
  await expect(welcome.getByRole("heading")).not.toContainText("AI helpers");
  await expect(welcome).toContainText(
    "see the team's tokens unlock when named reviewers approve delivery",
  );
  await expect(welcome).toContainText(
    "The team's tokens unlock with its milestones",
  );
  await expect(welcome).toContainText("AI helpers do the legwork");
});

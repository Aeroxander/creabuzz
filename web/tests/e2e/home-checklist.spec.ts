import { expect, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { createMockRelay } from "./mock-relay";

/**
 * Home's "Get started" list for someone who has just signed up. Every box is
 * ticked only for something that really happened in this browser, the first
 * three are the way in, and the last two are for later and never hold the list
 * open.
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

test("a new account is asked to start a project and run a helper, and nothing is pre-ticked", async ({
  page,
}) => {
  await openHome(page);
  const list = page.getByTestId("home-getting-started");
  await expect(list).toBeVisible({ timeout: 20_000 });
  // The name is real (the profile above), the rest has not happened.
  await expect(list).toContainText("1 of 3 done");
  await expect(
    list.getByText("Start a project with a ready-made team"),
  ).toBeVisible();
  await expect(list.getByText("Put an AI helper to work")).toBeVisible();
  // The later steps are shown, marked as optional, and not counted.
  await expect(list.getByText("Optional. Their posts")).toBeVisible();
  await expect(
    list.getByText("Optional, for when you're ready."),
  ).toBeVisible();
  // A project and a helper both point at the communities, where they are made.
  await expect(list.getByRole("link", { name: "Go" }).first()).toHaveAttribute(
    "href",
    "/c",
  );
});

test("a helper started here ticks its box, and the list goes away when the way in is done", async ({
  page,
}) => {
  await openHome(page, { "creaton.first-steps": JSON.stringify(["project"]) });
  const list = page.getByTestId("home-getting-started");
  // Name and project are done; the helper is what is left. Seeing this first
  // is what makes the list's later absence mean something.
  await expect(list).toContainText("2 of 3 done", { timeout: 20_000 });

  // Run a helper (its key appears in this browser), then come back to Home.
  await page.evaluate(() =>
    window.localStorage.setItem("buzz.agent.nsec", "ab".repeat(32)),
  );
  await page.getByRole("link", { name: "Social" }).click();
  await expect(page).toHaveURL(/\/social/);
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Home", exact: true })
    .click();
  await expect(page.getByTestId("user-chip")).toBeVisible();
  await expect(page.getByTestId("home-getting-started")).toHaveCount(0);
});

test("with only the project done, the list says what is left", async ({
  page,
}) => {
  await openHome(page, { "creaton.first-steps": JSON.stringify(["project"]) });
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

test("someone who is not signed in is told what the product is for: backing teams that have to earn their tokens", async ({
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
    "stays locked until named reviewers approve the agreed milestones",
  );
  await expect(welcome).toContainText("Milestones the team has to earn");
  await expect(welcome).toContainText("AI helpers do the legwork");
});

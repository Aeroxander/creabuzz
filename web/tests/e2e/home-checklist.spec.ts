import { expect, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { createMockRelay } from "./mock-relay";

/**
 * Home's "Get started" list for someone who has just signed up. It asks different things of someone who came to help on
 * projects and someone starting one. Every box is ticked only for something that really happened.
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

test("a new account starts as a helper: asked to look at a project and follow one, never about money", async ({
  page,
}) => {
  await openHome(page);
  const list = page.getByTestId("home-getting-started");
  await expect(list).toBeVisible({ timeout: 20_000 });
  // The name is real (the profile above), the rest has not happened.
  await expect(list).toContainText("1 of 3 done");
  await expect(list.getByText("Look at a project")).toBeVisible();
  await expect(list.getByText("Follow a project or a person")).toBeVisible();
  // This release has no sales: nothing asks anyone to back, bid or put money in.
  await expect(list).not.toContainText(/back a project|bid|sale|money/i);
  await expect(list.getByRole("link", { name: "Go" }).first()).toHaveAttribute(
    "href",
    "/discover",
  );
});

test("someone starting a project is sent to start it with the work it needs, and the choice is remembered", async ({
  page,
}) => {
  await openHome(page);
  const list = page.getByTestId("home-getting-started");
  await expect(list).toBeVisible({ timeout: 20_000 });
  await list.getByTestId("home-role-founder").click();
  await expect(list).toContainText("1 of 2 done");
  await expect(list.getByText("Start your project")).toBeVisible();
  await expect(list.getByRole("link", { name: "Go" })).toHaveAttribute(
    "href",
    "/start/contributor",
  );
  await expect(list).not.toContainText(/funding|tokens|AI helper/i);
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

test("someone who is not signed in is told what the product is for: projects they can talk about and help build", async ({
  page,
}) => {
  const relay = createMockRelay();
  await relay.install(page);
  await page.goto("/");
  const welcome = page.getByTestId("home-welcome");
  await expect(welcome).toBeVisible({ timeout: 15_000 });
  // The first release is the conversation and contributor work (D108): no sale, no tokens unlocking, no AI helpers.
  await expect(welcome.getByRole("heading")).toContainText("Find projects.");
  await expect(welcome).toContainText("pick up a piece of work");
  await expect(welcome).toContainText("Do useful work");
  await expect(welcome).not.toContainText("tokens");
  await expect(welcome).not.toContainText("AI helpers");
  // The welcome is the one offer of an account on Home: no second one in the composer's place right under it.
  await expect(
    page.getByRole("button", { name: "Create your account" }),
  ).toHaveCount(1);
});

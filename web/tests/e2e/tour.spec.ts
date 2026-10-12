import { expect, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { createMockRelay } from "./mock-relay";

/**
 * A guided look at every top-level page and every way of starting something, as a new person would meet them.
 *
 * Not a regression test: it asserts almost nothing and exists so a person (or an agent) can read the product off real
 * screenshots instead of off the code. Opt-in: `E2E_TOUR=<dir>` saves one PNG per stop into that directory.
 *
 *   E2E_TOUR=/tmp/tour pnpm exec playwright test --project=smoke tour.spec.ts
 */

const DIR = process.env.E2E_TOUR ?? "";
const NSEC = "22".repeat(32);
const ME = getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);

test.skip(!DIR, "set E2E_TOUR=<dir> to save the screenshots there");

const PAGES: [string, string][] = [
  ["home", "/"],
  ["start", "/start"],
  ["social", "/social"],
  ["communities", "/c"],
  ["discover", "/discover"],
  ["launches", "/launchpad"],
  ["projects", "/projects"],
  ["portfolio", "/portfolio"],
];

async function shot(
  page: import("@playwright/test").Page,
  name: string,
  full = false,
) {
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${DIR}/${name}.png`, fullPage: full });
}

test("the top-level pages, as a newcomer meets them", async ({ page }) => {
  test.setTimeout(180_000);
  const relay = createMockRelay();
  await relay.install(page);
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
  }, NSEC);
  await page.setViewportSize({ width: 1280, height: 800 });
  for (const [name, path] of PAGES) {
    await page.goto(path);
    await expect(page.getByTestId("app-nav")).toBeVisible({ timeout: 20_000 });
    await shot(page, `page-${name}`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [name, path] of PAGES) {
    await page.goto(path);
    await expect(page.getByTestId("app-nav")).toBeVisible({ timeout: 20_000 });
    await shot(page, `phone-${name}`);
  }
  expect(ME).toHaveLength(64);
});

test("every way of starting something", async ({ page }) => {
  test.setTimeout(180_000);
  const relay = createMockRelay();
  await relay.install(page);
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
  }, NSEC);
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.goto("/launchpad");
  await page.getByTestId("start-idea").click();
  await shot(page, "start-idea");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Set up a sale" }).click();
  const token = page.getByTestId("wizard-step-token");
  await token
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Nebula");
  await shot(page, "sale-wizard-1");
  const quick = page.getByRole("button", { name: "Quick start defaults" });
  if (await quick.isVisible().catch(() => false)) await quick.click();
  for (let step = 2; step <= 8; step++) {
    if (
      await page
        .getByRole("button", { name: /Publish launch/ })
        .isVisible()
        .catch(() => false)
    )
      break;
    const next = page.getByTestId("wizard-continue");
    if (await next.isDisabled().catch(() => true)) {
      const preset = page.getByRole("button", { name: "Product project" });
      if (await preset.isVisible().catch(() => false)) {
        await preset.click();
        continue;
      }
      break;
    }
    await next.click();
    await shot(page, `sale-wizard-${step}`, true);
  }
});

test("an idea, from the first click to the page it becomes", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const relay = createMockRelay();
  await relay.install(page);
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
  }, NSEC);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/launchpad");
  await page.getByTestId("start-idea").click();
  await page.getByLabel("What is it called?").fill("Nebula");
  await page
    .getByLabel("Say it in one sentence")
    .fill("An open-source tool that maps the night sky for everyone.");
  await page.getByRole("button", { name: "Put it out there" }).click();
  await page.waitForURL(/\/launchpad\/.+/, { timeout: 20_000 });
  await page.waitForTimeout(1_500);
  await shot(page, "idea-page", true);
  const tabs = await page.getByRole("tab").allTextContents();
  console.log(`idea tabs: ${tabs.join(" | ")}`);
  for (const name of tabs) {
    await page.getByRole("tab", { name }).first().click();
    await shot(
      page,
      `idea-tab-${name.toLowerCase().replace(/[^a-z]+/g, "-")}`,
      true,
    );
  }
});

test("starting an organization, step by step", async ({ page }) => {
  test.setTimeout(120_000);
  const relay = createMockRelay();
  relay.seed({
    id: "chan-1",
    pubkey: "b".repeat(64),
    created_at: 100,
    kind: 39000,
    tags: [
      ["d", "0f0f0f0f-1111-2222-3333-444444444444"],
      ["name", "general"],
    ],
    content: "",
    sig: "sig",
  });
  relay.seed({
    id: "agent-1",
    pubkey: "d".repeat(64),
    created_at: Math.floor(Date.now() / 1000),
    kind: 44010,
    tags: [["d", "scout"]],
    content: JSON.stringify({
      name: "Scout",
      runtype: "sandbox",
      status: "available",
      tools: [],
      heartbeat: Math.floor(Date.now() / 1000),
    }),
    sig: "sig",
  });
  await relay.install(page);
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
  }, NSEC);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/c/alpha.example.com");
  await page.getByTestId("content-pane").waitFor();
  await page.getByTestId("org-toggle").click();
  await expect(page.getByTestId("org-setup")).toBeVisible({ timeout: 20_000 });
  await shot(page, "org-1-name");
  await page.getByTestId("org-setup-name").fill("Nebula Labs");
  await page.getByTestId("org-setup-purpose").fill("Maps the night sky");
  await page.getByTestId("org-setup-next").click();
  await page.getByTestId("org-setup-helper-scout").check();
  await page.getByTestId("org-setup-role").fill("Researcher");
  await shot(page, "org-2-helper");
  await page.getByTestId("org-setup-next").click();
  await shot(page, "org-3-limits");
  await page.getByTestId("org-setup-next").click();
  await shot(page, "org-4-review");
  await page.getByTestId("org-setup-create").click();
  await expect(page.getByTestId("org-setup")).toHaveCount(0, {
    timeout: 20_000,
  });
  await shot(page, "org-5-chart");
});

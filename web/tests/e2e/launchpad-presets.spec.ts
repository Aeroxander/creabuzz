import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { createMockRelay } from "./mock-relay";

/**
 * Three starting sizes for a raise (Small, Standard, Large), on the quick setup an idea's sale starts on and on the full
 * wizard's Raise step. A preset fills in the target and the sale length; changing either afterwards makes the numbers
 * the founder's own, and the highlight lets go.
 */

const NSEC = "22".repeat(32);
getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);

async function open(page: Page) {
  const relay = createMockRelay();
  await relay.install(page);
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
  }, NSEC);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/launchpad");
}

test("an idea's sale starts from a size, and the highlight lets go once the numbers are the founder's own", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await open(page);
  await page.getByTestId("start-idea").click();
  await page.getByLabel("What is it called?").fill("Nebula");
  await page
    .getByLabel("Say it in one sentence")
    .fill("An open-source tool that maps the night sky for everyone.");
  await page.getByRole("button", { name: "Put it out there" }).click();
  await page.waitForURL(/\/launchpad\/.+/, { timeout: 20_000 });
  await page
    .getByRole("button", { name: /I already have backers elsewhere/ })
    .click();

  await expect(page.getByTestId("quick-sale")).toBeVisible();
  const presets = page.getByTestId("raise-presets");
  await expect(presets).toBeVisible();
  // The middle size is the app's own starting point, so it is what a new quick sale shows.
  await expect(page.getByTestId("quick-raise")).toHaveValue("300000");
  await expect(page.getByTestId("raise-preset-standard")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.getByTestId("raise-preset-large").click();
  if (process.env.E2E_SHOTS) {
    await page.screenshot({
      path: `${process.env.E2E_SHOTS}/presets-quick.png`,
    });
  }
  await expect(page.getByTestId("quick-raise")).toHaveValue("1000000");
  await expect(page.getByTestId("quick-duration-14d")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByTestId("raise-preset-large")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByTestId("raise-preset-standard")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  // Nothing about the sale is hidden: the terms it implies are listed and the sale can still be published.
  await expect(page.getByTestId("quick-issues")).toHaveCount(0);

  // The founder's own target: no size is highlighted any more.
  await page.getByTestId("quick-raise").fill("123456");
  for (const key of ["small", "standard", "large"]) {
    await expect(page.getByTestId(`raise-preset-${key}`)).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  }

  await page.getByTestId("raise-preset-small").click();
  await expect(page.getByTestId("quick-raise")).toHaveValue("50000");
  await expect(page.getByTestId("quick-duration-3d")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("the full wizard's Raise step offers the same sizes, in the sale's own currency", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await open(page);
  await page.getByRole("button", { name: "Set up a sale" }).first().click();
  const token = page.getByTestId("wizard-step-token");
  await token
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Presets Test");
  await token.getByLabel("Symbol").fill("PRE");
  await token.getByLabel(/supply/i).fill("1000000");
  await page.getByTestId("wizard-continue").click();
  const step = page.locator('div[data-testid="wizard-step-sale"]');
  await expect(step).toBeVisible();

  // It starts on "price per token"; a size switches to stating the raise target and fills it in.
  await page.getByTestId("raise-preset-small").click();
  await expect(page.getByLabel("Raise target (USDC)")).toHaveValue("50000");
  await expect(page.locator("#sale-duration")).toHaveValue("3d");
  await expect(step).toContainText("50,000 USDC");
  await expect(page.getByTestId("raise-preset-small")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.getByTestId("raise-preset-large").click();
  await expect(page.getByLabel("Raise target (USDC)")).toHaveValue("1000000");
  await expect(page.locator("#sale-duration")).toHaveValue("14d");
  await expect(step).toContainText("1,000,000 USDC");

  // Changing the length makes it the founder's own mix.
  await page.locator("#sale-duration").selectOption("7d");
  await expect(page.getByTestId("raise-preset-large")).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  // ETH has its own scale: the sizes are shown in ETH, never as dollar-sized numbers of ETH.
  await page.getByTestId("sale-currency-eth").click();
  await expect(page.getByTestId("raise-preset-small")).toContainText("20 ETH");
  await expect(page.getByTestId("raise-preset-large")).toContainText("400 ETH");
  await page.getByTestId("raise-preset-standard").click();
  await expect(page.getByLabel("Raise target (ETH)")).toHaveValue("120");
});

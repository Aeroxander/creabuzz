import { expect, test } from "@playwright/test";
import { installMockBridge } from "../helpers/bridge";

test.beforeEach(async ({ page }) => {
  await installMockBridge(page);
  await page.goto("/");
  // SPA server has no fallback: enter at root, navigate client-side.
  await page.getByTestId("open-launchpad-view").click();
  await expect(page).toHaveURL(/\/launchpad$/);
});

test("launchpad directory renders with empty state", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Launchpad" })).toBeVisible();
  await expect(page.getByTestId("launchpad-curate")).toBeVisible();
  await expect(page.getByText("No launches yet.")).toBeVisible();
});

test("new launch dialog validates before publishing", async ({ page }) => {
  await page.getByTestId("launchpad-curate").click();
  const dialog = page.getByRole("dialog", { name: "New launch" });
  await expect(dialog).toBeVisible();
  const publish = dialog.getByRole("button", { name: "Publish launch" });
  await expect(publish).toBeDisabled();

  await dialog.getByLabel("Launch id").fill("Bad Slug!");
  await dialog.getByLabel("Name", { exact: true }).fill("Nebula DAO");
  await expect(publish).toBeDisabled();

  await dialog.getByLabel("Launch id").fill("nebula");
  await expect(publish).toBeDisabled();
  await dialog.getByLabel("Token name", { exact: true }).fill("Nebula Token");
  await dialog.getByLabel("Symbol").fill("NEB");
  await expect(publish).toBeEnabled();
});

import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { expectAccessible } from "../helpers/a11y";
import { expectNoSidewaysScroll } from "../helpers/layout";
import { PressCounter } from "../helpers/press-counter";
import { createMockRelay } from "./mock-relay";
import { install, pubkeyOf } from "./helpers/world";

/** Saving the recovery key to a file from You, at phone width (360): behind a press, never drawn before it. */
test.use({ viewport: { width: 360, height: 740 } });

const KEY = "e1".repeat(32);
const ACCOUNT = pubkeyOf(KEY);

test("the recovery key is saved to a file from You, only on a press, and is never drawn or logged before it", async ({
  page,
}) => {
  const relay = createMockRelay();
  const logs: string[] = [];
  page.on("console", (message) => logs.push(message.text()));
  await install(page, relay, KEY);
  await page.goto("/you");
  const path = new PressCounter();
  await path.press(page.getByRole("tab", { name: "Account" }), "Account");
  await path.press(
    page.getByRole("button", { name: "Save your recovery key" }),
    "Save your recovery key",
  );
  const key = page.getByTestId("backup-key");
  await expect(key).toBeVisible();
  // Not on the screen, not even in part, until Reveal is pressed.
  await expect(page.locator("body")).not.toContainText(KEY.slice(0, 8));
  await expect(page.locator("body")).not.toContainText(KEY.slice(-8));
  await expectAccessible(page, "recovery key, hidden");
  const download = page.waitForEvent("download");
  await path.press(page.getByTestId("backup-download"), "Download");
  const file = await download;
  expect(file.suggestedFilename()).toBe(
    `creaton-recovery-key-${ACCOUNT.slice(0, 8)}.key`,
  );
  expect(readFileSync(await file.path(), "utf8")).toBe(KEY);
  // Saving it did not draw it.
  await expect(page.locator("body")).not.toContainText(KEY.slice(0, 8));
  await page.getByTestId("backup-reveal").click();
  await expect(key).toHaveText(KEY);
  await expectNoSidewaysScroll(page, "recovery key, shown");
  expect(logs.join("\n")).not.toContain(KEY);
});

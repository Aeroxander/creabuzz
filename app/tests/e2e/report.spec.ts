import { expect, test } from "@playwright/test";
import { expectAccessible } from "../helpers/a11y";
import { expectNoSidewaysScroll } from "../helpers/layout";
import { PressCounter } from "../helpers/press-counter";
import { createMockRelay } from "./mock-relay";
import { install } from "./helpers/world";
import { FAY, READER_KEY, seedSocial } from "./helpers/social-world";

/**
 * Reporting any post at phone width (360): More, Report, a reason and Send, the report goes to the server in the shape it takes,
 * the post is hidden for the reporter once the thanks is closed (and stays hidden after a reload), a report the server refuses
 * hides nothing and says so, and the person can be hidden from the same sheet.
 */
test.use({ viewport: { width: 360, height: 740 } });

test("a report is sent as the server takes it, and the post is hidden for the reporter after the thanks", async ({
  page,
}) => {
  const relay = createMockRelay();
  const { fay } = seedSocial(relay);
  await install(page, relay, READER_KEY);
  await page.goto("/");
  const card = page
    .getByTestId("post-card")
    .filter({ hasText: "First solar lamp is lit" });
  const path = new PressCounter();
  await path.press(
    card.getByRole("button", { name: "More actions for Fay Founder's post" }),
    "More",
  );
  await path.press(page.getByRole("button", { name: "Report" }), "Report");
  const sheet = page.getByTestId("report-sheet");
  await expect(sheet).toContainText(
    "The people who run this server will see it.",
  );
  await expect(sheet.getByTestId("report-send")).toBeDisabled();
  await path.press(sheet.getByLabel("Spam"), "A reason");
  await path.press(sheet.getByTestId("report-send"), "Send report");
  expect(path.counts().presses).toBe(4);
  await expect(sheet.getByTestId("report-done")).toBeVisible();
  await expect(sheet).toContainText("hidden for you on this phone");
  await expectAccessible(page, "report sent");

  const report = relay.events.find((e) => e.kind === 1984);
  expect(report?.tags).toEqual([
    ["e", fay.id, "spam"],
    ["p", FAY],
  ]);
  // Still there while the thanks is open; gone when it is closed.
  await expect(card).toHaveCount(1);
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId("home-posts")).toContainText(
    "Seeds are sprouting",
  );

  // Hidden after a reload, in a topic and in a search, but the person's other posts are not.
  await page.reload();
  await expect(page.getByTestId("home-posts")).not.toContainText(
    "First solar lamp",
  );
  await page.goto("/search?q=solar");
  await expect(page.getByTestId("search-posts-none")).toBeVisible();
  await expect(page.getByTestId("search-posts-hidden")).toContainText(
    "1 post is not shown",
  );
  await expectNoSidewaysScroll(page, "search with a reported post");
});

test("a report the server refuses hides nothing and says so, with the reason kept for another try", async ({
  page,
}) => {
  const relay = createMockRelay({
    refuse: (event) => (event.kind === 1984 ? "restricted: not now" : null),
  });
  seedSocial(relay);
  await install(page, relay, READER_KEY);
  await page.goto("/");
  const card = page
    .getByTestId("post-card")
    .filter({ hasText: "First solar lamp is lit" });
  await card
    .getByRole("button", { name: "More actions for Fay Founder's post" })
    .click();
  await page.getByRole("button", { name: "Report" }).click();
  const sheet = page.getByTestId("report-sheet");
  await sheet.getByLabel("Rude or harmful").check();
  await sheet.getByTestId("report-send").click();
  await expect(sheet.getByRole("alert")).toContainText(
    "The report was not sent. Try again.",
  );
  await sheet.getByRole("button", { name: "Not now" }).click();
  await expect(card).toHaveCount(1);
});

test("the person can be hidden from the same sheet, and all their posts go", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedSocial(relay);
  await install(page, relay, READER_KEY);
  await page.goto("/");
  const card = page
    .getByTestId("post-card")
    .filter({ hasText: "First solar lamp is lit" });
  await card
    .getByRole("button", { name: "More actions for Fay Founder's post" })
    .click();
  await page.getByRole("button", { name: "Report" }).click();
  const sheet = page.getByTestId("report-sheet");
  await sheet.getByLabel("Spam").check();
  await sheet.getByTestId("report-send").click();
  await sheet.getByTestId("report-hide-person").click();
  await expect(card).toHaveCount(0);
  await expect
    .poll(() => relay.events.filter((e) => e.kind === 10000).length)
    .toBe(1);
});

test("a signed-out person who presses Report is taken to make an account", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedSocial(relay);
  await install(page, relay, null);
  await page.goto("/");
  await page
    .getByTestId("post-card")
    .filter({ hasText: "First solar lamp is lit" })
    .getByRole("button", { name: "More actions for Fay Founder's post" })
    .click();
  await page.getByRole("button", { name: "Report" }).click();
  await expect(page).toHaveURL(/\/welcome/);
  expect(relay.events.some((e) => e.kind === 1984)).toBe(false);
});

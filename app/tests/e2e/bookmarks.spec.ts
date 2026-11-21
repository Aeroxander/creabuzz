import { expect, test } from "@playwright/test";
import { expectAccessible } from "../helpers/a11y";
import { expectNoSidewaysScroll } from "../helpers/layout";
import { PressCounter } from "../helpers/press-counter";
import { createMockRelay } from "./mock-relay";
import { install } from "./helpers/world";
import { READER, READER_KEY, seedSocial } from "./helpers/social-world";

/**
 * Saved posts at phone width (360): two presses save a post, two presses from You open the list, what is saved is kept in the
 * private part of the person's list (the server never holds it in plain text), it is there after a reload, and one press takes
 * a post out again.
 */
test.use({ viewport: { width: 360, height: 740 } });

test("two presses save a post, the saved list is two presses from You, and it is private", async ({
  page,
}) => {
  const relay = createMockRelay();
  const { fay } = seedSocial(relay);
  await install(page, relay, READER_KEY);
  await page.goto("/");
  const card = page
    .getByTestId("post-card")
    .filter({ hasText: "First solar lamp is lit" });
  // Two presses: More on the post, then Save this post.
  const save1 = new PressCounter();
  await save1.press(
    card.getByRole("button", { name: "More actions for Fay Founder's post" }),
    "More",
  );
  await save1.press(
    page.getByRole("button", { name: "Save this post" }),
    "Save this post",
  );
  expect(save1.counts().presses).toBe(2);
  await expect(page.getByTestId("toast")).toContainText(
    "Saved. Only you can see your saved posts.",
  );

  // The server holds the list, with the post nowhere in plain sight.
  await expect
    .poll(() => relay.events.filter((e) => e.kind === 10003).length)
    .toBe(1);
  const list = relay.events.find((e) => e.kind === 10003);
  expect(list?.pubkey).toBe(READER);
  expect(JSON.stringify(list)).not.toContain(fay.id);
  expect(list?.tags.some((t) => t[0] === "e")).toBe(false);

  // You, then Saved posts: two presses.
  const open = new PressCounter();
  await open.press(page.getByTestId("tab-link-you"), "You");
  await open.press(page.getByTestId("you-saved"), "Saved posts");
  expect(open.counts().presses).toBe(2);
  await expect(page).toHaveURL(/\/you\/saved$/);
  const saved = page.getByTestId("saved-list");
  await expect(saved.getByTestId("post-card")).toHaveCount(1);
  await expect(saved).toContainText("First solar lamp is lit");
  await expect(page.getByText("Only you can see this list.")).toBeVisible();
  await expectNoSidewaysScroll(page, "saved posts");
  await expectAccessible(page, "saved posts");

  // After a reload it is still there.
  await page.reload();
  await expect(page.getByTestId("saved-list")).toContainText(
    "First solar lamp is lit",
  );

  // One press takes it out.
  await page
    .getByRole("button", { name: "More actions for Fay Founder's post" })
    .click();
  await page.getByRole("button", { name: "Remove from saved" }).click();
  await expect(page.getByTestId("saved-empty")).toBeVisible();
  await expect(page.getByText("Nothing saved yet")).toBeVisible();
});

test("a signed-out person who presses Save is taken to make an account", async ({
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
  await page.getByRole("button", { name: "Save this post" }).click();
  await expect(page).toHaveURL(/\/welcome/);
  expect(relay.events.some((e) => e.kind === 10003)).toBe(false);
});

test("a save the server refuses says so and the post is not shown as saved", async ({
  page,
}) => {
  const relay = createMockRelay({
    refuse: (event) => (event.kind === 10003 ? "restricted: slow down" : null),
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
  await page.getByRole("button", { name: "Save this post" }).click();
  // The server's own reason is said, never "Saved".
  await expect(page.getByTestId("toast")).toBeVisible();
  await expect(page.getByTestId("toast")).not.toContainText("Saved.");
  // The menu still offers Save: nothing is shown as saved.
  await card
    .getByRole("button", { name: "More actions for Fay Founder's post" })
    .click();
  await expect(
    page.getByRole("button", { name: "Save this post" }),
  ).toBeVisible();
});

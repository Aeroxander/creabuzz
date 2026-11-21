import { expect, test } from "@playwright/test";
import { expectAccessible } from "../helpers/a11y";
import { expectNoSidewaysScroll } from "../helpers/layout";
import { PressCounter } from "../helpers/press-counter";
import { createMockRelay } from "./mock-relay";
import { event, install } from "./helpers/world";
import { FAY, READER, READER_KEY, seedSocial } from "./helpers/social-world";

/**
 * Hiding people at phone width (360): two presses from a post, the person's posts are gone from Home, a profile, a topic and
 * search, the list is private (sealed to the reader, nothing public names the person), it survives a reload, and the way back
 * is two presses from You.
 */
test.use({ viewport: { width: 360, height: 740 } });

test("two presses hide a person everywhere, privately, and two presses from You bring them back", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedSocial(relay);
  await install(page, relay, READER_KEY);
  await page.goto("/");
  const fays = page
    .getByTestId("post-card")
    .filter({ hasText: "First solar lamp is lit" });
  await expect(fays).toHaveCount(1);

  const hide = new PressCounter();
  await hide.press(
    fays.getByRole("button", { name: "More actions for Fay Founder's post" }),
    "More",
  );
  await hide.press(
    page.getByRole("button", { name: "Hide Fay Founder's posts" }),
    "Hide",
  );
  expect(hide.counts().presses).toBe(2);
  await expect(fays).toHaveCount(0);
  await expect(page.getByTestId("toast")).toContainText(
    "Only you stop seeing them",
  );
  await expect(page.getByTestId("toast")).toContainText("Hidden people");

  // The list is the reader's own: sealed, and nothing public names Fay.
  await expect
    .poll(() => relay.events.filter((e) => e.kind === 10000).length)
    .toBe(1);
  const list = relay.events.find((e) => e.kind === 10000);
  expect(list?.pubkey).toBe(READER);
  expect(list?.tags.some((t) => t[0] === "p")).toBe(false);
  expect(JSON.stringify(list)).not.toContain(FAY);

  // Gone from a topic and from a search, and shown as hidden on their profile.
  await page.goto("/tag/lamps");
  await expect(page.getByTestId("topic-list")).not.toContainText(
    "First solar lamp",
  );
  await page.goto("/search?q=solar");
  await expect(page.getByTestId("search-people-none")).toBeVisible();
  await expect(page.getByTestId("search-posts-none")).toBeVisible();
  await page.goto(`/u/${FAY}`);
  await expect(page.getByTestId("profile-hidden-note")).toBeVisible();
  await expect(page.getByTestId("profile-hide")).toHaveText(
    "Show Fay Founder's posts again",
  );
  await expectNoSidewaysScroll(page, "a hidden person's profile");
  await expectAccessible(page, "a hidden person's profile");

  // After a reload they are still hidden on Home.
  await page.goto("/");
  await expect(page.getByTestId("home-posts")).toContainText(
    "Seeds are sprouting",
  );
  await expect(page.getByTestId("home-posts")).not.toContainText(
    "First solar lamp",
  );

  // Back: You, Account, Hidden people, Show again (the tab is a press; the list opens in a sheet).
  await page.getByTestId("tab-link-you").click();
  await page.getByRole("tab", { name: "Account" }).click();
  await page.getByTestId("you-hidden").click();
  const sheet = page.getByTestId("hidden-sheet");
  await expect(sheet).toContainText("Fay Founder");
  await expectAccessible(page, "hidden people");
  await sheet.getByRole("button", { name: /Show again/ }).click();
  await expect(sheet).toContainText("You have not hidden anyone.");
  await page.keyboard.press("Escape");
  await page.goto("/");
  await expect(page.getByTestId("home-posts")).toContainText(
    "First solar lamp is lit",
  );
});

test("a hidden person's comment in a conversation is one quiet line with a Show press", async ({
  page,
}) => {
  const relay = createMockRelay();
  const { fay, max } = seedSocial(relay);
  await install(page, relay, READER_KEY);
  // Max answers Fay's post.
  const reply = event(
    1,
    max.pubkey,
    "A comment from Max",
    [
      ["e", fay.id, "", "root"],
      ["p", fay.pubkey],
    ],
    Math.floor(Date.now() / 1000) - 600,
  );
  relay.seed(reply);
  await page.goto("/");
  await page
    .getByTestId("post-card")
    .filter({ hasText: "Seeds are sprouting" })
    .getByRole("button", { name: "More actions for Max Mate's post" })
    .click();
  await page.getByRole("button", { name: "Hide Max Mate's posts" }).click();
  // The list is on the server before the page is loaded again.
  await expect
    .poll(() => relay.events.filter((e) => e.kind === 10000).length)
    .toBe(1);
  await page.goto(`/post/${fay.id}`);
  const folded = page.getByTestId("folded-post");
  await expect(folded).toContainText("This is a post by someone you hid.");
  await expect(page.getByText("A comment from Max")).toHaveCount(0);
  await folded.getByRole("button", { name: "Show this post" }).click();
  await expect(page.getByText("A comment from Max")).toBeVisible();
});

test("a signed-out person is sent to make an account before hiding anyone", async ({
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
  await page.getByRole("button", { name: "Hide Fay Founder's posts" }).click();
  await expect(page).toHaveURL(/\/welcome/);
  expect(relay.events.some((e) => e.kind === 10000)).toBe(false);
});

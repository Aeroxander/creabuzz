import { expect, test } from "@playwright/test";
import { expectAccessible } from "../helpers/a11y";
import { expectNoSidewaysScroll } from "../helpers/layout";
import { createMockRelay } from "./mock-relay";
import { event, install, now } from "./helpers/world";
import { FAY, MAX, READER_KEY, seedSocial } from "./helpers/social-world";

/**
 * Search and topics at phone width (360): one press from Home to Search; people and projects and posts by their words, though the
 * server's word index holds profiles only (the posts are found by looking through the newest); a #topic in a post opens the
 * posts under it; and none of it shows a holder room's post or a hidden person's.
 */
test.use({ viewport: { width: 360, height: 740 } });

test("Search is one press from Home and finds people, projects and posts by their words", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedSocial(relay);
  await install(page, relay, READER_KEY);
  await page.goto("/");
  await page.getByTestId("home-search").click();
  await expect(page).toHaveURL(/\/search$/);
  // Before anything is typed: what to type, and the topics people use.
  await expect(page.getByTestId("search-hint")).toBeVisible();
  await expect(page.getByTestId("search-topics")).toContainText("#lamps");
  await expectNoSidewaysScroll(page, "search, start");

  await page.getByTestId("search-input").fill("solar");
  await expect(page).toHaveURL(/q=solar/);
  const people = page.getByTestId("search-people");
  await expect(people).toContainText("Fay Founder");
  await expect(people).not.toContainText("Max Mate");
  await expect(page.getByTestId("search-projects")).toContainText("Lantern");
  // The post is found although the server's index does not hold posts, and the room's post is not among the results.
  const posts = page.getByTestId("search-posts");
  await expect(posts).toContainText("First solar lamp is lit");
  await expect(posts).not.toContainText("Backers only");
  await expectNoSidewaysScroll(page, "search, results");
  await expectAccessible(page, "search, results");

  // Back from a result returns to the same results.
  await page.getByTestId("search-person").first().click();
  await expect(page).toHaveURL(new RegExp(`/u/${FAY}`));
  await page.goBack();
  await expect(page).toHaveURL(/q=solar/);
  await expect(page.getByTestId("search-people")).toContainText("Fay Founder");
});

test("a search with nothing found says so in each part, and fewer than two letters asks nobody", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedSocial(relay);
  await install(page, relay, READER_KEY);
  await page.goto("/search");
  await page.getByTestId("search-input").fill("z");
  await expect(page.getByText("Type at least two letters.")).toBeVisible();
  await page.getByTestId("search-input").fill("zebra");
  await expect(page.getByTestId("search-people-none")).toBeVisible();
  await expect(page.getByTestId("search-projects-none")).toBeVisible();
  await expect(page.getByTestId("search-posts-none")).toBeVisible();
});

test("a search the server cannot answer says which part failed and keeps the rest", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedSocial(relay);
  await install(page, relay, READER_KEY);
  // The server hangs up on every word search; the plain reads still answer.
  relay.setClosingSockets((filter) => typeof filter?.search === "string");
  await page.goto("/search?q=solar");
  await expect(page.getByTestId("search-people-failed")).toContainText(
    "People could not be searched. Try again.",
  );
  await expect(page.getByTestId("search-posts-partly")).toBeVisible();
  await expect(page.getByTestId("search-posts")).toContainText(
    "First solar lamp is lit",
  );
  // Try again works once the server answers.
  relay.setClosingSockets(false);
  await page
    .getByTestId("search-people-failed")
    .getByRole("button", { name: "Try again" })
    .click();
  await expect(page.getByTestId("search-people")).toContainText("Fay Founder");
});

test("a #topic in a post opens the posts under it, without a holder room's post or a hidden person's", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedSocial(relay);
  await install(page, relay, READER_KEY);
  await page.goto("/");
  await page
    .getByTestId("post-card")
    .filter({ hasText: "First solar lamp is lit" })
    .getByRole("link", { name: "#lamps" })
    .click();
  await expect(page).toHaveURL(/\/tag\/lamps$/);
  const list = page.getByTestId("topic-list");
  await expect(list.getByTestId("post-card")).toHaveCount(2);
  await expect(list).toContainText("Seeds are sprouting");
  await expect(list).not.toContainText("Backers only");
  await expectNoSidewaysScroll(page, "topic page");
  await expectAccessible(page, "topic page");

  // A person hidden here is gone from the topic too.
  await list
    .getByTestId("post-card")
    .filter({ hasText: "Seeds are sprouting" })
    .getByRole("button", { name: "More actions for Max Mate's post" })
    .click();
  await page.getByRole("button", { name: "Hide Max Mate's posts" }).click();
  await expect(list.getByTestId("post-card")).toHaveCount(1);
  await page.reload();
  await expect(
    page.getByTestId("topic-list").getByTestId("post-card"),
  ).toHaveCount(1);
  await expect(page.getByTestId("topic-list")).not.toContainText(
    "Seeds are sprouting",
  );
  void MAX;
});

test("a topic nobody used says so, and a word that is not a topic says what a topic is", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedSocial(relay);
  await install(page, relay, READER_KEY);
  await page.goto("/tag/nothing");
  await expect(page.getByTestId("topic-empty")).toContainText(
    "No posts under #nothing yet",
  );
  await page.goto("/tag/a");
  await expect(page.getByTestId("topic-bad")).toBeVisible();
});

test("a post with the longest topic the page allows never makes the screen scroll sideways", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedSocial(relay);
  const wide = "w".repeat(32);
  const long = event(1, FAY, `Wide one #${wide}`, [["t", wide]], now() - 60);
  relay.seed(long);
  await install(page, relay, READER_KEY);
  await page.goto("/");
  await expect(page.getByRole("link", { name: `#${wide}` })).toBeVisible();
  await expectNoSidewaysScroll(page, "Home with a very wide topic");
  await page.goto(`/post/${long.id}`);
  await expect(page.getByRole("link", { name: `#${wide}` })).toBeVisible();
  await expectNoSidewaysScroll(page, "post page with a very wide topic");
  await page.goto(`/tag/${wide}`);
  await expect(page.getByTestId("topic-list")).toContainText("Wide one");
  await expectNoSidewaysScroll(page, "topic page with a very wide topic");
  await page.goto(`/search?q=%23${wide}`);
  await expect(page.getByTestId("search-topic-link")).toBeVisible();
  await expectNoSidewaysScroll(page, "search for a very wide topic");
});

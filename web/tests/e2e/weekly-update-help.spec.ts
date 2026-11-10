import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { expectAccessible } from "../helpers/a11y";
import { COMMUNITY_HOST, createMockRelay, matches } from "./mock-relay";

/**
 * The weekly update and the help it can ask for, as one loop on one server: the founder posts an update that asks for
 * help, a follower sees it in Home's Updates and on the project page and offers in one tap, the founder is told, replies
 * and marks the request "Help found". Around it: what a visitor without an account gets, a send the server refuses, the
 * founder's weekly prompt, and a phone-width screen.
 *
 * One mock server holds every record across the people in a test; a person is swapped by changing whose key the page
 * has and loading again, so what each sees is read back from the server, never from the other's page memory.
 */

const FOUNDER_KEY = "4".repeat(64);
const FOLLOWER_KEY = "5".repeat(64);
const pubkeyOf = (key: string) =>
  getPublicKey(Uint8Array.from(Buffer.from(key, "hex")));
const FOUNDER = pubkeyOf(FOUNDER_KEY);
const FOLLOWER = pubkeyOf(FOLLOWER_KEY);
const COORD = `37001:${FOUNDER}:nebula-os`;
const PROJECT = `/launchpad/nebula-os?author=${FOUNDER}`;
const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);

type Relay = ReturnType<typeof createMockRelay>;

let sequence = 0;
function event(
  kind: number,
  pubkey: string,
  content: unknown,
  tags: string[][],
  at: number,
) {
  sequence += 1;
  return {
    id: sequence.toString(16).padStart(64, "0"),
    kind,
    pubkey,
    content: typeof content === "string" ? content : JSON.stringify(content),
    tags,
    created_at: at,
    sig: "0".repeat(128),
  };
}

/** A project with its founder, and a follower who follows it. */
function seedProject(relay: Relay, stage: "draft" | "live" = "draft") {
  relay.seed(
    event(
      37001,
      FOUNDER,
      { pitch: "Build a useful app together.", stage },
      [
        ["d", "nebula-os"],
        ["name", "Nebula OS"],
        ["t", "dao-launchpad"],
        ["team", FOUNDER, "Founder"],
      ],
      now() - 60 * DAY,
    ),
  );
  relay.seed(
    event(0, FOLLOWER, { name: "Robin Helper" }, [], now() - 60 * DAY),
  );
  relay.seed(event(10003, FOLLOWER, "", [["a", COORD]], now() - 30 * DAY));
}

/** An update as the dialog publishes it, seeded straight into the server. */
function seedUpdate(
  relay: Relay,
  at: number,
  title: string,
  help: { text: string; size: string; time?: string } | null = null,
) {
  const update = event(
    47003,
    FOUNDER,
    {
      title,
      body: help ? `Help needed (${help.size})\n${help.text}` : "Steady week.",
    },
    [
      ["a", COORD],
      ...(help
        ? [
            ["help-needed", help.text],
            ["help-size", help.size],
            ...(help.time ? [["help-time", help.time]] : []),
          ]
        : []),
    ],
    at,
  );
  relay.seed(update);
  return update;
}

async function install(page: Page, relay: Relay, key: string | null) {
  await relay.install(page);
  // Whose page this is: the key under `e2e.key` wins, so a test can become someone else and load again.
  await page.addInitScript((first) => {
    const key = localStorage.getItem("e2e.key") ?? first;
    if (key === null || key === "none") {
      localStorage.removeItem("buzz.identity.nsec");
      return;
    }
    localStorage.setItem("buzz.identity.nsec", key);
    localStorage.setItem("buzz.identity.backedUp", "1");
  }, key);
  await page.route("**/communities", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        communities: [
          {
            host: COMMUNITY_HOST,
            name: "Alpha",
            description: "Build together",
            icon: null,
            member_count: 3,
            archived: false,
          },
        ],
      }),
    }),
  );
  await page.route("**/query", (route) => {
    const filters = JSON.parse(route.request().postData() ?? "[]");
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        relay.events.filter((e) =>
          filters.some((f: Parameters<typeof matches>[0]) => matches(f, e)),
        ),
      ),
    });
  });
}

/** Become another person (or nobody) and open `path` as them. */
async function openAs(page: Page, key: string | null, path: string) {
  await page.evaluate(
    (next) => localStorage.setItem("e2e.key", next ?? "none"),
    key,
  );
  await page.goto(path);
}

const updates = (relay: Relay) =>
  relay.events.filter((e) => e.kind === 47003 && e.pubkey === FOUNDER);
const tagged = (relay: Relay, name: string) =>
  relay.events.filter((e) => e.tags.some((t) => t[0] === name));
const noSidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test("founder posts a weekly update asking for help; a follower offers; the founder replies and marks Help found", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  seedProject(relay);
  seedUpdate(relay, now() - 9 * DAY, "Week one");
  await install(page, relay, FOUNDER_KEY);

  // The founder: one quiet prompt, nine days after the last update.
  await page.goto(PROJECT);
  const card = page.getByTestId("project-update-card");
  await expect(card.getByTestId("update-freshness")).toHaveText(
    "No update in 9 days",
  );
  await expect(card.getByTestId("update-nudge")).toContainText(
    "It's been 9 days since your last update.",
  );
  await card.getByRole("button", { name: "Post one" }).click();

  const dialog = page.getByRole("dialog", { name: "Post update" });
  await dialog.getByLabel("Title").fill("Week two: sign-up works");
  await dialog
    .getByLabel("What happened this week")
    .fill("Sign-up shipped on Tuesday.");
  await dialog.getByLabel("What's next").fill("Invite the first ten people.");
  await dialog
    .getByLabel("Help needed (optional)")
    .fill("Someone to test sign-up on an older phone.");
  // The size is picked from the keyboard: the radios are one group, moved through with the arrow keys.
  await dialog.getByRole("radio", { name: "Small" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(dialog.getByRole("radio", { name: "Medium" })).toBeChecked();
  await dialog.getByLabel("Rough time (optional)").fill("about 3 days");
  await dialog.getByRole("button", { name: "Publish update" }).click();
  await expect(dialog).toHaveCount(0);

  // One post: readable words in the body, and the parts as tags.
  await expect.poll(() => updates(relay).length).toBe(2);
  const posted = updates(relay).find((e) =>
    e.content.includes("Week two"),
  ) as (typeof relay.events)[number];
  expect(JSON.parse(posted.content).body).toBe(
    [
      "What happened this week\nSign-up shipped on Tuesday.",
      "What's next\nInvite the first ten people.",
      "Help needed (Medium, about 3 days)\nSomeone to test sign-up on an older phone.",
    ].join("\n\n"),
  );
  expect(posted.tags).toEqual(
    expect.arrayContaining([
      ["a", COORD],
      ["update-part", "done", "Sign-up shipped on Tuesday."],
      ["update-part", "next", "Invite the first ten people."],
      ["help-needed", "Someone to test sign-up on an older phone."],
      ["help-size", "medium"],
      ["help-time", "about 3 days"],
    ]),
  );

  // After posting: no prompt, when the next one is due, and the request as a card with nothing to offer on (they asked).
  await expect(card.getByTestId("update-freshness")).toHaveText(
    "Updated today",
  );
  await expect(card.getByTestId("update-nudge")).toHaveCount(0);
  await expect(card.getByTestId("update-next-due")).toHaveText(
    "Next update due in 7 days.",
  );
  const request = card.getByTestId("help-request");
  await expect(request.getByTestId("help-size")).toHaveText("Medium");
  await expect(request.getByTestId("help-time")).toHaveText("about 3 days");
  await expect(request.getByRole("button", { name: "I can help" })).toHaveCount(
    0,
  );
  await expect(request).toContainText("No offers yet");
  // Nothing on the card names an amount.
  await expect(request).not.toContainText(/Shares|\$|earn/i);

  // The follower: Home's Updates lists it for the project they follow, the request standing out as a card.
  await openAs(page, FOLLOWER_KEY, "/?tab=updates");
  const feed = page.getByTestId("project-progress");
  const item = feed
    .getByTestId("project-progress-item")
    .filter({ hasText: "Week two: sign-up works" });
  await expect(item).toContainText("Sign-up shipped on Tuesday.");
  // Newest first.
  await expect(feed.getByTestId("project-progress-item").first()).toContainText(
    "Week two",
  );
  const homeRequest = item.getByTestId("help-request");
  await expect(homeRequest).toContainText(
    "Someone to test sign-up on an older phone.",
  );
  // One tap, an optional note, sent from the keyboard.
  await homeRequest.getByRole("button", { name: "I can help" }).click();
  const box = homeRequest.getByTestId("help-offer-box");
  await expect(box.getByLabel("Add a short note (optional)")).toBeFocused();
  await page.keyboard.type("I have an old phone and an hour tonight.");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(homeRequest.getByTestId("help-my-offer")).toContainText(
    "You offered to help today.",
  );
  const offers = () => tagged(relay, "help-offer");
  await expect.poll(() => offers().length).toBe(1);
  expect(offers()[0].pubkey).toBe(FOLLOWER);
  expect(offers()[0].tags).toEqual(
    expect.arrayContaining([
      ["a", COORD],
      ["e", posted.id],
      ["p", FOUNDER],
    ]),
  );

  // On the project page the same update leads, with the follower's own offer on it.
  await page.goto(PROJECT);
  await expect(card.getByTestId("latest-update")).toContainText(
    "Week two: sign-up works",
  );
  await expect(card.getByTestId("help-my-offer")).toContainText(
    "I have an old phone and an hour tonight.",
  );
  // A visitor is not prompted to post, and is not told when the next one is due.
  await expect(card.getByTestId("update-next-due")).toHaveCount(0);

  // The founder is told, where notifications already are.
  await openAs(page, FOUNDER_KEY, "/social/notifications");
  const notice = page.getByTestId("social-help-notice");
  await expect(notice).toContainText(
    "Robin Helper offered to help with “Week two: sign-up works” in Nebula OS",
  );
  await notice.getByRole("link").click();
  // It opens the update; the founder sees who offered, their note and a link to them.
  const listed = page
    .getByTestId("project-progress-item")
    .filter({ hasText: "Week two" })
    .getByTestId("help-request");
  const offer = listed.getByTestId("help-offer");
  await expect(offer).toContainText("I have an old phone and an hour tonight.");
  await expect(
    offer.getByRole("link", { name: "Robin Helper" }),
  ).toHaveAttribute("href", new RegExp(`/u/${FOLLOWER}`));
  await offer.getByRole("button", { name: "Reply" }).click();
  await offer.getByLabel("Reply to Robin Helper").fill("Thank you! Tonight?");
  await offer.getByRole("button", { name: "Send reply" }).click();
  await expect(offer.getByTestId("help-reply")).toContainText(
    "Thank you! Tonight?",
  );

  await listed.getByRole("button", { name: "Mark as Help found" }).click();
  await expect(listed.getByTestId("help-found")).toHaveText("Help found");
  await expect(listed).toHaveAttribute("data-open", "false");
  await expect.poll(() => tagged(relay, "help-found").length).toBe(1);
  // None of the answers is counted as an update of the project.
  await expect(page.getByRole("tab", { name: "Updates (2)" })).toBeVisible();

  // The follower reads the reply, is told about it, and can take the offer back.
  await openAs(page, FOLLOWER_KEY, "/social/notifications");
  await expect(page.getByTestId("social-help-notice")).toContainText(
    "replied to your offer to help with “Week two: sign-up works”",
  );
  await page.goto(PROJECT);
  const mine = card.getByTestId("help-my-offer");
  await expect(mine.getByTestId("help-reply")).toContainText(
    "Thank you! Tonight?",
  );
  await expect(card.getByTestId("help-found")).toBeVisible();
  await mine.getByRole("button", { name: "Withdraw offer" }).click();
  await expect(card.getByTestId("help-my-offer")).toHaveCount(0);
  // Closed: no new offers.
  await expect(card.getByRole("button", { name: "I can help" })).toHaveCount(0);
  await expect(card.getByTestId("help-request")).toContainText(
    "This request is closed.",
  );
  expect(offers()).toHaveLength(0);
});

test("Home's side panel lists open requests under Projects, and drops one once help is found", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedProject(relay, "live");
  const ask = seedUpdate(relay, now() - DAY, "Week one", {
    text: "A second pair of eyes on the pitch.",
    size: "small",
  });
  await install(page, relay, FOLLOWER_KEY);
  await page.goto("/");
  const rail = page.getByTestId("social-rail-help");
  await expect(rail).toContainText("Asking for help");
  const link = rail.getByRole("link", {
    name: /Nebula OS.*A second pair of eyes on the pitch\./,
  });
  // It opens the update that asks.
  await expect(link).toHaveAttribute(
    "href",
    new RegExp(`/launchpad/nebula-os\\?.*tab=updates.*#update-${ask.id}`),
  );

  relay.seed(
    event(
      47003,
      FOUNDER,
      { title: "Help found", body: "" },
      [
        ["a", COORD],
        ["e", ask.id],
        ["help-found", ask.id],
      ],
      now() - 60,
    ),
  );
  await page.reload();
  await expect(page.getByTestId("social-rail-projects")).toContainText(
    "Nebula OS",
  );
  await expect(page.getByTestId("social-rail-help")).toHaveCount(0);
});

test("signed out, I can help opens sign-up and sends nothing", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedProject(relay);
  seedUpdate(relay, now() - DAY, "Week one", {
    text: "A second pair of eyes on the pitch.",
    size: "small",
  });
  await install(page, relay, null);
  await page.goto(PROJECT);
  const request = page
    .getByTestId("project-update-card")
    .getByTestId("help-request");
  await expect(request).toContainText("A second pair of eyes on the pitch.");
  await request.getByRole("button", { name: "I can help" }).click();
  await expect(page.getByTestId("onboarding-dialog")).toBeVisible();
  await expect(request.getByTestId("help-offer-box")).toHaveCount(0);
  expect(tagged(relay, "help-offer")).toHaveLength(0);
});

test("an offer the server refuses says so, keeps the note, and Try again sends it", async ({
  page,
}) => {
  let refusing = true;
  const relay = createMockRelay({
    refuse: (e) =>
      refusing && e.tags.some((t) => t[0] === "help-offer")
        ? "blocked: try later"
        : null,
  });
  seedProject(relay);
  seedUpdate(relay, now() - DAY, "Week one", {
    text: "A second pair of eyes on the pitch.",
    size: "large",
    time: "a weekend",
  });
  await install(page, relay, FOLLOWER_KEY);
  await page.goto(PROJECT);
  const request = page
    .getByTestId("project-update-card")
    .getByTestId("help-request");
  await request.getByRole("button", { name: "I can help" }).click();
  const box = request.getByTestId("help-offer-box");
  await box.getByLabel("Add a short note (optional)").fill("Happy to read it.");
  await box.getByRole("button", { name: "Send offer" }).click();

  const failed = request.getByTestId("help-offer-box-failed");
  await expect(failed).toContainText("Your offer was not sent.");
  await expect(failed).toHaveAttribute("role", "alert");
  // Not shown as sent, and what was typed is still there.
  await expect(request.getByTestId("help-my-offer")).toHaveCount(0);
  await expect(box.getByLabel("Add a short note (optional)")).toHaveValue(
    "Happy to read it.",
  );
  expect(tagged(relay, "help-offer")).toHaveLength(0);

  refusing = false;
  await failed.getByRole("button", { name: "Try again" }).click();
  await expect(request.getByTestId("help-my-offer")).toContainText(
    "Happy to read it.",
  );
  expect(tagged(relay, "help-offer")).toHaveLength(1);
});

test("an update the server refuses stays in the dialog with what was written, and Try again publishes it", async ({
  page,
}) => {
  let refusing = true;
  const relay = createMockRelay({
    refuse: (e) => (refusing && e.kind === 47003 ? "blocked: try later" : null),
  });
  seedProject(relay);
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);
  // Never posted: the prompt says so instead of counting days.
  await expect(page.getByTestId("update-nudge")).toContainText(
    "You haven't posted an update yet.",
  );
  await page.getByRole("button", { name: "Post update" }).click();
  const dialog = page.getByRole("dialog", { name: "Post update" });
  // Free-form is still there: one open box instead of the two prompts.
  await dialog.getByRole("button", { name: "Write freely instead" }).click();
  await expect(dialog.getByLabel("What happened this week")).toHaveCount(0);
  await dialog.getByLabel("Title").fill("We moved studios");
  await dialog.getByLabel("Your update").fill("Boxes everywhere.");
  await dialog.getByRole("button", { name: "Publish update" }).click();
  await expect(dialog.getByTestId("update-publish-failed")).toContainText(
    "Your update was not published.",
  );
  await expect(dialog.getByLabel("Your update")).toHaveValue(
    "Boxes everywhere.",
  );
  expect(updates(relay)).toHaveLength(0);

  refusing = false;
  await dialog.getByRole("button", { name: "Try again" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => updates(relay).length).toBe(1);
  expect(JSON.parse(updates(relay)[0].content)).toEqual({
    title: "We moved studios",
    body: "Boxes everywhere.",
  });
  // A free-form update carries no part tags.
  expect(updates(relay)[0].tags).toEqual([["a", COORD]]);
  await expect(page.getByTestId("latest-update")).toContainText(
    "Boxes everywhere.",
  );
});

test("the weekly prompt can be put away for the week, and everyone sees weeks in a row from two", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedProject(relay);
  // Three weeks running, the newest a week ago to the minute: last week, so the run stands while this week is open.
  for (const days of [7, 14, 21])
    seedUpdate(relay, now() - days * DAY, `Week ${days}`);
  await install(page, relay, FOUNDER_KEY);
  await page.goto(PROJECT);
  const card = page.getByTestId("project-update-card");
  await expect(card.getByTestId("update-nudge")).toContainText(
    "It's been 7 days since your last update.",
  );
  await card
    .getByRole("button", { name: "Hide this reminder for a week" })
    .click();
  await expect(card.getByTestId("update-nudge")).toHaveCount(0);
  await page.reload();
  await expect(card.getByTestId("update-freshness")).toHaveText(
    "No update in 7 days",
  );
  await expect(card.getByTestId("update-nudge")).toHaveCount(0);

  // A visitor sees how fresh it is and the run, and no prompt.
  await openAs(page, FOLLOWER_KEY, PROJECT);
  await expect(card.getByTestId("update-freshness")).toHaveText(
    "No update in 7 days",
  );
  const inARow = card.getByTestId("updates-in-a-row");
  await expect(inARow).toHaveText("3 weekly updates in a row");
  await expect(card.getByTestId("update-nudge")).toHaveCount(0);
});

test("one update is not a run: no count is shown", async ({ page }) => {
  const relay = createMockRelay();
  seedProject(relay);
  seedUpdate(relay, now() - 2 * DAY, "Only one");
  await install(page, relay, FOLLOWER_KEY);
  await page.goto(PROJECT);
  const card = page.getByTestId("project-update-card");
  await expect(card.getByTestId("update-freshness")).toHaveText(
    "Updated 2 days ago",
  );
  await expect(card.getByTestId("updates-in-a-row")).toHaveCount(0);
});

test("at 390px the update card, the help card and the dialog fit with no sideways scroll", async ({
  page,
}) => {
  const relay = createMockRelay();
  seedProject(relay);
  seedUpdate(relay, now() - DAY, "A-long-title-without-any-spaces-".repeat(4), {
    text: `Someone-to-read-${"a-very-long-unbroken-word-".repeat(6)}`,
    size: "large",
    time: "about three or four evenings",
  });
  relay.seed(
    event(
      47003,
      FOLLOWER,
      { title: "Offer to help", body: "x".repeat(200) },
      [
        ["a", COORD],
        ["e", updates(relay)[0].id],
        ["p", FOUNDER],
        ["help-offer", updates(relay)[0].id],
      ],
      now() - 3600,
    ),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await install(page, relay, FOLLOWER_KEY);

  await page.goto(PROJECT);
  const card = page.getByTestId("project-update-card");
  await expect(card.getByTestId("help-my-offer")).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);
  await expectAccessible(page, "project page with a help request, phone");

  await page.goto("/?tab=updates");
  await expect(
    page.getByTestId("project-progress").getByTestId("help-request"),
  ).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);

  // The founder's side: the offers list, the reply box and the dialog with every field open.
  await openAs(page, FOUNDER_KEY, PROJECT);
  const offer = card.getByTestId("help-offer");
  await offer.getByRole("button", { name: "Reply" }).click();
  await expect(offer.getByTestId("help-reply-box")).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);
  await page.getByRole("button", { name: "Post update" }).click();
  const dialog = page.getByRole("dialog", { name: "Post update" });
  await dialog.getByLabel("Help needed (optional)").fill("A tester.");
  await expect(dialog.getByRole("radio", { name: "Large" })).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);
  const box = await dialog.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
  await expectAccessible(page, "post update dialog, phone");
});

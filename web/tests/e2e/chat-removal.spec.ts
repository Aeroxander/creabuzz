import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { expectAccessible } from "../helpers/a11y";
import { expectNoSidewaysScroll } from "../helpers/layout";
import { createMockRelay } from "./mock-relay";

/**
 * Removing someone else's chat message, as a room's moderators do it and as every other reader sees it. The server's own
 * check (only an owner or admin of the room or community may send a removal) is covered by its tests and by the real-server
 * journeys; here the spec checks who is offered Remove, what the app sends, and that an open room applies a removal from a
 * known moderator, ignores one from anyone else, and follows a roster that changes underneath it.
 */

const NSEC = "66".repeat(32);
const ME = getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);
const ALICE = "b".repeat(64);
const OWNER = "1".repeat(64);
const BOB = "2".repeat(64);
const CAROL = "3".repeat(64);
const CHANNEL_ID = "0f0f0f0f-1111-2222-3333-444444444444";
const THEIR_MESSAGE = "c".repeat(64);
const MY_MESSAGE = "d".repeat(64);
const now = () => Math.floor(Date.now() / 1000);

type Relay = ReturnType<typeof createMockRelay>;

const memberList = (people: [string, string][], created_at: number) => ({
  id: `member-list-${created_at}`,
  pubkey: "d".repeat(64),
  created_at,
  kind: 13534,
  tags: people.map(([key, role]) => ["member", key, role]),
  content: "",
  sig: "sig",
});

function room(people: [string, string][]) {
  const relay = createMockRelay({ applyDeletions: true });
  relay.seed(memberList(people, 200));
  relay.seed({
    id: "meta",
    pubkey: "9".repeat(64),
    kind: 39000,
    created_at: 100,
    tags: [
      ["d", CHANNEL_ID],
      ["name", "general"],
    ],
    content: "",
    sig: "sig",
  });
  for (const [id, pubkey, text] of [
    [THEIR_MESSAGE, ALICE, "Buy my coin at example dot com"],
    [MY_MESSAGE, ME, "A message of mine"],
  ] as const) {
    relay.seed({
      id,
      pubkey,
      kind: 9,
      created_at: now() - 60,
      tags: [["h", CHANNEL_ID]],
      content: text,
      sig: "sig",
    });
  }
  return relay;
}

async function openRoom(page: Page, relay: Relay) {
  await relay.install(page);
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
    window.localStorage.setItem("buzz.identity.backedUp", "1");
  }, NSEC);
  await page.goto("/c/alpha.example.com");
  await page.getByTestId("content-pane").waitFor();
  await page.getByTestId("channel-general").click();
  await expect(page.getByText("Buy my coin at example dot com")).toBeVisible({
    timeout: 20_000,
  });
}

const theirRow = (page: Page) =>
  page.getByTestId("message-row").filter({ hasText: "Buy my coin" });

/** The room's live subscription is open, so a removal delivered now will reach it. */
const roomWatched = (relay: Relay) =>
  expect
    .poll(() =>
      relay
        .subscriptionFilters()
        .some((f) => (f["#h"] as string[] | undefined)?.includes(CHANNEL_ID)),
    )
    .toBe(true);

/**
 * The room has asked to hear about roster changes, so one delivered now will reach it. By `#h`: the real server delivers
 * a room's records live only to subscriptions that name the room that way (D95).
 */
const rosterWatched = (relay: Relay) =>
  expect
    .poll(() =>
      relay
        .subscriptionFilters()
        .some(
          (f) =>
            f.kinds?.includes(39002) &&
            (f["#h"] as string[] | undefined)?.includes(CHANNEL_ID),
        ),
    )
    .toBe(true);

const removalFrom = (sender: string, target: string, at = now() + 1) => ({
  id: `removal-${sender.slice(0, 4)}-${at}`,
  pubkey: sender,
  kind: 9005,
  created_at: at,
  tags: [
    ["h", CHANNEL_ID],
    ["e", target],
  ],
  content: "",
  sig: "sig",
});

test("an owner is offered Remove on other people's messages and not on their own; a member is offered none", async ({
  page,
  browser,
}) => {
  const relay = room([[ME, "owner"]]);
  await openRoom(page, relay);
  // The roster has loaded once Ban appears for a message by someone who is not on the list.
  await expect(theirRow(page).getByTestId("ban-author-button")).toHaveCount(1);
  await expect(theirRow(page).getByTestId("remove-button")).toHaveCount(1);
  await expect(
    page
      .getByTestId("message-row")
      .filter({ hasText: "A message of mine" })
      .getByTestId("remove-button"),
  ).toHaveCount(0);

  const other = await browser.newPage();
  const asMember = room([
    [OWNER, "owner"],
    [ME, "member"],
  ]);
  await openRoom(other, asMember);
  await expect.poll(() => asMember.requestsFor(13534)).toBeGreaterThan(0);
  await other.waitForTimeout(500);
  await expect(theirRow(other).getByTestId("remove-button")).toHaveCount(0);
  await other.close();
});

test("removing asks first, sends one removal for that message, and the message reads as removed by a moderator", async ({
  page,
}) => {
  const relay = room([[ME, "owner"]]);
  await openRoom(page, relay);
  await theirRow(page).hover();
  await theirRow(page).getByTestId("remove-button").click();
  const ask = page.getByRole("alertdialog");
  await expect(ask).toContainText("Remove this message?");
  await expect(ask).toContainText("The person stays");
  await expectAccessible(page, "the remove-message confirmation");
  // Cancelling sends nothing.
  await ask.getByRole("button", { name: "Cancel" }).click();
  expect(relay.events.filter((e) => e.kind === 9005)).toHaveLength(0);

  await theirRow(page).hover();
  await theirRow(page).getByTestId("remove-button").click();
  await page.getByRole("button", { name: "Remove message" }).click();
  // The row stays with its marker, but the message's words are gone from it.
  await expect(theirRow(page)).toHaveCount(0, { timeout: 20_000 });
  const sent = relay.events.filter((e) => e.kind === 9005);
  // The mock took the message away as the real server does; the marker shows on the open page.
  await expect(page.getByText("message removed by a moderator")).toBeVisible();
  expect(sent).toHaveLength(1);
  expect(sent[0].tags).toContainEqual(["h", CHANNEL_ID]);
  expect(sent[0].tags).toContainEqual(["e", THEIR_MESSAGE]);
  expect(sent[0].pubkey).toBe(ME);
  // A reload no longer gets the message at all.
  await page.reload();
  await page.getByTestId("channel-general").click();
  await expect(page.getByText("A message of mine")).toBeVisible();
  await expect(page.getByText("Buy my coin at example dot com")).toHaveCount(0);
});

test("an open room applies a removal from a known owner and ignores one from anyone else", async ({
  page,
}) => {
  const relay = room([
    [OWNER, "owner"],
    [ME, "member"],
  ]);
  await openRoom(page, relay);
  await roomWatched(relay);
  await rosterWatched(relay);
  await expect.poll(() => relay.requestsFor(13534)).toBeGreaterThan(0);

  // Someone who is not an owner or admin: ignored.
  relay.deliver(removalFrom(BOB, THEIR_MESSAGE));
  await page.waitForTimeout(500);
  await expect(page.getByText("Buy my coin at example dot com")).toBeVisible();
  await expect(page.getByText("message removed by a moderator")).toHaveCount(0);

  // The owner's removal reaches the open room at once, with no reload.
  relay.deliver(removalFrom(OWNER, THEIR_MESSAGE, now() + 2));
  await expect(page.getByText("message removed by a moderator")).toBeVisible();
  await expect(page.getByText("Buy my coin at example dot com")).toHaveCount(0);
});

test("an open room follows a newly appointed admin's removal, and keeps it after that admin is demoted", async ({
  page,
}) => {
  const relay = room([
    [OWNER, "owner"],
    [ME, "member"],
  ]);
  await openRoom(page, relay);
  await roomWatched(relay);
  await rosterWatched(relay);

  // CAROL is made an admin in another session; the room's roster follows and her removal then counts.
  const promoted = memberList(
    [
      [OWNER, "owner"],
      [ME, "member"],
      [CAROL, "admin"],
    ],
    now() + 10,
  );
  relay.seed(promoted);
  relay.deliver(promoted);
  relay.deliver(removalFrom(CAROL, THEIR_MESSAGE, now() + 11));
  await expect(page.getByText("message removed by a moderator")).toBeVisible();

  // CAROL is demoted. What was removed stays removed for this reader.
  const demoted = memberList(
    [
      [OWNER, "owner"],
      [ME, "member"],
      [CAROL, "member"],
    ],
    now() + 20,
  );
  relay.seed(demoted);
  relay.deliver(demoted);
  await page.waitForTimeout(800);
  await expect(page.getByText("message removed by a moderator")).toBeVisible();
});

test("a removal from someone the room does not know makes it read the roster again, and counts once they are an admin", async ({
  page,
}) => {
  const relay = room([
    [OWNER, "owner"],
    [ME, "member"],
  ]);
  await openRoom(page, relay);
  await roomWatched(relay);
  await rosterWatched(relay);
  await expect.poll(() => relay.requestsFor(13534)).toBeGreaterThan(0);
  const readsBefore = relay.requestsFor(13534);

  // CAROL was made an admin and the room missed it (the change is on the server, and was not delivered live).
  relay.seed(
    memberList(
      [
        [OWNER, "owner"],
        [ME, "member"],
        [CAROL, "admin"],
      ],
      now() + 10,
    ),
  );
  relay.deliver(removalFrom(CAROL, THEIR_MESSAGE, now() + 11));
  // The first removal from someone not on the list makes the room look again; with the new list it counts.
  await expect(page.getByText("message removed by a moderator")).toBeVisible({
    timeout: 15_000,
  });
  expect(relay.requestsFor(13534)).toBeGreaterThan(readsBefore);
});

test("on a phone the message actions are there without hovering, and the page does not scroll sideways", async ({
  browser,
}) => {
  // A touch device has no hover, so an action that only appears on hover could never be reached.
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  const relay = room([[ME, "owner"]]);
  await relay.install(page);
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
    window.localStorage.setItem("buzz.identity.backedUp", "1");
  }, NSEC);
  await page.goto("/c/alpha.example.com");
  await page.getByTestId("content-pane").waitFor();
  await page.getByTestId("open-channel-list").click();
  await page.getByTestId("channel-general").click();
  await expect(page.getByText("Buy my coin at example dot com")).toBeVisible({
    timeout: 20_000,
  });
  // The owner has every action on someone else's message: Copy, Link, Reply, Report, Remove, Ban.
  await expect(theirRow(page).getByTestId("remove-button")).toHaveCount(1);
  const remove = theirRow(page).getByTestId("remove-button");
  await expect(remove.locator("..")).toHaveCSS("opacity", "1");
  await expect(remove).toBeInViewport();
  const viewport = page.viewportSize();
  const box = await remove.boundingBox();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
    viewport?.width ?? 0,
  );
  await expectNoSidewaysScroll(page, "a chat message with every action");
  await expectAccessible(page, "a chat room with every moderator action shown");
  await context.close();
});

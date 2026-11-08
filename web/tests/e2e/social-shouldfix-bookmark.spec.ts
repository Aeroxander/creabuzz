import { expect, type Page, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { createMockRelay } from "./mock-relay";

/**
 * The Bookmark button on a post. It used to do nothing a reader could see: signed out it was a dead, disabled button;
 * signed in it showed no change until the list had been read, written and read again, a failed save said so only in a
 * brief message with no way to retry, and two quick saves could write over each other. Now a click shows at once, a
 * save that did not go through says so with Try again, a saved post is on the Bookmarks page, and signed out a click
 * opens sign-up.
 */

const NSEC = "9a".repeat(32);
const ME = getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);
const ANN = "a1".repeat(32);
const now = () => Math.floor(Date.now() / 1000);

let counter = 0;
const note = (content: string) => ({
  id: `${(++counter).toString(16).padStart(8, "0")}`.padEnd(64, "c"),
  pubkey: ANN,
  created_at: now() - 300 - counter,
  kind: 1,
  tags: [] as string[][],
  content,
  sig: "sig",
});

async function open(
  page: Page,
  relay: ReturnType<typeof createMockRelay>,
  path: string,
  signedIn = true,
) {
  await page.route("http://127.0.0.1:8545/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x10" }),
    }),
  );
  await relay.install(page);
  if (signedIn)
    await page.addInitScript((nsec) => {
      window.localStorage.setItem("buzz.identity.nsec", nsec);
      window.localStorage.setItem("buzz.identity.backedUp", "1");
    }, NSEC);
  await page.goto(path);
}

const card = (page: Page, text: string) =>
  page.getByTestId("social-post").filter({ hasText: text });
const button = (page: Page, text: string) =>
  card(page, text).getByRole("button", { name: "Bookmark", exact: true });
const lists = (relay: ReturnType<typeof createMockRelay>) =>
  relay.events.filter((e) => e.kind === 10003 && e.pubkey === ME);

test("a click saves the post, shows it saved, and the Bookmarks page lists it", async ({
  page,
}) => {
  const relay = createMockRelay();
  const saved = note("Remember this one.");
  relay.seed(saved);
  await open(page, relay, "/");

  await expect(button(page, "Remember this one.")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await button(page, "Remember this one.").click();
  await expect(button(page, "Remember this one.")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect.poll(() => lists(relay).length).toBe(1);
  // Private: the list does not name the post in the open.
  expect(JSON.stringify(lists(relay)[0].tags)).not.toContain(saved.id);
  expect(lists(relay)[0].content).not.toBe("");

  // Read back from the server, not from this page's memory.
  await page.goto("/social/bookmarks");
  await expect(card(page, "Remember this one.")).toBeVisible();
  await expect(button(page, "Remember this one.")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // Pressing again removes it, and the page says it is empty.
  await button(page, "Remember this one.").click();
  await expect(page.getByTestId("social-bookmarks-empty")).toBeVisible();
});

test("the keyboard saves a post too, and two quick saves both stay", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(note("First post."));
  relay.seed(note("Second post."));
  await open(page, relay, "/");

  await button(page, "First post.").focus();
  await page.keyboard.press("Enter");
  await button(page, "Second post.").focus();
  await page.keyboard.press("Space");
  await expect(button(page, "First post.")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(button(page, "Second post.")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // Both saves reach the server before the page is left, one after the other.
  await expect.poll(() => lists(relay).length).toBe(2);

  await page.goto("/social/bookmarks");
  await expect(card(page, "First post.")).toBeVisible();
  await expect(card(page, "Second post.")).toBeVisible();
});

test("a save the server refuses says so in plain words, goes back to unsaved, and Try again saves it", async ({
  page,
}) => {
  let refuse = true;
  const relay = createMockRelay({
    refuse: (event) =>
      refuse && event.kind === 10003 ? "error: database error: down" : null,
  });
  relay.seed(note("Hold on to this."));
  await open(page, relay, "/");

  await button(page, "Hold on to this.").click();
  const toast = page.locator("[data-sonner-toast]").filter({
    hasText: "Your bookmark was not saved",
  });
  await expect(toast).toBeVisible();
  // Words for people, not the server's own.
  await expect(toast).not.toContainText("database");
  await expect(button(page, "Hold on to this.")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(lists(relay)).toHaveLength(0);

  refuse = false;
  await toast.getByRole("button", { name: "Try again" }).click();
  await expect(button(page, "Hold on to this.")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect.poll(() => lists(relay).length).toBe(1);
});

test("signed out, the button is live and a click opens sign-up", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(note("Look but do not touch."));
  await open(page, relay, "/", false);

  const bookmark = button(page, "Look but do not touch.");
  await expect(bookmark).toBeEnabled();
  await bookmark.click();
  await expect(page.getByTestId("onboarding-dialog")).toBeVisible();
  expect(lists(relay)).toHaveLength(0);
});

test("a save does not wipe a launch follow already in the list", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed({
    id: "f".repeat(64),
    pubkey: ME,
    created_at: now() - 100,
    kind: 10003,
    tags: [["a", `37001:${"d".repeat(64)}:film`]],
    content: "",
    sig: "sig",
  });
  relay.seed(note("Keep both."));
  await open(page, relay, "/");

  await button(page, "Keep both.").click();
  await expect(button(page, "Keep both.")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect.poll(() => lists(relay).length).toBe(2);
  const latest = lists(relay).at(-1);
  expect(latest?.tags).toEqual([["a", `37001:${"d".repeat(64)}:film`]]);
});

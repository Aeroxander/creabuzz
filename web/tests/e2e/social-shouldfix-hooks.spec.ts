import { expect, type Page, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { createMockRelay } from "./mock-relay";

/**
 * Reads behind social pages that failed quietly before (batch 3, social-hooks): a saved board post that could not be
 * read, an older page of board posts that failed, the main nav's notification count when its poll failed, and the
 * timeline tabs tied to the content they show.
 */

const NSEC = "78".repeat(32);
const ME = getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);
const ALICE = "e".repeat(64);
const BOARD = "0b0b0b0b-1111-2222-3333-444444444444";
const now = () => Math.floor(Date.now() / 1000);

type Filter = Record<string, unknown> | undefined;
const asks = (filter: Filter, kind: number) =>
  Array.isArray(filter?.kinds) && (filter.kinds as number[]).includes(kind);

function boardMeta() {
  return {
    id: "meta-board".padEnd(64, "0"),
    pubkey: "b".repeat(64),
    created_at: 100,
    kind: 39000,
    tags: [["d", BOARD], ["name", "ideas"], ["public"], ["t", "forum"]],
    content: "",
    sig: "sig",
  };
}

function boardPost(index: number, at: number) {
  return {
    id: `b0${index.toString(16).padStart(6, "0")}`.padEnd(64, "a"),
    pubkey: ALICE,
    created_at: at,
    kind: 45001,
    tags: [["h", BOARD]],
    content: `# board post ${index}`,
    sig: "sig",
  };
}

async function setUp(page: Page, relay: ReturnType<typeof createMockRelay>) {
  await page.route("http://127.0.0.1:8545/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x10" }),
    }),
  );
  await relay.install(page);
}

async function signIn(page: Page) {
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
    window.localStorage.setItem("buzz.identity.backedUp", "1");
  }, NSEC);
}

test("a saved board post that could not be read is a failure with a retry, not an empty list", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(boardMeta());
  const saved = boardPost(1, now() - 100);
  relay.seed(saved);
  relay.seed({
    id: "bookmarks".padEnd(64, "0"),
    pubkey: ME,
    created_at: now() - 50,
    kind: 10003,
    tags: [["e", saved.id]],
    content: "",
    sig: "sig",
  });
  // Only the read of saved board posts by id fails.
  relay.setClosingSockets(
    (filter) => asks(filter, 45001) && Array.isArray(filter?.ids),
  );
  await setUp(page, relay);
  await signIn(page);
  await page.goto("/social/bookmarks");
  await expect(page.getByTestId("social-bookmarks-error")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("social-bookmarks-empty")).toHaveCount(0);

  // The server is back: Try again reads the board post.
  relay.setClosingSockets(false);
  await page
    .getByTestId("social-bookmarks-error")
    .getByRole("button", { name: /try again/i })
    .click();
  await expect(page.getByText("board post 1")).toBeVisible({
    timeout: 20_000,
  });
});

test("an older page of board posts that fails is said at the bottom of Home, and what loaded stays", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const relay = createMockRelay();
  relay.seed(boardMeta());
  const start = now() - 10_000;
  // One more than a page, so there is an older page to read.
  for (let index = 1; index <= 101; index += 1)
    relay.seed(boardPost(index, start + index));
  relay.setClosingSockets(
    (filter) => asks(filter, 45001) && typeof filter?.until === "number",
  );
  await setUp(page, relay);
  // (A visitor's Home opens on the projects' live records: the timeline is its Everyone tab.)
  await page.goto("/?tab=everyone");
  await expect(page.getByText("board post 101")).toBeVisible({
    timeout: 20_000,
  });

  const list = page.getByTestId("social-post-list");
  for (let tries = 0; tries < 30; tries += 1) {
    if (await page.getByTestId("social-load-more-error").isVisible()) break;
    // The whole feed failing instead is the defect this guards: stop and let the checks below say so.
    if (await page.getByTestId("social-feed-error").isVisible()) break;
    await list
      .locator("article")
      .last()
      .scrollIntoViewIfNeeded({ timeout: 2_000 })
      .catch(() => undefined);
    await page.mouse.wheel(0, 4000);
    await page.waitForTimeout(500);
  }
  await expect(page.getByTestId("social-load-more-error")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("social-feed-error")).toHaveCount(0);
  await expect(page.getByText("board post 101")).toBeAttached();

  relay.setClosingSockets(false);
  await page.getByTestId("social-load-more-retry").click();
  await expect(page.getByText(/board post 1(?!\d)/)).toBeAttached({
    timeout: 20_000,
  });
});

test("the one bell is marked when the rooms' notification check failed, instead of showing no count", async ({
  page,
}) => {
  const relay = createMockRelay();
  // The community notification poll (it asks for assigned tasks among its reads) fails.
  relay.setClosingSockets((filter) => asks(filter, 44011));
  await setUp(page, relay);
  await signIn(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/social/explore");
  const bell = page
    .getByTestId("app-nav-inbox")
    .getByTestId("social-nav-notifications");
  await expect(bell.getByTestId("social-unread-failed")).toBeVisible({
    timeout: 20_000,
  });
  await expect(bell).toHaveAccessibleName(/couldn't check for new ones/);
});

test("timeline tabs name the content they show, and arrow keys move between them", async ({
  page,
}) => {
  const relay = createMockRelay();
  await setUp(page, relay);
  await page.goto("/social/explore");
  const trending = page.getByRole("tab", {
    name: "Trending posts",
    exact: true,
  });
  await expect(trending).toHaveAttribute("aria-selected", "true");
  const panelId = await trending.getAttribute("aria-controls");
  expect(panelId).toBe("explore-tabs-panel");
  const panel = page.locator(`#${panelId}`);
  await expect(panel).toHaveAttribute("role", "tabpanel");
  await expect(panel).toHaveAttribute(
    "aria-labelledby",
    (await trending.getAttribute("id")) ?? "",
  );

  await trending.focus();
  await page.keyboard.press("ArrowRight");
  const people = page.getByRole("tab", {
    name: "People to follow",
    exact: true,
  });
  await expect(people).toBeFocused();
  await expect(people).toHaveAttribute("aria-selected", "true");
  await expect(panel).toHaveAttribute(
    "aria-labelledby",
    (await people.getAttribute("id")) ?? "",
  );
  await expect(page.getByRole("tabpanel")).toHaveCount(1);
});

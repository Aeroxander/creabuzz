import { expect, type Page, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { COMMUNITY_HOST, createMockRelay } from "./mock-relay";

/**
 * A read the server refuses is a failure with a retry, never "Nothing is trending yet" / "No posts for ..." / "Nothing
 * here yet" (Review B 4). Every read here is refused, so any empty state on screen would be a false one. Which state a
 * page shows is pinned in `src/features/social/lib/read-view.test.mjs`; this runs it on the real pages.
 */

const NSEC = "77".repeat(32);
const ALICE = "e".repeat(64);
const ME = getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);

async function refuseEveryRead(page: Page) {
  const relay = createMockRelay();
  await relay.install(page);
  await page.routeWebSocket(/127\.0\.0\.1:\d+/, (ws) => {
    ws.onMessage((message) => {
      const frame = JSON.parse(String(message)) as unknown[];
      if (frame[0] === "REQ" && typeof frame[1] === "string") {
        ws.send(
          JSON.stringify(["CLOSED", frame[1], "error: database unavailable"]),
        );
      }
    });
  });
  await page.route("http://127.0.0.1:8545/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x10" }),
    }),
  );
}

async function signIn(page: Page) {
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
    window.localStorage.setItem("buzz.identity.backedUp", "1");
  }, NSEC);
}

test("Explore says its lists could not be read, with a retry, on every tab", async ({
  page,
}) => {
  await refuseEveryRead(page);
  await page.goto("/social/explore");
  await expect(page.getByTestId("social-trending-error")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("social-trending-empty")).toHaveCount(0);
  await expect(
    page.getByTestId("social-trending-error").getByRole("button", {
      name: /try again/i,
    }),
  ).toBeVisible();

  await page
    .getByRole("tab", { name: "People to follow", exact: true })
    .click();
  await expect(page.getByTestId("social-people-error")).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("tab", { name: "Hashtags" }).click();
  await expect(page.getByTestId("social-hashtags-error")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText("No hashtags yet")).toHaveCount(0);
});

test("Search says it could not search, not that nothing matched", async ({
  page,
}) => {
  await refuseEveryRead(page);
  await page.goto("/social/search?q=hello");
  await expect(page.getByTestId("social-search-posts-error")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText('No posts for "hello"')).toHaveCount(0);
  await page.getByRole("tab", { name: "People" }).click();
  await expect(page.getByTestId("social-search-people-error")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText('No people for "hello"')).toHaveCount(0);
});

test("a profile and your bookmarks say they could not be read", async ({
  page,
}) => {
  await refuseEveryRead(page);
  await signIn(page);
  await page.goto(`/u/${ALICE}`);
  await expect(page.getByTestId("profile-posts-error")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText("Nothing here yet")).toHaveCount(0);

  await page.goto("/social/bookmarks");
  await expect(page.getByTestId("social-bookmarks-error")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("social-bookmarks-empty")).toHaveCount(0);
});

test("signed in, Explore's People says suggestions could not be read when who you follow could not be read", async ({
  page,
}) => {
  await refuseEveryRead(page);
  await signIn(page);
  await page.goto("/social/explore");
  await page
    .getByRole("tab", { name: "People to follow", exact: true })
    .click();
  await expect(page.getByTestId("social-people-error")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText("No suggestions yet")).toHaveCount(0);
});

test("Home's Following says who you follow could not be read, not that nothing is here", async ({
  page,
}) => {
  await refuseEveryRead(page);
  await signIn(page);
  await page.goto("/?tab=following");
  await expect(page.getByTestId("social-following-error")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("social-feed-empty")).toHaveCount(0);
});

test("an older page that fails is said at the bottom with Try again, and what loaded stays", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const relay = createMockRelay();
  const now = Math.floor(Date.now() / 1000);
  for (let index = 1; index <= 60; index += 1) {
    relay.seed({
      id: index.toString(16).padStart(64, "0"),
      pubkey: ALICE,
      created_at: now - 1000 + index,
      kind: 1,
      tags: [["t", "pilot"]],
      content: `pilot post ${index} #pilot`,
      sig: "sig",
    });
  }
  // Only the older page is dropped: the first page loads.
  relay.setClosingSockets((filter) => typeof filter?.until === "number");
  await relay.install(page);
  await page.goto("/social/tag/pilot");
  await expect(page.getByText("pilot post 60")).toBeVisible({
    timeout: 20_000,
  });

  await page
    .getByTestId("social-post-list")
    .getByText("pilot post 21")
    .scrollIntoViewIfNeeded();
  await expect(page.getByTestId("social-load-more-error")).toBeVisible({
    timeout: 40_000,
  });
  await expect(page.getByTestId("social-tag-error")).toHaveCount(0);
  await expect(page.getByText("pilot post 60")).toBeVisible();
  await expect(page.getByTestId("social-load-more-retry")).toBeVisible();

  // The server is back: Try again reads the older page.
  relay.setClosingSockets(false);
  await page.getByTestId("social-load-more-retry").click();
  await expect(page.getByText(/pilot post 1(?!\d)/)).toBeVisible({
    timeout: 20_000,
  });
});

test("the bell says it could not check, never 'Nothing new', and Try again recovers", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const relay = createMockRelay();
  const room = "0f0f0f0f-1111-2222-3333-999999999999";
  const now = Math.floor(Date.now() / 1000);
  relay.seed({
    id: "d1".padEnd(64, "0"),
    pubkey: "b".repeat(64),
    created_at: now - 9000,
    kind: 39000,
    tags: [
      ["d", room],
      ["name", "general"],
    ],
    content: "",
    sig: "sig",
  });
  // Only the bell's task read is dropped, so the rest of the page works.
  let refusing = true;
  relay.setClosingSockets(
    (filter) =>
      refusing &&
      Array.isArray(filter?.kinds) &&
      (filter.kinds as number[]).includes(44011),
  );
  await page.route("http://127.0.0.1:8545/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x10" }),
    }),
  );
  await relay.install(page);
  await signIn(page);
  await page.goto(`/c/${COMMUNITY_HOST}`);
  const bell = page.getByTestId("notifications-bell");
  await bell.getByRole("button", { name: "Notifications" }).click();
  await expect(bell.getByTestId("notifications-bell-error")).toContainText(
    "Couldn't check for notifications.",
    { timeout: 60_000 },
  );
  await expect(bell.getByText("Nothing new.")).toHaveCount(0);

  // The server answers again, with a mention waiting.
  refusing = false;
  relay.seed({
    id: "d2".padEnd(64, "0"),
    pubkey: ALICE,
    created_at: now - 30,
    kind: 9,
    tags: [
      ["h", room],
      ["p", ME],
    ],
    content: "ping after the outage",
    sig: "sig",
  });
  await bell.getByTestId("notifications-bell-retry").click();
  await expect(bell.getByText("ping after the outage")).toBeVisible({
    timeout: 30_000,
  });
  await expect(bell.getByTestId("notifications-bell-error")).toHaveCount(0);
});

test("a profile whose short posts could not be read says so above the board posts that did load", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const relay = createMockRelay();
  const board = "f1a40000-1111-2222-3333-999999999999";
  const now = Math.floor(Date.now() / 1000);
  relay.seed({
    id: "e1".padEnd(64, "0"),
    pubkey: "b".repeat(64),
    created_at: now - 9000,
    kind: 39000,
    tags: [["d", board], ["name", "film-making"], ["public"], ["t", "forum"]],
    content: "",
    sig: "sig",
  });
  relay.seed({
    id: "e2".padEnd(64, "0"),
    pubkey: ALICE,
    created_at: now - 600,
    kind: 45001,
    tags: [["h", board]],
    content: "# Alice's board question",
    sig: "sig",
  });
  // Short posts by Alice cannot be read; her board posts can.
  relay.setClosingSockets(
    (filter) =>
      Array.isArray(filter?.kinds) &&
      (filter.kinds as number[]).includes(1) &&
      Array.isArray(filter?.authors),
  );
  await page.route("http://127.0.0.1:8545/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x10" }),
    }),
  );
  await relay.install(page);
  await page.goto(`/u/${ALICE}`);
  await expect(page.getByText("Alice's board question")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("profile-posts-partial-error")).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    page.getByTestId("profile-posts-partial-error").getByRole("button", {
      name: "Try again",
    }),
  ).toBeVisible();
});

import { expect, type Page, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { createMockRelay } from "./mock-relay";

/**
 * The boards front page on Home: every board's posts in one list (Hot / New / Top), voting from the list onto each
 * post's own board, a post opening on its board's page, and the hottest few lifted into the Everyone feed.
 */

const FILM = "f1a40000-1111-2222-3333-444444444444";
const MUSIC = "a05c0000-1111-2222-3333-444444444444";
const CHAT = "c4a70000-1111-2222-3333-444444444444";
const ME_NSEC = "55".repeat(32);
const key = (hex: string) =>
  Uint8Array.from(hex.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16));
const ME = getPublicKey(key(ME_NSEC));
const ANN = "a1".repeat(32);
const BOB = "b2".repeat(32);
const now = () => Math.floor(Date.now() / 1000);

let counter = 0;
const eid = () =>
  `${(++counter).toString(16).padStart(8, "0")}`.padEnd(64, "f");

function meta(id: string, name: string, type: "forum" | "stream") {
  return {
    id: `meta-${id}`,
    pubkey: "b".repeat(64),
    created_at: 100,
    kind: 39000,
    tags: [["d", id], ["name", name], ["public"], ["t", type]],
    content: "",
    sig: "sig",
  };
}

function post(board: string, author: string, at: number, title: string) {
  return {
    id: eid(),
    pubkey: author,
    created_at: at,
    kind: 45001,
    tags: [["h", board]],
    content: `# ${title}\n\nSome **details** about ${title.toLowerCase()}.`,
    sig: "sig",
  };
}

function vote(board: string, author: string, target: string, sign = "+") {
  return {
    id: eid(),
    pubkey: author,
    created_at: now() - 10,
    kind: 45002,
    tags: [
      ["h", board],
      ["e", target],
    ],
    content: sign,
    sig: "sig",
  };
}

function seeded() {
  const relay = createMockRelay({ applyDeletions: true });
  relay.seed(meta(FILM, "film-making", "forum"));
  relay.seed(meta(MUSIC, "music", "forum"));
  relay.seed(meta(CHAT, "general", "stream"));
  const loved = post(FILM, ANN, now() - 3 * 3600, "Keeping a character steady");
  const fresh = post(MUSIC, BOB, now() - 600, "Splitting album royalties");
  const sunk = post(FILM, BOB, now() - 3600, "Buy my course");
  // A post tagged for a chat channel is not a board post and stays out.
  const stray = post(CHAT, ANN, now() - 60, "Not a board post");
  for (const e of [
    loved,
    fresh,
    sunk,
    stray,
    vote(FILM, ANN, loved.id),
    vote(FILM, BOB, loved.id),
    ...["c1", "c2", "c3", "c4"].map((p) =>
      vote(FILM, p.repeat(32), loved.id),
    ),
    vote(FILM, ANN, sunk.id, "-"),
    vote(FILM, "c1".repeat(32), sunk.id, "-"),
  ]) {
    relay.seed(e);
  }
  return { relay, loved, fresh, sunk };
}

async function open(
  page: Page,
  relay: ReturnType<typeof createMockRelay>,
  path = "/?tab=boards",
) {
  await page.route("http://127.0.0.1:8545/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x10" }),
    }),
  );
  await relay.install(page);
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
  }, ME_NSEC);
  await page.goto(path);
}

const titles = (page: Page) =>
  page
    .getByTestId("board-feed-posts")
    .locator("> li")
    .evaluateAll((els) =>
      els.map(
        (el) =>
          el.querySelector("[data-testid='board-post-title']")?.textContent,
      ),
    );

test("the Boards tab mixes every board's posts, Hot first, and re-sorts on request", async ({
  page,
}) => {
  const { relay } = seeded();
  await open(page, relay);

  await expect
    .poll(() => titles(page))
    .toEqual([
      "Keeping a character steady",
      "Splitting album royalties",
      "Buy my course",
    ]);
  const first = page.getByTestId("board-feed-posts").locator("> li").first();
  await expect(first.getByTestId("board-post-board")).toHaveText(
    "film-making",
  );
  await expect(first.getByTestId("board-score")).toContainText("6");
  await expect(first.getByTestId("board-post-preview")).toHaveText(
    "Some details about keeping a character steady.",
  );

  await page.getByTestId("board-feed-sort-new").click();
  await expect
    .poll(() => titles(page))
    .toEqual([
      "Splitting album royalties",
      "Buy my course",
      "Keeping a character steady",
    ]);
  await page.getByTestId("board-feed-sort-top").click();
  await expect
    .poll(() => titles(page))
    .toEqual([
      "Keeping a character steady",
      "Splitting album royalties",
      "Buy my course",
    ]);
  await expect(page.getByTestId("board-feed-boards")).toHaveText(
    /film-making\s*music/,
  );
});

test("a vote from the front page goes to the post's own board and the list holds still", async ({
  page,
}) => {
  const { relay, fresh } = seeded();
  await open(page, relay);
  const row = page.getByTestId(`board-post-${fresh.id}`);
  await row.getByTestId("board-upvote").click();
  await expect(row.getByTestId("board-score")).toContainText("1");
  await expect(row.getByTestId("board-upvote")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const written = relay.events.find(
    (e) => e.kind === 45002 && e.pubkey === ME,
  );
  expect(written?.tags).toEqual([
    ["h", MUSIC],
    ["e", fresh.id],
  ]);
  expect(written?.content).toBe("+");
  // Order is taken when the posts arrive, not on each vote.
  await expect
    .poll(() => titles(page))
    .toEqual([
      "Keeping a character steady",
      "Splitting album royalties",
      "Buy my course",
    ]);
});

test("a post opens on its board's page, and Back returns to the Boards tab", async ({
  page,
}) => {
  const { relay, loved } = seeded();
  await open(page, relay);
  await page
    .getByTestId(`board-post-${loved.id}`)
    .getByTestId("board-post-title")
    .click();
  await expect(page).toHaveURL(new RegExp(`/b/${FILM}\\?post=${loved.id}`));
  await expect(page.getByTestId("board-thread-title")).toHaveText(
    "Keeping a character steady",
  );
  await page.getByRole("link", { name: "Back to all boards" }).click();
  await expect(page).toHaveURL(/\/\?tab=boards$/);
  await expect(page.getByTestId("board-feed-posts")).toBeVisible();
});

test("New post asks which board and posts there", async ({ page }) => {
  const { relay } = seeded();
  await open(page, relay);
  await page.getByTestId("board-feed-new-post").click();
  await page
    .getByTestId("board-feed-composer-board")
    .selectOption({ label: "music" });
  await page.locator("#board-post-title").fill("Mastering for streaming");
  await page.locator("#board-post-body").fill("Which loudness target?");
  await page.getByTestId("board-composer-submit").click();
  await expect(page).toHaveURL(new RegExp(`/b/${MUSIC}\\?post=`));
  await expect(page.getByTestId("board-thread-title")).toHaveText(
    "Mastering for streaming",
  );
  const written = relay.events.find(
    (e) => e.kind === 45001 && e.pubkey === ME,
  );
  expect(written?.tags).toEqual([["h", MUSIC]]);
});

test("Everyone lifts the hottest board posts into the feed", async ({
  page,
}) => {
  const { relay } = seeded();
  await open(page, relay, "/");
  const hot = page.getByTestId("hot-on-boards");
  await expect(hot.getByTestId("hot-on-boards-post")).toHaveCount(3);
  await expect(hot.getByTestId("hot-on-boards-post").first()).toContainText(
    "Keeping a character steady",
  );
  await hot.getByTestId("hot-on-boards-all").click();
  await expect(page).toHaveURL(/\/\?tab=boards$/);
  await expect(page.getByTestId("board-feed-posts")).toBeVisible();
});

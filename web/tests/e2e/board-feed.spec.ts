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
    ...["c1", "c2", "c3", "c4"].map((p) => vote(FILM, p.repeat(32), loved.id)),
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
  await expect(first.getByTestId("board-post-board")).toHaveText("film-making");
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
  const written = relay.events.find((e) => e.kind === 45002 && e.pubkey === ME);
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
  const written = relay.events.find((e) => e.kind === 45001 && e.pubkey === ME);
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

function members(board: string, people: [string, string][], at = 200) {
  return {
    id: eid(),
    pubkey: "b".repeat(64),
    created_at: at,
    kind: 39002,
    tags: [["d", board], ...people.map(([pk, role]) => ["p", pk, "", role])],
    content: "",
    sig: "sig",
  };
}

test("a reader who joined boards sees Your boards first, and only those boards' posts", async ({
  page,
}) => {
  const { relay } = seeded();
  relay.seed(
    members(MUSIC, [
      [BOB, "owner"],
      [ME, "member"],
    ]),
  );
  await open(page, relay);
  await expect(page.getByTestId("board-feed-scope-mine")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect.poll(() => titles(page)).toEqual(["Splitting album royalties"]);
  await expect(
    page.getByTestId("board-feed-boards").locator("a").first(),
  ).toHaveText(/music/);
  await page.getByTestId("board-feed-scope-all").click();
  await expect.poll(() => titles(page)).toHaveLength(3);
});

test("someone who joined nothing is shown every board, and Your boards says how to join", async ({
  page,
}) => {
  const { relay } = seeded();
  await open(page, relay);
  await expect(page.getByTestId("board-feed-scope-all")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByTestId("board-feed-scope-mine").click();
  await expect(page.getByTestId("board-feed-none-joined")).toBeVisible();
});

test("Join on a board writes a join request, and pressing it again leaves", async ({
  page,
}) => {
  const { relay } = seeded();
  await open(page, relay, `/b/${MUSIC}`);
  const join = page.getByTestId("board-join");
  await expect(join).toHaveText("Join");
  await join.click();
  await expect(join).toHaveAttribute("aria-pressed", "true");
  await expect(join).toContainText("Joined");
  expect(
    relay.events.find((e) => e.kind === 9021 && e.pubkey === ME)?.tags,
  ).toEqual([["h", MUSIC]]);
  await join.click();
  await expect(join).toHaveText("Join");
  expect(
    relay.events.find((e) => e.kind === 9022 && e.pubkey === ME)?.tags,
  ).toEqual([["h", MUSIC]]);
});

test("the person who started a board is shown it as theirs, with no Leave", async ({
  page,
}) => {
  const { relay } = seeded();
  relay.seed(members(FILM, [[ME, "owner"]]));
  await open(page, relay, `/b/${FILM}`);
  await expect(page.getByTestId("board-join-state")).toHaveText("Yours");
  await expect(page.getByTestId("board-join")).toHaveCount(0);
});

test("Top can be narrowed to today", async ({ page }) => {
  const { relay } = seeded();
  const old = post(FILM, ANN, now() - 3 * 24 * 3600, "Old but loved");
  relay.seed(old);
  for (const p of ["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8"])
    relay.seed(vote(FILM, p.repeat(32), old.id));
  await open(page, relay);
  await page.getByTestId("board-feed-sort-top").click();
  await page.getByTestId("board-feed-period").selectOption("all");
  await expect.poll(async () => (await titles(page))[0]).toBe("Old but loved");
  await page.getByTestId("board-feed-period").selectOption("day");
  await expect
    .poll(() => titles(page))
    .toEqual([
      "Keeping a character steady",
      "Splitting album royalties",
      "Buy my course",
    ]);
});

test("a post with a picture shows it small, and a post with a link names the site", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  relay.seed(meta(FILM, "film-making", "forum"));
  relay.seed({
    ...post(FILM, ANN, now() - 60, "Our trailer"),
    content:
      "# Our trailer\n\n![still](https://cdn.example/still.png)\n\nWatch it at https://www.youtube.com/watch?v=1",
  });
  await page.route("https://cdn.example/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: "" }),
  );
  await open(page, relay);
  await expect(page.getByTestId("board-post-thumbnail")).toHaveAttribute(
    "src",
    "https://cdn.example/still.png",
  );
  const link = page.getByTestId("board-post-link");
  await expect(link).toHaveText("youtube.com");
  await expect(link).toHaveAttribute(
    "href",
    "https://www.youtube.com/watch?v=1",
  );
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
});

test("a new post by someone else is counted live and shown on request, without moving the list", async ({
  page,
}) => {
  const { relay } = seeded();
  await open(page, relay);
  await expect.poll(() => titles(page)).toHaveLength(3);
  await expect
    .poll(() =>
      relay
        .subscriptionFilters()
        .some(
          (f) =>
            f.kinds?.includes(45001) &&
            (f["#h"] as string[] | undefined)?.includes(MUSIC) &&
            (f["#h"] as string[] | undefined)?.includes(FILM),
        ),
    )
    .toBe(true);
  relay.deliver(post(MUSIC, BOB, now(), "Brand new"));
  const pill = page.getByTestId("board-feed-show-new");
  await expect(pill).toHaveText("1 new post. Show");
  expect(await titles(page)).toHaveLength(3);
  await pill.click();
  await expect.poll(() => titles(page)).toContain("Brand new");
  await expect(pill).toHaveCount(0);
});

test("older posts are read a page at a time", async ({ page }) => {
  const relay = createMockRelay({ applyDeletions: true });
  relay.seed(meta(FILM, "film-making", "forum"));
  for (let i = 0; i < 105; i++)
    relay.seed(post(FILM, ANN, now() - 3600 - i * 60, `Post ${i}`));
  await open(page, relay);
  await page.getByTestId("board-feed-sort-new").click();
  await expect.poll(() => titles(page)).toHaveLength(100);
  await page.getByTestId("board-feed-older").click();
  await expect.poll(() => titles(page)).toHaveLength(105);
  expect((await titles(page)).at(-1)).toBe("Post 104");
});

test("anyone can start a board from Home, and a refusal is said plainly with the name kept", async ({
  page,
}) => {
  let refuseNext = false;
  const relay = createMockRelay({
    applyDeletions: true,
    deriveChannels: true,
    refuse: (event) =>
      event.kind === 9007 && refuseNext
        ? "rate-limited: you can start 5 boards a day; try again tomorrow"
        : null,
  });
  relay.seed(meta(FILM, "film-making", "forum"));
  await open(page, relay);
  await page.getByTestId("board-feed-start").click();
  await page.locator("#start-board-name").fill("indie-games");
  await page.locator("#start-board-about").fill("Small teams making games");
  await page.getByTestId("start-board-submit").click();
  await expect(page).toHaveURL(/\/b\/[0-9a-f-]{36}$/);
  const created = relay.events.find((e) => e.kind === 9007);
  expect(created?.tags).toEqual(
    expect.arrayContaining([
      ["name", "indie-games"],
      ["channel_type", "forum"],
    ]),
  );

  refuseNext = true;
  await page.goto("/?tab=boards");
  await page.getByTestId("board-feed-start").click();
  await page.locator("#start-board-name").fill("one-too-many");
  await page.getByTestId("start-board-submit").click();
  await expect(page.getByTestId("start-board-problem")).toHaveText(
    "You can start 5 boards a day; try again tomorrow.",
  );
  await expect(page.locator("#start-board-name")).toHaveValue("one-too-many");
});

import { expect, type Page, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { expectAccessible } from "../helpers/a11y";
import { createMockRelay } from "./mock-relay";

/**
 * A personal mute applies wherever the reader meets the person (D100): their board posts are left out of the list with
 * a count and a way to show them, their replies and chat messages fold to one line, and what they caused is not in
 * either notification list. Nobody else's view changes, and the reader's own words are never hidden.
 */

const BOARD = "f1a40000-1111-2222-3333-777777777777";
const ROOM = "0f0f0f0f-1111-2222-3333-888888888888";
const ME_NSEC = "59".repeat(32);
const key = (hex: string) =>
  Uint8Array.from(hex.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16));
const ME = getPublicKey(key(ME_NSEC));
const ANN = "a1".repeat(32);
const BOB = "b2".repeat(32);
const now = () => Math.floor(Date.now() / 1000);

let counter = 0;
const eid = () =>
  `${(++counter).toString(16).padStart(8, "0")}`.padEnd(64, "c");

function rec(
  pubkey: string,
  kind: number,
  tags: string[][],
  content: string,
  ago = 60,
) {
  return {
    id: eid(),
    pubkey,
    created_at: now() - ago,
    kind,
    tags,
    content,
    sig: "sig",
  };
}

function profile(pubkey: string, name: string) {
  return rec(pubkey, 0, [], JSON.stringify({ name }), 5000);
}

/** A server where the reader has muted Bob. */
function world() {
  const relay = createMockRelay();
  relay.seed(
    rec(
      "b".repeat(64),
      39000,
      [["d", BOARD], ["name", "film-making"], ["public"], ["t", "forum"]],
      "",
      9000,
    ),
  );
  relay.seed(
    rec(
      "b".repeat(64),
      39000,
      [
        ["d", ROOM],
        ["name", "general"],
      ],
      "",
      9000,
    ),
  );
  relay.seed(profile(ANN, "Ann"));
  relay.seed(profile(BOB, "Bob"));
  relay.seed(rec(ME, 10000, [["p", BOB]], "", 3000));
  return relay;
}

async function open(
  page: Page,
  relay: ReturnType<typeof createMockRelay>,
  path: string,
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
    window.localStorage.setItem("buzz.identity.backedUp", "1");
  }, ME_NSEC);
  await page.goto(path);
}

test("on a board, a muted person's posts are left out with a way to show them, and their replies fold", async ({
  page,
}) => {
  const relay = world();
  const annsPost = rec(ANN, 45001, [["h", BOARD]], "# Ann's question", 600);
  const bobsPost = rec(BOB, 45001, [["h", BOARD]], "# Bob's rant", 500);
  const bobsReply = rec(
    BOB,
    45003,
    [
      ["h", BOARD],
      ["e", annsPost.id, "", "root"],
    ],
    "Bob replying",
    400,
  );
  const annAnswersBob = rec(
    ANN,
    45003,
    [
      ["h", BOARD],
      ["e", annsPost.id, "", "root"],
      ["e", bobsReply.id, "", "reply"],
    ],
    "Ann answering Bob",
    300,
  );
  for (const event of [annsPost, bobsPost, bobsReply, annAnswersBob])
    relay.seed(event);
  await open(page, relay, `/c/alpha.example.com?channel=${BOARD}`);

  const posts = page.getByTestId("board-posts");
  await expect(posts).toContainText("Ann's question");
  await expect(posts).not.toContainText("Bob's rant");
  const hidden = page.getByTestId("board-muted-hidden");
  await expect(hidden).toContainText("1 post from someone you muted");
  await hidden.getByRole("button", { name: "Show" }).click();
  await expect(posts).toContainText("Bob's rant");

  // In Ann's thread, Bob's reply folds; Ann's answer to it stays.
  await page
    .getByTestId(`board-post-${annsPost.id}`)
    .getByTestId("board-post-title")
    .click();
  const bobs = page.getByTestId(`board-reply-${bobsReply.id}`);
  await expect(bobs.getByTestId("muted-line").first()).toContainText(
    "A reply from someone you muted",
  );
  await expect(bobs).not.toContainText("Bob replying");
  await expect(bobs).toContainText("Ann answering Bob");
  await bobs.getByTestId("muted-line").first().getByRole("button").click();
  await expect(bobs).toContainText("Bob replying");
});

test("a muted person's post opened by link says it is from someone you muted", async ({
  page,
}) => {
  const relay = world();
  const bobsPost = rec(BOB, 45001, [["h", BOARD]], "# Bob's rant", 500);
  relay.seed(bobsPost);
  await open(
    page,
    relay,
    `/c/alpha.example.com?channel=${BOARD}&post=${bobsPost.id}`,
  );
  await expect(page.getByTestId("board-thread-muted-author")).toContainText(
    "You muted Bob",
  );
  await expect(page.getByTestId("board-thread")).toContainText("Bob's rant");
});

test("in a room, a muted person's messages fold to one line, and the reader's own never do", async ({
  page,
}) => {
  const relay = world();
  relay.seed(rec(BOB, 9, [["h", ROOM]], "Bob shouting", 300));
  relay.seed(rec(ANN, 9, [["h", ROOM]], "Ann talking", 200));
  relay.seed(rec(ME, 9, [["h", ROOM]], "My own words", 100));
  await open(page, relay, `/c/alpha.example.com?channel=${ROOM}`);
  await expect(page.getByText("Ann talking")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("My own words")).toBeVisible();
  await expect(page.getByText("Bob shouting")).toHaveCount(0);
  const line = page.getByTestId("muted-line");
  await expect(line).toHaveCount(1);
  await expect(line).toContainText("A message from someone you muted");
  await expectAccessible(page, "a folded message");
  await line.getByRole("button", { name: "Show" }).click();
  await expect(page.getByText("Bob shouting")).toBeVisible();
});

test("what a muted person caused is not in notifications, and is not counted", async ({
  page,
}) => {
  const relay = world();
  relay.seed(rec(BOB, 1, [["p", ME]], "hey @you from Bob", 200));
  relay.seed(rec(ANN, 1, [["p", ME]], "hey @you from Ann", 100));
  // The community's bell reads mentions in rooms.
  relay.seed(
    rec(
      BOB,
      9,
      [
        ["h", ROOM],
        ["p", ME],
      ],
      "room ping from Bob",
      200,
    ),
  );
  relay.seed(
    rec(
      ANN,
      9,
      [
        ["h", ROOM],
        ["p", ME],
      ],
      "room ping from Ann",
      100,
    ),
  );
  await open(page, relay, "/social/notifications");
  const items = page.getByTestId("social-notification");
  await expect(items.filter({ hasText: "Ann" })).not.toHaveCount(0);
  await expect(page.getByText("from Bob")).toHaveCount(0);
  await expect(items.filter({ hasText: "Bob" })).toHaveCount(0);

  // The community's bell leaves Bob's mention out too.
  await page.goto("/c/alpha.example.com");
  const bell = page.getByTestId("notifications-bell");
  await expect(bell).toContainText("1", { timeout: 30_000 });
  await bell.getByRole("button").first().click();
  await expect(bell.getByText("room ping from Ann")).toBeVisible();
  await expect(bell.getByText("room ping from Bob")).toHaveCount(0);
});

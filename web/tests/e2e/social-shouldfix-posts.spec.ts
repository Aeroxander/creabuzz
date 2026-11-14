import { expect, type Page, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { createMockRelay } from "./mock-relay";

/**
 * What the 2026-10-30 screen audit asked of posts, boards and their dialogs: a board post on Home can be reported and
 * bookmarked like a short post; nobody is named by a key while their name loads; the quote dialog has a title, a way
 * out and the quoted author; a dialog covers the whole window; the Moderate menu stays on a phone's screen; a visitor
 * on a board thread is offered an account instead of a reply box.
 */

const FILM = "f1a40000-1111-2222-3333-444444444444";
const ME_NSEC = "56".repeat(32);
const key = (hex: string) =>
  Uint8Array.from(hex.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16));
const ME = getPublicKey(key(ME_NSEC));
const ANN = "a1".repeat(32);
const now = () => Math.floor(Date.now() / 1000);

let counter = 0;
const eid = () =>
  `${(++counter).toString(16).padStart(8, "0")}`.padEnd(64, "e");

const boardMeta = {
  id: "meta-film",
  pubkey: "b".repeat(64),
  created_at: 100,
  kind: 39000,
  tags: [["d", FILM], ["name", "film-making"], ["public"], ["t", "forum"]],
  content: "",
  sig: "sig",
};

function boardPost(title: string) {
  return {
    id: eid(),
    pubkey: ANN,
    created_at: now() - 600,
    kind: 45001,
    tags: [["h", FILM]],
    content: `# ${title}\n\nDM me for a price.`,
    sig: "sig",
  };
}

function note(content: string) {
  return {
    id: eid(),
    pubkey: ANN,
    created_at: now() - 300,
    kind: 1,
    tags: [],
    content,
    sig: "sig",
  };
}

async function open(
  page: Page,
  relay: ReturnType<typeof createMockRelay>,
  path = "/",
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
    }, ME_NSEC);
  await page.goto(path);
}

test("a board post on Home can be reported to its board's moderators and bookmarked, and its author is never a key", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  relay.seed(boardMeta);
  const spam = boardPost("Cheap followers");
  relay.seed(spam);
  await open(page, relay);

  const card = page
    .getByTestId("social-board-post")
    .filter({ hasText: "Cheap followers" });
  await expect(card).toBeVisible();
  // Ann has no profile: she is "Someone", with no initials or handle made from her key.
  await expect(card).toContainText("Someone");
  await expect(card).not.toContainText(ANN.slice(0, 8));

  await card.getByTestId("social-board-report").click();
  const dialog = page.getByRole("dialog", { name: "Report this post" });
  await expect(dialog.getByTestId("report-privacy")).toHaveText(
    "Board moderators don't see who reported. The community's moderators do. Nothing is removed until they decide.",
  );
  // The dialog covers the whole window, not only the timeline column.
  expect(
    await page
      .getByTestId("modal-backdrop")
      .evaluate((el) => el.parentElement === document.body),
  ).toBe(true);
  const nav = await page.getByTestId("app-nav").boundingBox();
  if (!nav) throw new Error("no app nav");
  expect(
    await page.evaluate(
      ([x, y]) =>
        document
          .elementFromPoint(x, y)
          ?.closest("[data-testid='modal-backdrop']") !== null,
      [nav.x + 10, nav.y + nav.height / 2],
    ),
  ).toBe(true);
  await dialog.getByTestId("report-reason-spam").check();
  await dialog.getByTestId("report-submit").click();
  await expect
    .poll(() => relay.events.find((e) => e.kind === 1984)?.tags)
    .toEqual([
      ["e", spam.id, "spam"],
      ["p", ANN],
    ]);

  await card.getByTestId("social-board-bookmark").click();
  await expect(card.getByTestId("social-board-bookmark")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // The button answers at once; the page is left only after the server holds the saved list.
  await expect
    .poll(() => relay.events.filter((e) => e.kind === 10003).length)
    .toBe(1);
  await page.goto("/social/bookmarks");
  await expect(
    page
      .getByTestId("social-board-post")
      .filter({ hasText: "Cheap followers" }),
  ).toBeVisible();
});

test("the quote dialog has a title, a Cancel, and the quoted post's author", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  relay.seed({
    id: eid(),
    pubkey: ANN,
    created_at: now() - 900,
    kind: 0,
    tags: [],
    content: JSON.stringify({ name: "Frida Lund" }),
    sig: "sig",
  });
  relay.seed(note("Help build Creaton."));
  await open(page, relay);

  const post = page
    .getByTestId("social-post")
    .filter({ hasText: "Help build Creaton." });
  await post.getByTestId("social-repost").click();
  await page.getByTestId("social-quote").click();
  const dialog = page.getByTestId("social-quote-dialog");
  await expect(
    dialog.getByRole("heading", { name: "Quote post" }),
  ).toBeVisible();
  await expect(dialog.getByTestId("social-quote-original")).toContainText(
    "Frida Lund",
  );
  await dialog.getByTestId("social-quote-cancel").click();
  await expect(dialog).not.toBeVisible();
});

test("on a phone the Moderate menu stays on screen", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const relay = createMockRelay({ applyDeletions: true });
  relay.seed(boardMeta);
  relay.seed({
    id: eid(),
    pubkey: "b".repeat(64),
    created_at: 200,
    kind: 39002,
    tags: [
      ["d", FILM],
      ["p", ME, "", "owner"],
    ],
    content: "",
    sig: "sig",
  });
  const post = boardPost("Cheap followers");
  relay.seed(post);
  await open(page, relay, `/b/${FILM}?post=${post.id}`);

  await page.getByTestId("board-moderate-post").click();
  const menu = page.getByRole("menu", { name: "Moderate" });
  await expect(menu).toBeVisible();
  const box = await menu.boundingBox();
  if (!box) throw new Error("no menu");
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(375);
});

test("a visitor on a board thread is offered an account, not a reply box", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  relay.seed(boardMeta);
  const post = boardPost("Where did you get stuck?");
  relay.seed(post);
  await open(page, relay, `/b/${FILM}?post=${post.id}`, false);

  await expect(page.getByTestId("board-thread-title")).toHaveText(
    "Where did you get stuck?",
  );
  await expect(page.getByTestId("board-reply-sign-up")).toContainText(
    "Create your account to reply.",
  );
  await expect(page.getByTestId("board-reply-form")).toHaveCount(0);
  // One back control: the page's own.
  await expect(page.getByTestId("board-back")).toHaveCount(1);
});

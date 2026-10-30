import { expect, type Page, test } from "@playwright/test";
import { neventEncode } from "nostr-tools/nip19";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";

import { createMockRelay } from "./mock-relay";

/**
 * Home's should-fix items for the social run: new posts wait behind "N new posts. Show" instead of never arriving;
 * a line marks what is new since the last visit; a repost or quote of a deleted post stops showing its words; the Home
 * composer adds a picture; and a signed-out visitor is not told reading needs no account on an invite-only server.
 */

const PORT = process.env.E2E_PORT ?? "4173";
const key = (hex: string) =>
  Uint8Array.from(hex.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16));
const ME_NSEC = "57".repeat(32);
const ME = getPublicKey(key(ME_NSEC));
const ANN_KEY = key("a7".repeat(32));
const ANN = getPublicKey(ANN_KEY);
const BOB = "b2".repeat(32);
const now = () => Math.floor(Date.now() / 1000);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let counter = 0;
const eid = () =>
  `${(++counter).toString(16).padStart(8, "0")}`.padEnd(64, "e");

function note(
  author: string,
  at: number,
  content: string,
  tags: string[][] = [],
) {
  return {
    id: eid(),
    pubkey: author,
    created_at: at,
    kind: 1,
    tags,
    content,
    sig: "sig",
  };
}

async function open(
  page: Page,
  relay: ReturnType<typeof createMockRelay>,
  {
    signedIn = true,
    path = "/",
    access,
  }: { signedIn?: boolean; path?: string; access?: string } = {},
) {
  await page.route("http://127.0.0.1:8545/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x10" }),
    }),
  );
  await relay.install(page);
  if (access) {
    // Registered after the mock's own answer, so it is the one used.
    await page.route("**/info", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/nostr+json",
        body: JSON.stringify({ name: "Mock server", access }),
      }),
    );
  }
  if (signedIn) {
    await page.addInitScript((nsec) => {
      window.localStorage.setItem("buzz.identity.nsec", nsec);
      window.localStorage.setItem("buzz.identity.backedUp", "1");
    }, ME_NSEC);
  }
  await page.goto(path);
}

const post = (page: Page, text: string) =>
  page.getByTestId("social-post").filter({ hasText: text });

/** The posts' texts, top to bottom, with the last-visit line where it is drawn. */
const order = (page: Page) =>
  page
    .locator("[data-testid='social-post'], [data-testid='home-last-visit']")
    .evaluateAll((els) =>
      els.map((el) =>
        el.getAttribute("data-testid") === "home-last-visit"
          ? "--- last visit ---"
          : (el.querySelector("p.whitespace-pre-wrap")?.textContent ?? ""),
      ),
    );

test("a new post waits behind the bar, and Show puts it on top without moving the rest", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  relay.seed(note(ANN, now() - 3600, "An older post"));
  relay.seed(note(BOB, now() - 600, "The newest post read"));
  await page.clock.install();
  await open(page, relay);
  await expect(post(page, "The newest post read")).toBeVisible();
  await expect(page.getByTestId("home-show-new")).toHaveCount(0);

  relay.seed(note(ANN, now(), "Fresh off the press"));
  relay.seed(note(BOB, now(), "Another fresh one"));
  // Nothing moves until the next check (every 45 seconds while Home is on screen).
  await page.clock.runFor(46_000).catch(() => {});
  const show = page.getByTestId("home-show-new");
  await expect(show).toHaveText("2 new posts. Show");
  await expect(page.getByTestId("home-new-posts")).toHaveAttribute(
    "aria-live",
    "polite",
  );
  await expect(post(page, "Fresh off the press")).toHaveCount(0);

  // Keyboard: the bar is a button.
  await show.focus();
  await page.keyboard.press("Enter");
  await expect(post(page, "Fresh off the press")).toBeVisible();
  await expect(page.getByTestId("home-show-new")).toHaveCount(0);
  const texts = await order(page);
  expect(texts.slice(0, 2).sort()).toEqual([
    "Another fresh one",
    "Fresh off the press",
  ]);
  expect(texts.slice(2)).toEqual(["The newest post read", "An older post"]);
  await expect(page.getByTestId("home-new-posts")).toContainText(
    "2 new posts shown at the top.",
  );
  // Focus goes with the posts it offered.
  await expect(page.getByRole("region", { name: "Posts" })).toBeFocused();
});

test("a muted person's new post is not counted", async ({ page }) => {
  const relay = createMockRelay();
  relay.seed(note(BOB, now() - 600, "The newest post read"));
  relay.seed({
    id: eid(),
    pubkey: ME,
    created_at: now() - 900,
    kind: 10000,
    tags: [["p", ANN]],
    content: "",
    sig: "sig",
  });
  await page.clock.install();
  await open(page, relay);
  await expect(post(page, "The newest post read")).toBeVisible();
  relay.seed(note(ANN, now(), "From someone muted"));
  relay.seed(note(BOB, now(), "From someone else"));
  await page.clock.runFor(46_000).catch(() => {});
  await expect(page.getByTestId("home-show-new")).toHaveText(
    "1 new post. Show",
  );
});

/** `n` replies to `target`, one a second, the last at `at`. */
const seedReplies = (
  relay: ReturnType<typeof createMockRelay>,
  target: { id: string },
  n: number,
  at: number,
) => {
  for (let i = 0; i < n; i++)
    relay.seed(note(ANN, at - i, `Reply ${i}`, [["e", target.id, "", "root"]]));
};

test("replies between two posts do not stop Home finding the next one", async ({
  page,
}) => {
  const relay = createMockRelay();
  const shown = note(BOB, now() - 600, "The newest post read");
  relay.seed(shown);
  await page.clock.install();
  await open(page, relay);
  await expect(post(page, "The newest post read")).toBeVisible();

  // A busy conversation: 30 replies before one check, 30 more and a post before the next. One read holds 40.
  seedReplies(relay, shown, 30, now() - 100);
  const reads = relay.requestsFor(6);
  await page.clock.runFor(46_000).catch(() => {});
  // That check has read the 30 replies before the next ones are posted.
  await expect.poll(() => relay.requestsFor(6)).toBeGreaterThan(reads);
  await expect(page.getByTestId("home-show-new")).toHaveCount(0);
  seedReplies(relay, shown, 30, now() - 50);
  relay.seed(note(BOB, now() - 40, "Posted after the replies"));
  await page.clock.runFor(46_000).catch(() => {});
  const show = page.getByTestId("home-show-new");
  await expect(show).toHaveText("1 new post. Show");
  // Not squashed into a 0-high row: the pill holds its words.
  expect(await show.evaluate((el) => el.clientHeight >= el.scrollHeight)).toBe(
    true,
  );
});

test("a full read of replies still offers Show, which reads Home again from the top", async ({
  page,
}) => {
  const relay = createMockRelay();
  const shown = note(BOB, now() - 600, "The newest post read");
  relay.seed(shown);
  await page.clock.install();
  await open(page, relay);
  await expect(post(page, "The newest post read")).toBeVisible();

  seedReplies(relay, shown, 40, now() - 100);
  await page.clock.runFor(46_000).catch(() => {});
  const show = page.getByTestId("home-show-new");
  await expect(show).toHaveText("Many new posts. Show");
  relay.seed(note(BOB, now() - 50, "Waiting below the replies"));
  await show.click();
  await expect(post(page, "Waiting below the replies")).toBeVisible();
  await expect(show).toHaveCount(0);
  await expect(page.getByTestId("home-new-posts")).toContainText(
    "Showing the newest posts.",
  );
  // The next check starts from the reread: the replies do not bring the bar back.
  await page.clock.runFor(46_000).catch(() => {});
  await expect(show).toHaveCount(0);
});

test("Following checks only the people followed, and Show keeps the order newest first", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(note(ANN, now() - 600, "A followed post"));
  relay.seed({
    id: eid(),
    pubkey: ME,
    created_at: now() - 900,
    kind: 3,
    tags: [["p", ANN]],
    content: "",
    sig: "sig",
  });
  await page.clock.install();
  await open(page, relay, { path: "/?tab=following" });
  await expect(post(page, "A followed post")).toBeVisible();
  relay.seed(note(ANN, now(), "Followed and fresh"));
  relay.seed(note(BOB, now(), "Not followed"));
  await page.clock.runFor(46_000).catch(() => {});
  await page.getByTestId("home-show-new").click();
  await expect
    .poll(() => order(page))
    .toEqual(["Followed and fresh", "A followed post"]);
});

test("after a reload, New draws a line under what is new since the last visit", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(note(ANN, now() - 3600, "An older post"));
  relay.seed(note(BOB, now() - 600, "Seen last time"));
  await open(page, relay);
  await page.getByTestId("home-sort-new").click();
  await expect(post(page, "Seen last time")).toBeVisible();
  // A first visit has no line.
  await expect(page.getByTestId("home-last-visit")).toHaveCount(0);

  relay.seed(note(ANN, now() - 60, "Posted while away"));
  await page.reload();
  // Hot is not newest first: no line there.
  await expect(post(page, "Posted while away")).toBeVisible();
  await expect(page.getByTestId("home-last-visit")).toHaveCount(0);
  await page.getByTestId("home-sort-new").click();
  await expect
    .poll(() => order(page))
    .toEqual([
      "Posted while away",
      "--- last visit ---",
      "Seen last time",
      "An older post",
    ]);
  await expect(page.getByTestId("home-last-visit")).toContainText(
    "New since your last visit",
  );
});

test("a repost and a quote of a deleted post stop showing its words", async ({
  page,
}) => {
  const relay = createMockRelay();
  // A real signature: the repost's embedded copy is authentic, and was trusted on its own before.
  const original = finalizeEvent(
    {
      kind: 1,
      created_at: now() - 7200,
      tags: [],
      content: "Words that were deleted",
    },
    ANN_KEY,
  );
  relay.seed(original);
  relay.seed({
    id: eid(),
    pubkey: BOB,
    created_at: now() - 600,
    kind: 6,
    tags: [
      ["e", original.id],
      ["p", ANN],
    ],
    content: JSON.stringify(original),
    sig: "sig",
  });
  relay.seed(
    note(
      BOB,
      now() - 300,
      `Look at this\n\nnostr:${neventEncode({ id: original.id, author: ANN })}`,
      [["q", original.id, "", ANN]],
    ),
  );
  await open(page, relay);
  await expect(post(page, "Words that were deleted").first()).toBeVisible();
  const quote = post(page, "Look at this");
  await expect(quote.getByTestId("social-quote-card")).toContainText(
    "Words that were deleted",
  );

  // Its author deletes it: the server stops returning it.
  relay.events.splice(
    relay.events.findIndex((e) => e.id === original.id),
    1,
  );
  await page.reload();
  await expect(quote.getByTestId("social-quote-missing")).toHaveText(
    "This post was removed.",
  );
  await expect(page.getByText("Words that were deleted")).toHaveCount(0);
});

test("the Home composer adds a picture, and the post shows it", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(note(BOB, now() - 600, "Someone else's post"));
  const pictureUrl = `http://127.0.0.1:${PORT}/media/${"cd".repeat(32)}.png`;
  const uploads: string[] = [];
  await open(page, relay);
  await page.route("**/upload", async (route) => {
    uploads.push(route.request().headers().authorization ?? "");
    await route.fulfill({
      json: {
        url: pictureUrl,
        sha256: "cd".repeat(32),
        size: PNG.length,
        type: "image/png",
        uploaded: 1,
      },
    });
  });
  await page.route("**/media/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PNG }),
  );

  const composer = page.getByTestId("social-composer");
  await expect(
    composer.getByRole("button", { name: "Add a picture" }),
  ).toBeVisible();
  await composer.getByTestId("social-composer-input").fill("My new drawing");
  await composer.getByTestId("social-composer-file").setInputFiles({
    name: "drawing.png",
    mimeType: "image/png",
    buffer: PNG,
  });
  await expect(composer.getByTestId("social-composer-input")).toHaveValue(
    `My new drawing\n\n${pictureUrl}\n`,
  );
  expect(uploads).toHaveLength(1);
  await composer.getByTestId("social-composer-submit").click();
  await expect
    .poll(
      () =>
        relay.events.find((e) => e.kind === 1 && e.pubkey === ME)?.content ??
        "",
    )
    .toContain(pictureUrl);
  const mine = post(page, "My new drawing");
  // Pictures load as they come near the screen, through the server's signed read (an object address, not the link).
  await mine.scrollIntoViewIfNeeded();
  await expect(mine.locator("img[src^='blob:']")).toHaveCount(1);
});

test("a failed upload says so in plain words and keeps the draft", async ({
  page,
}) => {
  const relay = createMockRelay();
  await open(page, relay);
  // The server's own words for a file over its limit (`buzz-media` `MediaError::FileTooLarge`).
  const said = "file too large: 99999999 bytes (max 52428800)";
  await page.route("**/upload", (route) =>
    route.fulfill({ status: 413, json: { error: said } }),
  );
  const composer = page.getByTestId("social-composer");
  await composer.getByTestId("social-composer-input").fill("Keep these words");
  await composer.getByTestId("social-composer-file").setInputFiles({
    name: "drawing.png",
    mimeType: "image/png",
    buffer: PNG,
  });
  const alert = composer.getByRole("alert");
  await expect(alert).toHaveText(
    "This file is too big for this server. Try a smaller one.",
  );
  // The server's own words are kept, folded away.
  await expect(
    composer.getByTestId("social-composer-problem-details"),
  ).toContainText(said);
  await expect(composer.getByTestId("social-composer-input")).toHaveValue(
    "Keep these words",
  );
});

for (const access of ["invite_only", "open"] as const) {
  test(`signed out on an ${access === "open" ? "open" : "invite-only"} server, the composer ${access === "open" ? "says" : "does not say"} reading needs no account`, async ({
    page,
  }) => {
    const relay = createMockRelay();
    const target = note(BOB, now() - 600, "A post to reply to");
    relay.seed(target);
    await open(page, relay, {
      signedIn: false,
      path: `/social/post/${target.id}`,
      access,
    });
    const composer = page.getByTestId("social-reply-composer-sign-in");
    await expect(composer).toBeVisible();
    const line = page.locator("div", { has: composer }).last();
    if (access === "open") {
      await expect(line).toContainText("Reading needs no account.");
    } else {
      // Give the server's answer time to arrive, then check it is still not said.
      await expect
        .poll(() =>
          page.evaluate(() =>
            performance
              .getEntriesByType("resource")
              .some((entry) => entry.name.endsWith("/info")),
          ),
        )
        .toBe(true);
      await expect(line).toContainText("to post, reply, vote and follow.");
      await expect(line).not.toContainText("Reading needs no account");
    }
  });
}

test("on a phone, posts scrolled under Home's header pass under it: their avatars too", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed({
    id: "profile-ann",
    pubkey: ANN,
    created_at: 50,
    kind: 0,
    tags: [],
    content: JSON.stringify({ name: "Ann Writer" }),
    sig: "sig",
  });
  for (let index = 0; index < 20; index += 1)
    relay.seed(
      note(ANN, now() - index * 60, `Scrolled post ${index}, long enough.`),
    );
  await page.setViewportSize({ width: 375, height: 800 });
  await open(page, relay);
  await expect(page.getByText("Scrolled post 3,")).toBeVisible({
    timeout: 20_000,
  });

  // Scroll in small steps until an avatar sits under the header, then ask what is on top there.
  const coveredAvatarOnTop = async () =>
    page.evaluate(() => {
      const header = document.querySelector("header.sticky");
      if (!header) return null;
      const bar = header.getBoundingClientRect();
      for (const avatar of document.querySelectorAll(
        'article a[aria-label$="\'s profile"]',
      )) {
        const box = avatar.getBoundingClientRect();
        const y = Math.max(box.top, bar.top) + 2;
        if (box.bottom <= bar.top + 4 || y >= bar.bottom - 2) continue;
        const top = document.elementFromPoint(box.left + box.width / 2, y);
        return Boolean(top?.closest("header"));
      }
      return null;
    });
  await page.mouse.move(200, 500);
  let underHeader: boolean | null = null;
  for (let step = 0; step < 40 && underHeader === null; step += 1) {
    await page.mouse.wheel(0, 40);
    await page.waitForTimeout(50);
    underHeader = await coveredAvatarOnTop();
  }
  // An avatar was found under the header, and the header is what shows there.
  expect(underHeader).toBe(true);
});

import { expect, type Page, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { createMockRelay } from "./mock-relay";

/**
 * Board moderation (D93): rules above the posts, pinned threads first, locked threads that take no replies, mutes on
 * one board, appointed moderators and the public moderation log.
 *
 * The server is a mock that keeps what it is sent, so what is checked is what the page shows from the server's own
 * records (the board state, kind 39008, and log entries, kind 45004) and the commands it writes (kinds 9045–9053). The
 * real server's decisions are covered by `crates/buzz-relay/src/handlers/board_moderation_tests.rs`.
 */

const BOARD = "b0a4d000-1111-2222-3333-555555555555";
const SERVER = "b".repeat(64);
const OWNER_NSEC = "55".repeat(32);
const key = (hex: string) =>
  Uint8Array.from(hex.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16));
const OWNER = getPublicKey(key(OWNER_NSEC));
const ANN = "a1".repeat(32);
const BOB = "b2".repeat(32);
const now = () => Math.floor(Date.now() / 1000);

let counter = 0;
const eid = () =>
  `${(++counter).toString(16).padStart(8, "0")}`.padEnd(64, "f");

function record(kind: number, tags: string[][], content = "", at = 100) {
  return {
    id: eid(),
    pubkey: SERVER,
    created_at: at,
    kind,
    tags,
    content,
    sig: "sig",
  };
}

function post(author: string, at: number, title: string) {
  return {
    id: eid(),
    pubkey: author,
    created_at: at,
    kind: 45001,
    tags: [["h", BOARD]],
    content: `# ${title}`,
    sig: "sig",
  };
}

function boardMembers(role: "owner" | "member") {
  return record(39002, [
    ["d", BOARD],
    ["p", ANN, "", "member"],
    ["p", BOB, "", "member"],
    ["p", OWNER, "", role],
  ]);
}

function boardState(tags: string[][], rules = "", at = 110) {
  return record(39008, [["d", BOARD], ["h", BOARD], ...tags], rules, at);
}

function logEntry(tags: string[][], reason = "", at = now() - 30) {
  return record(45004, [["h", BOARD], ...tags], reason, at);
}

function relayWith(...events: ReturnType<typeof record>[]) {
  const relay = createMockRelay({ applyDeletions: true });
  relay.seed(
    record(39000, [
      ["d", BOARD],
      ["name", "supporters"],
      ["public"],
      ["t", "forum"],
    ]),
  );
  for (const event of events) relay.seed(event);
  return relay;
}

async function open(
  page: Page,
  relay: ReturnType<typeof createMockRelay>,
  postId?: string,
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
  }, OWNER_NSEC);
  await page.goto(
    `/c/alpha.example.com?channel=${BOARD}${postId ? `&post=${postId}` : ""}`,
  );
  await page.getByTestId("content-pane").waitFor();
}

const titles = (page: Page) =>
  page
    .getByTestId("board-posts")
    .locator("> li")
    .evaluateAll((els) =>
      els.map(
        (el) =>
          el.querySelector("[data-testid='board-post-title']")?.textContent,
      ),
    );

test("the rules show above the posts, pinned threads come first and locked ones say so", async ({
  page,
}) => {
  const older = post(ANN, now() - 900, "Pinned welcome");
  const newer = post(BOB, now() - 100, "Fresh question");
  const locked = post(BOB, now() - 500, "Settled argument");
  const relay = relayWith(
    boardMembers("member"),
    older,
    newer,
    locked,
    boardState(
      [
        ["pinned", older.id, "200"],
        ["locked", locked.id, "210"],
      ],
      "Be kind. Stay on topic.",
    ),
  );
  await open(page, relay);

  await expect(page.getByTestId("board-rules")).toContainText("Board rules");
  await page.getByTestId("board-rules").locator("summary").click();
  await expect(page.getByTestId("board-rules")).toContainText(
    "Be kind. Stay on topic.",
  );
  // A reader who is not an owner or admin cannot change them.
  await expect(page.getByTestId("board-rules-edit")).toHaveCount(0);

  await expect
    .poll(() => titles(page))
    .toEqual(["Pinned welcome", "Fresh question", "Settled argument"]);
  await expect(
    page.getByTestId(`board-post-${older.id}`).getByTestId("board-post-pinned"),
  ).toBeVisible();
  await expect(
    page
      .getByTestId(`board-post-${locked.id}`)
      .getByTestId("board-post-locked"),
  ).toBeVisible();

  // In the locked thread a reader is told, and offered no way to reply.
  await page
    .getByTestId(`board-post-${locked.id}`)
    .getByTestId("board-post-title")
    .click();
  await expect(page.getByTestId("board-thread-locked-note")).toContainText(
    "No new replies",
  );
  await expect(page.getByTestId("board-reply-form")).toHaveCount(0);
  await expect(page.getByTestId("board-reply-post")).toHaveCount(0);
  await expect(page.getByTestId("board-thread-lock")).toHaveCount(0);
});

test("a board owner locks and pins a thread and mutes someone, and each is one command to the server", async ({
  page,
}) => {
  const theirs = post(ANN, now() - 600, "Off topic");
  const relay = relayWith(boardMembers("owner"), theirs);
  await open(page, relay, theirs.id);

  await page.getByTestId("board-thread-lock").click();
  await page.getByTestId("board-thread-pin").click();
  await expect
    .poll(
      () =>
        relay.events.filter((e) => e.kind === 9045 || e.kind === 9047).length,
    )
    .toBe(2);
  const lock = relay.events.find((e) => e.kind === 9045);
  expect(lock?.tags).toEqual([
    ["h", BOARD],
    ["e", theirs.id],
  ]);
  expect(relay.events.find((e) => e.kind === 9047)?.pubkey).toBe(OWNER);

  await page.getByTestId("board-mute-post").click();
  await expect(page.getByTestId("board-mute-days-30")).toBeVisible();
  // An owner sets a long mute alone: nothing about a second moderator.
  await page.getByTestId("board-mute-days-14").check();
  await expect(page.getByTestId("board-mute-second")).toHaveCount(0);
  await page.getByTestId("board-mute-reason").fill("Keeps posting adverts");
  await page.getByTestId("board-mute-submit").click();
  await expect(page.getByTestId("board-mute-form")).toHaveCount(0);
  const mute = relay.events.find((e) => e.kind === 9049);
  expect(mute?.tags).toContainEqual(["h", BOARD]);
  expect(mute?.tags).toContainEqual(["p", ANN]);
  expect(mute?.tags).toContainEqual(["reason", "Keeps posting adverts"]);
  const until = Number(mute?.tags.find((t) => t[0] === "expiration")?.[1]);
  expect(until - now()).toBeGreaterThan(13 * 86_400);
  expect(until - now()).toBeLessThanOrEqual(14 * 86_400 + 5);
});

test("an appointed moderator is told a long mute needs a second moderator, and cannot appoint others", async ({
  page,
}) => {
  const theirs = post(ANN, now() - 600, "Spam");
  const relay = relayWith(
    boardMembers("member"),
    theirs,
    boardState([["moderator", OWNER, String(now() + 30 * 86_400)]]),
  );
  await open(page, relay, theirs.id);

  await expect(page.getByTestId("board-thread-lock")).toBeVisible();
  await page.getByTestId("board-mute-post").click();
  await page.getByTestId("board-mute-days-30").check();
  await expect(page.getByTestId("board-mute-second")).toContainText(
    "only if another moderator",
  );
  await page.getByTestId("board-mute-days-7").check();
  await expect(page.getByTestId("board-mute-second")).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel" }).click();

  await page.getByTestId("board-back").click();
  await page.getByTestId("board-moderation-toggle").click();
  await expect(page.getByTestId("board-moderators")).toContainText("until");
  await expect(page.getByTestId("board-appoint-form")).toHaveCount(0);
  await expect(page.getByTestId("board-moderator-step-down")).toBeVisible();
});

test("the moderation log reads in plain words, a muted reader is told, and a removed reply is counted in its thread", async ({
  page,
}) => {
  const thread = post(ANN, now() - 600, "Busy thread");
  const relay = relayWith(
    boardMembers("member"),
    thread,
    logEntry(
      [
        ["action", "mute"],
        ["actor", ANN],
        ["role", "moderator"],
        ["p", OWNER],
        ["until", String(now() + 3 * 86_400)],
      ],
      "Repeated insults",
      now() - 60,
    ),
    logEntry(
      [
        ["action", "remove"],
        ["actor", ANN],
        ["role", "moderator"],
        ["e", "9".repeat(64)],
        ["thread", thread.id],
      ],
      "Spam link",
      now() - 50,
    ),
  );
  await open(page, relay);

  await expect(page.getByTestId("board-muted-note")).toContainText(
    "You are muted on this board until",
  );
  await page.getByTestId("board-moderation-toggle").click();
  const entries = page.getByTestId("board-log-entry");
  await expect(entries).toHaveCount(2);
  await expect(entries.first()).toContainText("removed a reply");
  await expect(entries.nth(1)).toContainText("muted you on this board until");
  await expect(entries.nth(1)).toContainText("Reason: Repeated insults");
  // A reader cannot lift their own mute.
  await expect(page.getByTestId("board-log-unmute")).toHaveCount(0);

  await page
    .getByTestId(`board-post-${thread.id}`)
    .getByTestId("board-post-title")
    .click();
  await expect(page.getByTestId("board-thread-removed")).toContainText(
    "1 reply was removed by moderators: Spam link.",
  );
  await expect(page.getByTestId("board-thread-muted-note")).toBeVisible();
  await expect(page.getByTestId("board-reply-form")).toHaveCount(0);
});

test("a board owner writes the rules and appoints a moderator", async ({
  page,
}) => {
  const relay = relayWith(boardMembers("owner"));
  await open(page, relay);

  await page.getByTestId("board-rules-write").click();
  await page.getByTestId("board-rules-box").fill("No spam.");
  await page.getByTestId("board-rules-save").click();
  await expect
    .poll(() => relay.events.find((e) => e.kind === 9051)?.content)
    .toBe("No spam.");

  await page.getByTestId("board-moderation-toggle").click();
  await page.getByTestId("board-appoint-person").fill(BOB);
  await page.getByTestId("board-appoint-submit").click();
  await expect
    .poll(() => relay.events.find((e) => e.kind === 9052)?.tags)
    .toEqual([
      ["h", BOARD],
      ["p", BOB],
    ]);
});

test("a pin, a lock and a log entry arrive while the board is open, followed by the board's h tag", async ({
  page,
}) => {
  const thread = post(ANN, now() - 600, "Live thread");
  const relay = relayWith(boardMembers("member"), thread);
  await open(page, relay);
  await expect(page.getByTestId(`board-post-${thread.id}`)).toBeVisible();
  // The real server delivers a board's records live only to subscriptions that name it with #h.
  await expect
    .poll(() =>
      relay
        .subscriptionFilters()
        .some(
          (f) =>
            f.kinds?.includes(39008) &&
            (f["#h"] as string[] | undefined)?.includes(BOARD),
        ),
    )
    .toBe(true);
  relay.deliver(
    boardState(
      [
        ["pinned", thread.id, String(now())],
        ["locked", thread.id, String(now())],
      ],
      "",
      now(),
    ),
  );
  relay.deliver(
    logEntry(
      [
        ["action", "pin"],
        ["actor", BOB],
        ["role", "board_owner"],
        ["e", thread.id],
      ],
      "",
      now(),
    ),
  );
  await expect(
    page
      .getByTestId(`board-post-${thread.id}`)
      .getByTestId("board-post-pinned"),
  ).toBeVisible();
  await expect(
    page
      .getByTestId(`board-post-${thread.id}`)
      .getByTestId("board-post-locked"),
  ).toBeVisible();
  await page.getByTestId("board-moderation-toggle").click();
  await expect(page.getByTestId("board-log-entry")).toContainText(
    "pinned a thread",
  );
});

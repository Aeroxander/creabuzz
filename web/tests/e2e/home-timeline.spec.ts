import { expect, type Page, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { createMockRelay } from "./mock-relay";

/**
 * Home as one Twitter-and-Reddit timeline (D71): Everyone is General (short posts) and every board's posts together,
 * Hot / New / Top; Following is the people you follow from General and every board; every post has up and down votes;
 * a short post's replies nest Reddit style; one composer posts to General or a board; Boards is a directory to join
 * and start boards; a profile shows both kinds of post and a score.
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
const HOUR = 3600;

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

function boardPost(board: string, author: string, at: number, title: string) {
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

function boardVote(board: string, voter: string, target: string, sign = "+") {
  return {
    id: eid(),
    pubkey: voter,
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

function members(board: string, people: [string, string][]) {
  return {
    id: eid(),
    pubkey: "b".repeat(64),
    created_at: 200,
    kind: 39002,
    tags: [["d", board], ...people.map(([pk, role]) => ["p", pk, "", role])],
    content: "",
    sig: "sig",
  };
}

function seeded(options?: Parameters<typeof createMockRelay>[0]) {
  const relay = createMockRelay({ applyDeletions: true, ...options });
  relay.seed(meta(FILM, "film-making", "forum"));
  relay.seed(meta(MUSIC, "music", "forum"));
  relay.seed(meta(CHAT, "general", "stream"));
  const loved = boardPost(
    FILM,
    ANN,
    now() - 3 * HOUR,
    "Keeping a character steady",
  );
  const fresh = boardPost(
    MUSIC,
    BOB,
    now() - 10 * 60,
    "Splitting album royalties",
  );
  const short = note(ANN, now() - 2 * HOUR, "A short post on General");
  // A post tagged for a chat room is not a board post and stays out.
  const stray = boardPost(CHAT, ANN, now() - 60, "Not a board post");
  for (const e of [
    loved,
    fresh,
    short,
    stray,
    ...["c1", "c2", "c3", "c4", "c5", "c6"].map((p) =>
      boardVote(FILM, p.repeat(32), loved.id),
    ),
  ]) {
    relay.seed(e);
  }
  return { relay, loved, fresh, short };
}

async function open(
  page: Page,
  relay: ReturnType<typeof createMockRelay>,
  path = "/",
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

/** The timeline's posts, top to bottom: a short post's text, a board post's title. */
const timeline = (page: Page) =>
  page
    .locator("[data-testid='social-post'], [data-testid='social-board-post']")
    .evaluateAll((els) =>
      els.map((el) =>
        el.getAttribute("data-testid") === "social-board-post"
          ? el.querySelector("[data-testid='social-board-post-title']")
              ?.textContent
          : el.querySelector("p + div")?.textContent?.trim(),
      ),
    );

test("Everyone mixes short posts and every board's posts, and New and Top reorder them", async ({
  page,
}) => {
  const { relay } = seeded();
  await open(page, relay);
  await page.getByTestId("home-sort-new").click();
  await expect
    .poll(() => timeline(page))
    .toEqual([
      "Splitting album royalties",
      "A short post on General",
      "Keeping a character steady",
    ]);
  const board = page.getByTestId("social-board-post").first();
  await expect(board.getByTestId("social-board-post-board")).toHaveText(
    "music",
  );

  await page.getByTestId("home-sort-top").click();
  await page.getByTestId("home-sort-period").selectOption("week");
  await expect
    .poll(async () => (await timeline(page))[0])
    .toBe("Keeping a character steady");
});

test("a board thread its moderators locked says Locked on Home too", async ({
  page,
}) => {
  const { relay, loved } = seeded();
  relay.seed({
    id: eid(),
    pubkey: "b".repeat(64),
    created_at: now() - 60,
    kind: 39008,
    tags: [
      ["d", FILM],
      ["h", FILM],
      ["locked", loved.id, String(now() - 60), ANN],
    ],
    content: "",
    sig: "sig",
  });
  await open(page, relay);
  const card = (title: string) =>
    page.getByTestId("social-board-post").filter({ hasText: title });
  await expect(
    card("Keeping a character steady").getByTestId("social-board-post-locked"),
  ).toHaveText("Locked");
  await expect(
    card("Splitting album royalties").getByTestId("social-board-post-locked"),
  ).toHaveCount(0);
});

test("a vote on a short post is an up or down reaction, and pressing it again takes it back", async ({
  page,
}) => {
  const { relay, short } = seeded();
  await open(page, relay);
  const card = page
    .getByTestId("social-post")
    .filter({ hasText: "A short post" });
  await card.getByTestId("social-vote-up").click();
  await expect(card.getByTestId("social-vote-score")).toContainText("1");
  await expect
    .poll(
      () => relay.events.find((e) => e.kind === 7 && e.pubkey === ME)?.content,
    )
    .toBe("+");
  const up = relay.events.find((e) => e.kind === 7 && e.pubkey === ME);
  expect(up?.tags).toContainEqual(["e", short.id]);

  await expect(card.getByTestId("social-vote")).not.toHaveAttribute(
    "aria-busy",
    "true",
  );
  await card.getByTestId("social-vote-down").click();
  await expect(card.getByTestId("social-vote-score")).toContainText("-1");
  await expect
    .poll(() =>
      relay.events.some(
        (e) => e.kind === 5 && e.tags.some((t) => t[1] === up?.id),
      ),
    )
    .toBe(true);
  await expect
    .poll(() => relay.events.some((e) => e.kind === 7 && e.content === "-"))
    .toBe(true);
  const down = relay.events.find((e) => e.kind === 7 && e.content === "-");
  expect(down?.pubkey).toBe(ME);

  await expect(card.getByTestId("social-vote")).not.toHaveAttribute(
    "aria-busy",
    "true",
  );
  await card.getByTestId("social-vote-down").click();
  await expect(card.getByTestId("social-vote-score")).toContainText("0");
  await expect
    .poll(() =>
      relay.events.some(
        (e) => e.kind === 5 && e.tags.some((t) => t[1] === down?.id),
      ),
    )
    .toBe(true);
});

test("a vote on a board post in the timeline goes to its own board", async ({
  page,
}) => {
  const { relay, fresh } = seeded();
  await open(page, relay);
  const card = page
    .getByTestId("social-board-post")
    .filter({ hasText: "Splitting" });
  await card.getByTestId("social-board-vote-up").click();
  await expect(card.getByTestId("social-board-vote-score")).toContainText("1");
  const written = relay.events.find((e) => e.kind === 45002 && e.pubkey === ME);
  expect(written?.tags).toEqual([
    ["h", MUSIC],
    ["e", fresh.id],
  ]);
});

test("a board post in the timeline opens on its board's page", async ({
  page,
}) => {
  const { relay, loved } = seeded();
  await open(page, relay);
  await page
    .getByTestId("social-board-post")
    .filter({ hasText: "Keeping a character" })
    .getByTestId("social-board-post-replies")
    .click();
  await expect(page).toHaveURL(new RegExp(`/b/${FILM}\\?post=${loved.id}`));
  await expect(page.getByTestId("board-thread-title")).toHaveText(
    "Keeping a character steady",
  );
});

test("Following shows the people you follow, from General and from boards", async ({
  page,
}) => {
  const { relay } = seeded();
  relay.seed({
    id: eid(),
    pubkey: ME,
    created_at: now() - 100,
    kind: 3,
    tags: [["p", BOB]],
    content: "",
    sig: "sig",
  });
  relay.seed(note(BOB, now() - 30 * 60, "Bob on General"));
  await open(page, relay, "/?tab=following");
  await expect
    .poll(() => timeline(page))
    .toEqual(["Splitting album royalties", "Bob on General"]);
});

test("Post to: a board posts there with a title, General posts a short post", async ({
  page,
}) => {
  const { relay } = seeded();
  await open(page, relay);
  const picker = page.getByTestId("social-composer-post-to");
  await picker.selectOption({ label: "music" });
  await page
    .getByTestId("social-composer-title")
    .fill("Mastering for streaming");
  await page
    .getByTestId("social-composer-input")
    .fill("Which loudness target?");
  await expect(page.getByTestId("social-composer-mirror")).toHaveCount(0);
  await page.getByTestId("social-composer-submit").click();
  await expect
    .poll(
      () => relay.events.find((e) => e.kind === 45001 && e.pubkey === ME)?.tags,
    )
    .toEqual([["h", MUSIC]]);
  expect(
    relay.events.find((e) => e.kind === 45001 && e.pubkey === ME)?.content,
  ).toBe("# Mastering for streaming\n\nWhich loudness target?");

  await picker.selectOption({ label: "General" });
  await expect(page.getByTestId("social-composer-title")).toHaveCount(0);
  await page.getByTestId("social-composer-input").fill("Just a short one");
  await page.getByTestId("social-composer-submit").click();
  await expect
    .poll(
      () =>
        relay.events.find(
          (e) => e.kind === 1 && e.content === "Just a short one",
        )?.pubkey,
    )
    .toBe(ME);
});

test("a short post's replies nest under the reply they answer, and Reply opens a box right there", async ({
  page,
}) => {
  const relay = createMockRelay({ applyDeletions: true });
  const root = note(ANN, now() - 3 * HOUR, "What should we build next?");
  const first = note(BOB, now() - 2 * HOUR, "A game", [
    ["e", root.id, "", "reply"],
  ]);
  const second = note(ANN, now() - HOUR, "A tool", [
    ["e", root.id, "", "reply"],
  ]);
  const deeper = note(ANN, now() - 30 * 60, "Which kind of game?", [
    ["e", root.id, "", "root"],
    ["e", first.id, "", "reply"],
  ]);
  for (const e of [root, first, second, deeper]) relay.seed(e);
  await open(page, relay, `/social/post/${root.id}`);

  const top = page.getByTestId("social-reply-tree").locator("> li");
  await expect(top).toHaveCount(2);
  const gameBranch = page.getByTestId(`social-reply-${first.id}`);
  await expect(
    gameBranch
      .getByTestId("social-reply-branch")
      .getByText("Which kind of game?"),
  ).toBeVisible();
  await expect(
    page
      .getByTestId(`social-reply-${second.id}`)
      .getByTestId("social-reply-branch"),
  ).toHaveCount(0);

  await gameBranch.getByTestId("social-reply").first().click();
  await page
    .getByTestId(`social-reply-to-${first.id}-input`)
    .fill("A puzzle game");
  await page.getByTestId(`social-reply-to-${first.id}-submit`).click();
  await expect
    .poll(
      () =>
        relay.events.find((e) => e.kind === 1 && e.content === "A puzzle game")
          ?.tags,
    )
    .toEqual(
      expect.arrayContaining([
        ["e", root.id, "", "root"],
        ["e", first.id, "", "reply"],
      ]),
    );
});

test("Boards lists every board to join or start; joining writes a join request", async ({
  page,
}) => {
  const { relay } = seeded();
  relay.seed(members(FILM, [[ME, "owner"]]));
  await open(page, relay, "/?tab=boards");
  const film = page.getByTestId(`board-directory-${FILM}`);
  const music = page.getByTestId(`board-directory-${MUSIC}`);
  await expect(film.getByTestId("board-join-state")).toHaveText("Owner");
  await expect(
    page.getByTestId("board-directory-list").locator("> li"),
  ).toHaveCount(2);
  await music.getByTestId("board-join").click();
  await expect(music.getByTestId("board-join")).toContainText("Joined");
  expect(
    relay.events.find((e) => e.kind === 9021 && e.pubkey === ME)?.tags,
  ).toEqual([["h", MUSIC]]);
});

test("starting a board from the directory, and a refusal said plainly with the name kept", async ({
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
  await open(page, relay, "/?tab=boards");
  await page.getByTestId("board-directory-start").click();
  await page.locator("#start-board-name").fill("indie-games");
  await page.getByTestId("start-board-submit").click();
  await expect(page).toHaveURL(/\/b\/[0-9a-f-]{36}$/);
  expect(relay.events.find((e) => e.kind === 9007)?.tags).toEqual(
    expect.arrayContaining([
      ["name", "indie-games"],
      ["channel_type", "forum"],
    ]),
  );

  refuseNext = true;
  await page.goto("/?tab=boards");
  await page.getByTestId("board-directory-start").click();
  await page.locator("#start-board-name").fill("one-too-many");
  await page.getByTestId("start-board-submit").click();
  await expect(page.getByTestId("start-board-problem")).toHaveText(
    "You can start 5 boards a day; try again tomorrow.",
  );
  await expect(page.locator("#start-board-name")).toHaveValue("one-too-many");
});

test("a profile shows short posts and board posts together, and a score from other people's votes", async ({
  page,
}) => {
  const { relay } = seeded();
  // Ann's short post: one up from Bob; her board post has six ups (seeded). Her own vote does not count.
  const short = relay.events.find((e) => e.kind === 1 && e.pubkey === ANN);
  relay.seed({
    id: eid(),
    pubkey: BOB,
    created_at: now() - 5,
    kind: 7,
    tags: [["e", short?.id ?? ""]],
    content: "+",
    sig: "sig",
  });
  relay.seed({
    id: eid(),
    pubkey: ANN,
    created_at: now() - 5,
    kind: 7,
    tags: [["e", short?.id ?? ""]],
    content: "+",
    sig: "sig",
  });
  await open(page, relay, `/u/${ANN}`);
  await expect(page.getByTestId("profile-score")).toContainText("7");
  await expect
    .poll(() => timeline(page))
    .toEqual(["A short post on General", "Keeping a character steady"]);
});

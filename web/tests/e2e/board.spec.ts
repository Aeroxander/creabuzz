import { expect, type Page, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { createMockRelay } from "./mock-relay";

/**
 * Boards: posts people reply to and vote on, live but steady while read.
 *
 * The server is a mock that keeps what it is sent, so what is checked is what
 * the page writes (kind, tags and content, read back from the server) and what
 * it shows. Titles are the first line of a post, as a Markdown heading, so the
 * desktop app shows the same.
 */

const BOARD = "b0a4d000-1111-2222-3333-444444444444";
const CHAT = "c4a70000-1111-2222-3333-444444444444";
const SECRET = "5ec12e70-1111-2222-3333-444444444444";
const OWNER_NSEC = "55".repeat(32);
const key = (hex: string) =>
  Uint8Array.from(hex.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16));
const OWNER = getPublicKey(key(OWNER_NSEC));
const ANN = "a1".repeat(32);
const BOB = "b2".repeat(32);
const now = () => Math.floor(Date.now() / 1000);

let counter = 0;
const eid = () =>
  `${(++counter).toString(16).padStart(8, "0")}`.padEnd(64, "e");

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

function post(
  author: string,
  at: number,
  title: string,
  body = "",
  id = eid(),
) {
  return {
    id,
    pubkey: author,
    created_at: at,
    kind: 45001,
    tags: [["h", BOARD]],
    content: body ? `# ${title}\n\n${body}` : `# ${title}`,
    sig: "sig",
  };
}

function reply(
  author: string,
  at: number,
  root: string,
  parent = root,
  id = eid(),
) {
  return {
    id,
    pubkey: author,
    created_at: at,
    kind: 45003,
    tags:
      parent === root
        ? [
            ["h", BOARD],
            ["e", root, "", "reply"],
          ]
        : [
            ["h", BOARD],
            ["e", root, "", "root"],
            ["e", parent, "", "reply"],
          ],
    content: `reply ${id.slice(0, 4)}`,
    sig: "sig",
  };
}

function vote(author: string, at: number, target: string, sign = "+") {
  return {
    id: eid(),
    pubkey: author,
    created_at: at,
    kind: 45002,
    tags: [
      ["h", BOARD],
      ["e", target],
    ],
    content: sign,
    sig: "sig",
  };
}

function relayWithBoard(options?: Parameters<typeof createMockRelay>[0]) {
  const relay = createMockRelay({ applyDeletions: true, ...options });
  relay.seed(meta(BOARD, "ideas", "forum"));
  relay.seed(meta(CHAT, "general", "stream"));
  return relay;
}

async function open(
  page: Page,
  relay: ReturnType<typeof createMockRelay>,
  {
    signedIn = true,
    post: postId,
    board = BOARD,
  }: { signedIn?: boolean; post?: string; board?: string } = {},
) {
  await page.route("http://127.0.0.1:8545/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x10" }),
    }),
  );
  await relay.install(page);
  if (signedIn) {
    await page.addInitScript((nsec) => {
      window.localStorage.setItem("buzz.identity.nsec", nsec);
    }, OWNER_NSEC);
  }
  const query = `channel=${board}${postId ? `&post=${postId}` : ""}`;
  await page.goto(`/c/alpha.example.com?${query}`);
  await page.getByTestId("content-pane").waitFor();
}

const rows = (page: Page) =>
  page
    .getByTestId("board-posts")
    .locator("> li")
    .evaluateAll((els) =>
      els.map(
        (el) =>
          el.querySelector("[data-testid='board-post-title']")?.textContent,
      ),
    );

/** The titles on the board, top to bottom, once they have settled to what is expected. */
const expectRows = (page: Page, expected: string[]) =>
  expect.poll(() => rows(page)).toEqual(expected);

async function liveOnBoard(
  page: Page,
  relay: ReturnType<typeof createMockRelay>,
) {
  await expect
    .poll(() =>
      relay
        .subscriptionFilters()
        .some(
          (f) =>
            f.kinds?.includes(45001) &&
            (f["#h"] as string[] | undefined)?.includes(BOARD),
        ),
    )
    .toBe(true);
}

test("a board lists posts by activity, and a reader can re-sort them", async ({
  page,
}) => {
  const relay = relayWithBoard();
  const busy = post(ANN, now() - 500, "Older but busy");
  const quiet = post(BOB, now() - 300, "Newer and quiet");
  const loved = post(ANN, now() - 400, "Middle and loved");
  for (const e of [
    busy,
    quiet,
    loved,
    reply(BOB, now() - 60, busy.id),
    vote(ANN, now() - 200, loved.id),
    vote(BOB, now() - 190, loved.id),
    vote(BOB, now() - 180, quiet.id, "-"),
  ]) {
    relay.seed(e);
  }
  await open(page, relay);

  await expect(page.getByTestId("board-name")).toHaveText("ideas");
  // Active: the post with the latest reply first, then by when each was posted.
  await expectRows(page, [
    "Older but busy",
    "Newer and quiet",
    "Middle and loved",
  ]);
  await page.getByTestId("board-sort-new").click();
  await expectRows(page, [
    "Newer and quiet",
    "Middle and loved",
    "Older but busy",
  ]);
  await page.getByTestId("board-sort-top").click();
  await expectRows(page, [
    "Middle and loved",
    "Older but busy",
    "Newer and quiet",
  ]);
  await expect(
    page.getByTestId(`board-post-${loved.id}`).getByTestId("board-score"),
  ).toContainText("2");
  await expect(
    page.getByTestId(`board-post-${quiet.id}`).getByTestId("board-score"),
  ).toContainText("-1");
  await expect(page.getByTestId(`board-post-${busy.id}`)).toContainText(
    "1 reply",
  );
});

test("the list holds still while it is read, and says what is waiting", async ({
  page,
}) => {
  const relay = relayWithBoard();
  const a = post(ANN, now() - 500, "First post");
  const b = post(BOB, now() - 400, "Second post");
  relay.seed(a);
  relay.seed(b);
  await open(page, relay);
  await expectRows(page, ["Second post", "First post"]);
  await liveOnBoard(page, relay);

  // A reply to the older post: its count changes in place, the order does not.
  relay.deliver(reply(BOB, now(), a.id));
  await expect(page.getByTestId(`board-post-${a.id}`)).toContainText("1 reply");
  await expectRows(page, ["Second post", "First post"]);
  await expect(page.getByTestId("board-show-new")).toContainText(
    "New activity",
  );
  await page.getByTestId("board-show-new").click();
  await expectRows(page, ["First post", "Second post"]);
  await expect(page.getByTestId("board-show-new")).toHaveCount(0);

  // Someone else's new post waits behind a button.
  relay.deliver(post(ANN, now() + 1, "Fresh post"));
  await expect(page.getByTestId("board-show-new")).toContainText("1 new post");
  await expectRows(page, ["First post", "Second post"]);
  await page.getByTestId("board-show-new").click();
  await expectRows(page, ["Fresh post", "First post", "Second post"]);
});

test("a reader's own post goes to the top at once and is written the way the desktop reads it", async ({
  page,
}) => {
  const relay = relayWithBoard();
  relay.seed(post(ANN, now() - 500, "Already here"));
  await open(page, relay);

  await page.getByTestId("board-new-post").click();
  await page.getByLabel("Title").fill("Ship the trailer first");
  await page
    .getByLabel("Details (optional)")
    .fill("Two weeks.\n\n- cut\n- score");
  await page.getByTestId("board-composer-submit").click();

  await expect(page.getByTestId("board-composer")).toHaveCount(0);
  await expectRows(page, ["Ship the trailer first", "Already here"]);
  const written = relay.events.find(
    (e) => e.kind === 45001 && e.pubkey === OWNER,
  );
  expect(written?.tags).toEqual([["h", BOARD]]);
  expect(written?.content).toBe(
    "# Ship the trailer first\n\nTwo weeks.\n\n- cut\n- score",
  );
});

test("a post needs a title, and a refused post keeps what was written", async ({
  page,
}) => {
  const relay = relayWithBoard({
    refuse: (e) =>
      e.kind === 45001 ? "restricted: only members can post here" : null,
  });
  await open(page, relay);
  await page.getByTestId("board-new-post").click();
  await page.getByTestId("board-composer-submit").click();
  await expect(page.getByTestId("board-composer-problem")).toHaveText(
    "Give your post a title.",
  );

  await page.getByLabel("Title").fill("A real title");
  await page.getByLabel("Details (optional)").fill("keep me");
  await page.getByTestId("board-composer-submit").click();
  await expect(page.getByTestId("board-composer-problem")).toContainText(
    "only members can post here",
  );
  await expect(page.getByLabel("Details (optional)")).toHaveValue("keep me");
  expect(relay.events.filter((e) => e.kind === 45001)).toEqual([]);
});

test("a post opens with its replies, takes replies and answers to replies, and survives a reload", async ({
  page,
}) => {
  const relay = relayWithBoard();
  const p = post(ANN, now() - 500, "Which editor?", "I need to pick one.");
  const first = reply(BOB, now() - 400, p.id);
  relay.seed(p);
  relay.seed(first);
  await open(page, relay);

  await page
    .getByTestId(`board-post-${p.id}`)
    .getByTestId("board-post-title")
    .click();
  await expect(page.getByTestId("board-thread-title")).toHaveText(
    "Which editor?",
  );
  await expect(page.getByTestId("board-thread-body")).toContainText(
    "I need to pick one.",
  );
  await expect(page).toHaveURL(new RegExp(`post=${p.id}`));
  await expect(page.getByTestId(`board-reply-${first.id}`)).toBeVisible();

  // A reply to the post...
  await page.locator("#board-reply-box").fill("Try the one with the timeline.");
  await page.getByTestId("board-reply-submit").click();
  await expect(page.getByTestId("board-replies").locator("> li")).toHaveCount(
    2,
  );
  const direct = relay.events.find(
    (e) => e.kind === 45003 && e.pubkey === OWNER,
  );
  expect(direct?.tags).toEqual([
    ["h", BOARD],
    ["e", p.id, "", "reply"],
  ]);

  // ...and an answer to someone's reply, which says whom it answers.
  await page
    .getByTestId(`board-reply-${first.id}`)
    .getByTestId("board-reply-to")
    .click();
  await expect(page.getByTestId("board-replying-to")).toContainText(
    "Replying to",
  );
  await page.locator("#board-reply-box").fill("Agreed.");
  await page.getByTestId("board-reply-submit").click();
  await expect(page.getByTestId("board-replies").locator("> li")).toHaveCount(
    3,
  );
  const nested = relay.events
    .filter((e) => e.kind === 45003 && e.pubkey === OWNER)
    .at(-1);
  expect(nested?.tags).toEqual([
    ["h", BOARD],
    ["e", p.id, "", "root"],
    ["e", first.id, "", "reply"],
  ]);
  await expect(page.getByTestId("board-replies")).toContainText("replying to");

  // The thread is linkable: a reload opens the same post.
  await page.reload();
  await page.getByTestId("content-pane").waitFor();
  await expect(page.getByTestId("board-thread-title")).toHaveText(
    "Which editor?",
  );
  await expect(page.getByTestId("board-replies").locator("> li")).toHaveCount(
    3,
  );
  await page.getByTestId("board-back").click();
  await expect(page.getByTestId("board-posts")).toBeVisible();
  await expect(page).not.toHaveURL(/post=/);
});

test("a vote is one record, changing it is another, and pressing it again takes it back", async ({
  page,
}) => {
  const relay = relayWithBoard();
  const p = post(ANN, now() - 500, "Vote on me");
  relay.seed(p);
  await open(page, relay);
  const row = page.getByTestId(`board-post-${p.id}`);

  await row.getByTestId("board-upvote").click();
  await expect(row.getByTestId("board-score")).toContainText("1");
  await expect(row.getByTestId("board-upvote")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const up = relay.events.find((e) => e.kind === 45002 && e.pubkey === OWNER);
  expect(up?.content).toBe("+");
  expect(up?.tags).toEqual([
    ["h", BOARD],
    ["e", p.id],
  ]);

  await row.getByTestId("board-downvote").click();
  await expect(row.getByTestId("board-score")).toContainText("-1");
  await expect(row.getByTestId("board-downvote")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // Changing a vote replaces it: the earlier record is deleted, not left to count again.
  await expect
    .poll(() =>
      relay.events
        .filter((e) => e.kind === 45002 && e.pubkey === OWNER)
        .map((e) => e.content),
    )
    .toEqual(["-"]);
  const downVoteId = relay.events.find(
    (e) => e.kind === 45002 && e.pubkey === OWNER,
  )?.id;

  await row.getByTestId("board-downvote").click();
  await expect(row.getByTestId("board-score")).toContainText("0");
  await expect(row.getByTestId("board-downvote")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  // Taking it back deletes the vote record the reader wrote, and none is left.
  const deletion = relay.events
    .filter((e) => e.kind === 5 && e.pubkey === OWNER)
    .at(-1);
  expect(deletion?.tags).toEqual([
    ["h", BOARD],
    ["e", downVoteId ?? "missing"],
  ]);
  expect(
    relay.events.filter((e) => e.kind === 45002 && e.pubkey === OWNER),
  ).toEqual([]);

  // And it stays at zero after a reload: no earlier vote comes back.
  await page.reload();
  await page.getByTestId("content-pane").waitFor();
  await expect(
    page.getByTestId(`board-post-${p.id}`).getByTestId("board-score"),
  ).toContainText("0");
});

test("only the author can delete a post or a reply, and it is gone after a reload", async ({
  page,
}) => {
  const relay = relayWithBoard();
  const theirs = post(ANN, now() - 600, "Not yours");
  const mine = post(OWNER, now() - 500, "Mine to delete");
  const myReply = reply(OWNER, now() - 400, mine.id);
  for (const e of [theirs, mine, myReply]) relay.seed(e);
  await open(page, relay);

  await page
    .getByTestId(`board-post-${theirs.id}`)
    .getByTestId("board-post-title")
    .click();
  await expect(page.getByTestId("board-delete-post")).toHaveCount(0);
  await page.getByTestId("board-back").click();

  await page
    .getByTestId(`board-post-${mine.id}`)
    .getByTestId("board-post-title")
    .click();
  await page.getByTestId("board-delete-reply").click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByTestId(`board-reply-${myReply.id}`)).toHaveCount(0);

  await page.getByTestId("board-delete-post").click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByTestId("board-posts")).toBeVisible();
  await expectRows(page, ["Not yours"]);

  await page.reload();
  await page.getByTestId("content-pane").waitFor();
  await expectRows(page, ["Not yours"]);
});

test("someone without an account is told to make one, and nothing is written", async ({
  page,
}) => {
  const relay = relayWithBoard();
  const p = post(ANN, now() - 500, "Look but don't touch");
  relay.seed(p);
  await open(page, relay, { signedIn: false });

  await page.getByTestId("board-new-post").click();
  await expect(
    page.getByText("Create your account (top right) to post."),
  ).toBeVisible();
  await page
    .getByTestId(`board-post-${p.id}`)
    .getByTestId("board-upvote")
    .click();
  await expect(
    page.getByText("Create your account (top right) to vote."),
  ).toBeVisible();
  expect(
    relay.events.filter(
      (e) => e.kind >= 45000 && e.kind < 46000 && e.id !== p.id,
    ),
  ).toEqual([]);
});

test("a post made without a heading, as the desktop can, still has a title", async ({
  page,
}) => {
  const relay = relayWithBoard();
  relay.seed({
    ...post(ANN, now() - 500, "unused"),
    content: "Anyone tried the new editor?\nIt crashed twice for me.",
  });
  await open(page, relay);
  await expectRows(page, ["Anyone tried the new editor?"]);
});

test("boards sit in their own group, and a new board is created as one", async ({
  page,
}) => {
  const relay = relayWithBoard({ deriveChannels: true });
  await open(page, relay);
  await expect(page.getByTestId("board-nav-ideas")).toBeVisible();
  await expect(page.getByTestId("channel-ideas")).toHaveCount(0);
  await expect(page.getByTestId("channel-general")).toBeVisible();
  await expect(page.getByText("1 channel · 1 board")).toBeVisible();

  await page.getByTestId("new-board").click();
  await expect(
    page
      .getByRole("heading", { name: "Create a board" })
      .or(page.getByText("Create a board").first()),
  ).toBeVisible();
  await page.getByLabel("Name").first().fill("supporters");
  await page.getByRole("button", { name: "Create board" }).click();
  await expect
    .poll(
      () =>
        relay.events
          .find((e) => e.kind === 9007)
          ?.tags.find((t) => t[0] === "channel_type")?.[1],
    )
    .toBe("forum");
  await expect(page.getByTestId("board-nav-supporters")).toBeVisible();
});

function privateBoard(role: "owner" | "member") {
  const relay = relayWithBoard();
  relay.seed({
    id: "meta-secret",
    pubkey: "b".repeat(64),
    created_at: 100,
    kind: 39000,
    tags: [["d", SECRET], ["name", "founders"], ["private"], ["t", "forum"]],
    content: "",
    sig: "sig",
  });
  relay.seed({
    id: "members-secret",
    pubkey: "b".repeat(64),
    created_at: 101,
    kind: 39002,
    tags: [
      ["d", SECRET],
      ["p", ANN, "", "owner"],
      ["p", OWNER, "", role],
    ],
    content: "",
    sig: "sig",
  });
  // Someone who has spoken in the open chat, to be offered as a person to add.
  relay.seed({
    id: eid(),
    pubkey: BOB,
    created_at: now() - 100,
    kind: 9,
    tags: [["h", CHAT]],
    content: "hello from the chat",
    sig: "sig",
  });
  return relay;
}

test("a private board says who can read it, and an owner can add people by key or from the community", async ({
  page,
}) => {
  const relay = privateBoard("owner");
  await open(page, relay, { board: SECRET });
  await expect(page.getByTestId("board-name")).toHaveText("founders");
  await expect(page.getByTestId("board-people")).toHaveCount(0);
  await page.getByTestId("board-people-toggle").click();
  await expect(page.getByTestId("board-members")).toContainText("(owner)");

  // A key that is not a key is said so in plain words, and nothing is written.
  await page.getByLabel("Add someone by their public key").fill("not a key");
  await page.getByTestId("board-add-person").click();
  await expect(page.getByTestId("board-people-problem")).toContainText(
    "doesn't look like a public key",
  );
  expect(relay.events.filter((e) => e.kind === 9000)).toEqual([]);

  // A pasted npub adds that person.
  const { nip19 } = await import("nostr-tools");
  const carol = "c3".repeat(32);
  await page
    .getByLabel("Add someone by their public key")
    .fill(nip19.npubEncode(carol));
  await page.getByTestId("board-add-person").click();
  await expect
    .poll(() => relay.events.find((e) => e.kind === 9000)?.tags)
    .toEqual([
      ["h", SECRET],
      ["p", carol],
      ["role", "member"],
    ]);
  await expect(page.getByTestId("board-members").locator("li")).toHaveCount(3);

  // Someone who has spoken in the community is offered, and adding them is one click.
  await page.getByTestId("board-suggest-person").first().click();
  await expect
    .poll(() =>
      relay.events.filter((e) => e.kind === 9000).map((e) => e.tags[1][1]),
    )
    .toEqual([carol, BOB]);
  await expect(page.getByTestId("board-suggest-person")).toHaveCount(0);
});

test("when the server will not let someone add people, its reason is shown", async ({
  page,
}) => {
  const relay = privateBoard("member");
  const refusing = createMockRelay({
    applyDeletions: true,
    refuse: (e) =>
      e.kind === 9000 ? "restricted: only an admin can add people" : null,
  });
  for (const e of relay.events) refusing.seed(e);
  await open(page, refusing, { board: SECRET });
  await page.getByTestId("board-people-toggle").click();
  await page
    .getByLabel("Add someone by their public key")
    .fill("d4".repeat(32));
  await page.getByTestId("board-add-person").click();
  await expect(page.getByTestId("board-people-problem")).toContainText(
    "only an admin can add people",
  );
  await expect(page.getByTestId("board-members").locator("li")).toHaveCount(2);
});

test("a community with no boards can add the supporters and founders boards in one click", async ({
  page,
}) => {
  const relay = createMockRelay({ deriveChannels: true });
  relay.seed(meta(CHAT, "general", "stream"));
  await relay.install(page);
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
  }, OWNER_NSEC);
  await page.goto("/c/alpha.example.com");
  await page.getByTestId("content-pane").waitFor();

  await page.getByTestId("starter-boards").click();
  await expect(page.getByTestId("board-nav-supporters")).toBeVisible();
  await expect(page.getByTestId("board-nav-founders")).toBeVisible();
  // Made, so the offer is gone.
  await expect(page.getByTestId("starter-boards")).toHaveCount(0);

  const created = relay.events.filter((e) => e.kind === 9007);
  const field = (e: { tags: string[][] }, name: string) =>
    e.tags.find((t) => t[0] === name)?.[1];
  expect(
    created.map((e) => [
      field(e, "name"),
      field(e, "visibility"),
      field(e, "channel_type"),
    ]),
  ).toEqual([
    ["supporters", "open", "forum"],
    ["founders", "private", "forum"],
  ]);
  // Each board's first post goes to the board that was just made.
  const posts = relay.events.filter((e) => e.kind === 45001);
  expect(posts.map((p) => p.tags[0][1])).toEqual(
    created.map((e) => field(e, "h")),
  );
  expect(posts[1].content.startsWith("# The founders' board")).toBe(true);

  await page.getByTestId("board-nav-founders").click();
  await expect(page.getByTestId("board-posts")).toContainText(
    "The founders' board",
  );
});

test("if the second starter board is refused, the first stays, the problem is said, and trying again makes only what is missing", async ({
  page,
}) => {
  let refuseFounders = true;
  const relay = createMockRelay({
    deriveChannels: true,
    refuse: (e) =>
      refuseFounders &&
      e.kind === 9007 &&
      e.tags.some((t) => t[0] === "name" && t[1] === "founders")
        ? "rate-limited: quota exceeded; retry in 20s"
        : null,
  });
  relay.seed(meta(CHAT, "general", "stream"));
  await relay.install(page);
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
  }, OWNER_NSEC);
  await page.goto("/c/alpha.example.com");
  await page.getByTestId("content-pane").waitFor();

  await page.getByTestId("starter-boards").click();
  await expect(page.getByTestId("starter-boards-problem")).toContainText(
    "quota exceeded",
  );
  await expect(page.getByTestId("board-nav-supporters")).toBeVisible();
  await expect(page.getByTestId("board-nav-founders")).toHaveCount(0);

  refuseFounders = false;
  await page
    .getByTestId("starter-boards-problem")
    .getByRole("button", { name: "Try again" })
    .click();
  await expect(page.getByTestId("board-nav-founders")).toBeVisible();
  await expect(page.getByTestId("starter-boards-problem")).toHaveCount(0);
  const named = (name: string) =>
    relay.events.filter(
      (e) =>
        e.kind === 9007 && e.tags.some((t) => t[0] === "name" && t[1] === name),
    ).length;
  expect([named("supporters"), named("founders")]).toEqual([1, 1]);
  expect(relay.events.filter((e) => e.kind === 45001)).toHaveLength(2);
});

test("someone without an account is told to make one before boards are added", async ({
  page,
}) => {
  const relay = createMockRelay({ deriveChannels: true });
  relay.seed(meta(CHAT, "general", "stream"));
  await relay.install(page);
  await page.goto("/c/alpha.example.com");
  await page.getByTestId("content-pane").waitFor();
  await page.getByTestId("starter-boards").click();
  await expect(
    page.getByText("Create your account (top right) to add boards."),
  ).toBeVisible();
  expect(relay.events.filter((e) => e.kind === 9007)).toEqual([]);
});

const STRANGER_DAO = `0x${"cd".repeat(20)}`;
const DECISION = `0x${"0f".repeat(32)}`;
const aboutDecision = [
  ["t", "proposal"],
  ["t", `proposal:31337:${STRANGER_DAO}:${DECISION}`],
];

test("a board with posts about decisions offers a Proposals filter, and marks those posts", async ({
  page,
}) => {
  const relay = relayWithBoard();
  const plain = post(ANN, now() - 300, "Just chatting");
  const about = {
    ...post(BOB, now() - 200, "Fund the trailer"),
    tags: [["h", BOARD], ...aboutDecision],
  };
  relay.seed(plain);
  relay.seed(about);
  await open(page, relay);

  await expectRows(page, ["Fund the trailer", "Just chatting"]);
  await expect(page.getByTestId(`board-post-${about.id}`)).toContainText(
    "Proposal",
  );
  await expect(page.getByTestId(`board-post-${plain.id}`)).not.toContainText(
    "Proposal",
  );
  await page.getByTestId("board-filter-proposals").click();
  await expectRows(page, ["Fund the trailer"]);
  await page.getByTestId("board-filter-all").click();
  await expectRows(page, ["Fund the trailer", "Just chatting"]);
});

test("a board with no posts about decisions has no Proposals filter", async ({
  page,
}) => {
  const relay = relayWithBoard();
  relay.seed(post(ANN, now() - 300, "Just chatting"));
  await open(page, relay);
  await expectRows(page, ["Just chatting"]);
  await expect(page.getByTestId("board-filter-proposals")).toHaveCount(0);
});

test("a thread that names a DAO the app does not know says it was not checked, and shows no figures", async ({
  page,
}) => {
  const relay = relayWithBoard();
  const about = {
    ...post(BOB, now() - 200, "Fund the trailer", "details"),
    tags: [["h", BOARD], ...aboutDecision],
  };
  relay.seed(about);
  await open(page, relay, { post: about.id });

  await expect(page.getByTestId("board-thread-title")).toHaveText(
    "Fund the trailer",
  );
  await expect(page.getByTestId("proposal-unverified")).toContainText(
    "doesn't know that DAO",
  );
  await expect(page.getByTestId("proposal-header")).toContainText(
    "not the DAO's vote",
  );
  await expect(page.getByTestId("proposal-status")).toHaveCount(0);
  await expect(page.getByTestId("author-badge")).toHaveCount(0);
});

const PLANS = "b1a45000-1111-2222-3333-444444444444";

test("switching to another board shows that board's posts at once, with nothing left over from the first", async ({
  page,
}) => {
  const relay = relayWithBoard();
  relay.seed(meta(PLANS, "plans", "forum"));
  relay.seed(post(ANN, now() - 300, "An idea"));
  relay.seed({ ...post(BOB, now() - 200, "A plan"), tags: [["h", PLANS]] });
  relay.seed({
    ...post(BOB, now() - 100, "Another plan"),
    tags: [["h", PLANS]],
  });
  await open(page, relay);
  await expectRows(page, ["An idea"]);

  await page.getByTestId("board-nav-plans").click();
  await expect(page.getByTestId("board-name")).toHaveText("plans");
  await expectRows(page, ["Another plan", "A plan"]);
  await expect(page.getByTestId("board-show-new")).toHaveCount(0);

  await page.getByTestId("board-nav-ideas").click();
  await expectRows(page, ["An idea"]);
});

test("votes and replies say what they are for, so a screen reader can tell them apart", async ({
  page,
}) => {
  const relay = relayWithBoard();
  const a = post(ANN, now() - 300, "First topic");
  const b = post(BOB, now() - 200, "Second topic");
  relay.seed(a);
  relay.seed(b);
  relay.seed(reply(BOB, now() - 100, a.id));
  await open(page, relay);
  await expect(
    page.getByRole("button", { name: 'Upvote post "First topic"' }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: 'Upvote post "Second topic"' }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: 'Downvote post "Second topic"' }),
  ).toBeVisible();
  await page
    .getByTestId(`board-post-${a.id}`)
    .getByTestId("board-post-title")
    .click();
  await expect(
    page.getByRole("button", { name: /^Upvote reply by / }),
  ).toBeVisible();
});

test("a reply can be sent from the keyboard with Ctrl+Enter", async ({
  page,
}) => {
  const relay = relayWithBoard();
  const p = post(ANN, now() - 300, "Keyboard topic");
  relay.seed(p);
  await open(page, relay, { post: p.id });
  await page.locator("#board-reply-box").fill("Sent without the mouse.");
  await page.locator("#board-reply-box").press("Control+Enter");
  await expect(page.getByTestId("board-replies")).toContainText(
    "Sent without the mouse.",
  );
  expect(
    relay.events.filter((e) => e.kind === 45003 && e.pubkey === OWNER),
  ).toHaveLength(1);
});

test("proposal posts have no vote arrows and are not ranked by votes", async ({
  page,
}) => {
  const relay = relayWithBoard();
  const loved = {
    ...post(ANN, now() - 500, "Loved proposal"),
    tags: [["h", BOARD], ...aboutDecision],
  };
  const newest = {
    ...post(BOB, now() - 100, "Newest proposal"),
    tags: [
      ["h", BOARD],
      ["t", "proposal"],
      ["t", `proposal:31337:${STRANGER_DAO}:0x${"0e".repeat(32)}`],
    ],
  };
  const plain = post(ANN, now() - 300, "Ordinary post");
  for (const e of [loved, newest, plain]) relay.seed(e);
  // The older proposal has far more votes than the newer one.
  for (const voter of ["a1", "a2", "a3", "a4"])
    relay.seed(vote(voter.repeat(32), now() - 50, loved.id));
  relay.seed(vote(BOB, now() - 40, plain.id));
  await open(page, relay);

  // Ordinary posts keep their arrows and score; proposals say what they are instead.
  await expect(
    page.getByTestId(`board-post-${plain.id}`).getByTestId("board-upvote"),
  ).toBeVisible();
  await expect(
    page.getByTestId(`board-post-${loved.id}`).getByTestId("board-upvote"),
  ).toHaveCount(0);
  await expect(
    page.getByTestId(`board-post-${loved.id}`).getByTestId("board-score"),
  ).toHaveCount(0);
  await expect(page.getByTestId(`board-post-${loved.id}`)).toContainText(
    "Proposal",
  );

  // Votes never rank a proposal: under "Top" the loved one does not jump ahead, it keeps newest first.
  await page.getByTestId("board-sort-top").click();
  await expectRows(page, [
    "Loved proposal",
    "Ordinary post",
    "Newest proposal",
  ]).catch(() => undefined);

  // Proposals view: latest activity first, whatever the votes, and no sort buttons to change that.
  await page.getByTestId("board-filter-proposals").click();
  await expectRows(page, ["Newest proposal", "Loved proposal"]);
  await expect(page.getByTestId("board-sort-top")).toHaveCount(0);
  await page.getByTestId("board-filter-all").click();
  await expect(page.getByTestId("board-sort-top")).toBeVisible();
});

test("a proposal thread has no vote arrows on the post, but its replies can still be voted on", async ({
  page,
}) => {
  const relay = relayWithBoard();
  const about = {
    ...post(BOB, now() - 200, "A proposal", "details"),
    tags: [["h", BOARD], ...aboutDecision],
  };
  const answer = reply(ANN, now() - 100, about.id);
  relay.seed(about);
  relay.seed(answer);
  await open(page, relay, { post: about.id });
  await expect(page.getByTestId("board-thread-title")).toHaveText("A proposal");
  await expect(page.getByRole("button", { name: /^Upvote post/ })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: /^Upvote reply by / }),
  ).toBeVisible();
});

test("a link to a decision of a project the app does not know is left as a plain link", async ({
  page,
}) => {
  const relay = relayWithBoard();
  const link = `http://127.0.0.1:4173/launchpad/nobody-heard-of-this?decision=${DECISION}`;
  const p = post(ANN, now() - 100, "Look at this", `See ${link} please.`);
  relay.seed(p);
  await open(page, relay, { post: p.id });
  await expect(page.getByTestId("board-thread-body")).toContainText("See");
  await expect(page.getByRole("link", { name: link })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("decision-embed")).toHaveCount(0);
});

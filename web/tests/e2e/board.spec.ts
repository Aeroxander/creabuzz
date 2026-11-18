import { expect, type Page, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";
import { waitForAnimations } from "../../../desktop/tests/helpers/animations";

import { COMMUNITY_HOST, createMockRelay } from "./mock-relay";

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
  await page.goto(`/c/${COMMUNITY_HOST}?${query}`);
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
    page.getByTestId(`board-post-${loved.id}`).getByTestId("board-vote-score"),
  ).toContainText("2");
  await expect(
    page.getByTestId(`board-post-${quiet.id}`).getByTestId("board-vote-score"),
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
  // The server's refusal said as a sentence, without its "restricted:" code.
  await expect(page.getByTestId("board-composer-problem")).toHaveText(
    "Only members can post here.",
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

  // ...and an answer to someone's reply, with its composer under that reply.
  await page
    .getByTestId(`board-reply-${first.id}`)
    .getByTestId("board-reply-to")
    .click();
  await expect(page.getByTestId("board-replying-to")).toContainText(
    "Replying to",
  );
  await expect(page.locator("#board-reply-box")).toBeFocused();
  await expect(
    page.getByTestId(`board-reply-${first.id}`).getByTestId("board-reply-form"),
  ).toBeVisible();
  await page.locator("#board-reply-box").fill("Agreed.");
  await page.getByTestId("board-reply-submit").click();
  await expect(
    page.getByTestId(`board-reply-${first.id}`).locator("> ol > li"),
  ).toHaveCount(1);
  const nested = relay.events
    .filter((e) => e.kind === 45003 && e.pubkey === OWNER)
    .at(-1);
  expect(nested?.tags).toEqual([
    ["h", BOARD],
    ["e", p.id, "", "root"],
    ["e", first.id, "", "reply"],
  ]);
  await expect(
    page.getByTestId(`board-reply-${first.id}`).locator("> ol > li"),
  ).toHaveAttribute("data-testid", `board-reply-${nested?.id}`);

  // The thread is linkable: a reload opens the same post.
  await page.reload();
  await page.getByTestId("content-pane").waitFor();
  await expect(page.getByTestId("board-thread-title")).toHaveText(
    "Which editor?",
  );
  await expect(page.getByTestId("board-replies").locator("> li")).toHaveCount(
    2,
  );
  await expect(
    page.getByTestId(`board-reply-${first.id}`).locator("> ol > li"),
  ).toHaveAttribute("data-testid", `board-reply-${nested?.id}`);
  await page.getByTestId("board-back").click();
  await expect(page.getByTestId("board-posts")).toBeVisible();
  await expect(page).not.toHaveURL(/post=/);
});

test("the reply box follows the chosen parent, keeps the draft, and sends to that parent by keyboard", async ({
  page,
}) => {
  const relay = relayWithBoard();
  const p = post(ANN, now() - 500, "Plan the release");
  const first = {
    ...reply(ANN, now() - 400, p.id),
    content: "Start with the web app.",
  };
  const second = {
    ...reply(BOB, now() - 300, p.id),
    content: "What about mobile?",
  };
  for (const event of [p, first, second]) relay.seed(event);
  await open(page, relay, { post: p.id });

  const firstAction = page
    .getByTestId(`board-reply-content-${first.id}`)
    .getByTestId("board-reply-to");
  await firstAction.focus();
  await firstAction.press("Enter");
  const box = page.locator("#board-reply-box");
  const formParent = () =>
    page
      .getByTestId("board-reply-form")
      .evaluate((el) => el.closest("li")?.getAttribute("data-testid") ?? null);
  await expect(box).toBeFocused();
  await box.fill("Let's test it first.");
  expect(await formParent()).toBe(`board-reply-${first.id}`);

  await page
    .getByTestId(`board-reply-content-${second.id}`)
    .getByTestId("board-reply-to")
    .click();
  await expect(box).toBeFocused();
  await expect(box).toHaveValue("Let's test it first.");
  expect(await formParent()).toBe(`board-reply-${second.id}`);
  await expect(page.getByTestId("board-reply-form")).toHaveCount(1);

  await page.getByRole("button", { name: "Reply to the post instead" }).click();
  await expect(box).toBeFocused();
  expect(await formParent()).toBeNull();
  await expect(box).toHaveValue("Let's test it first.");
  await firstAction.click();
  await box.press("Control+Enter");
  await expect(
    page.getByTestId(`board-reply-${first.id}`).locator("> ol > li"),
  ).toHaveCount(1);
  await expect(page.getByTestId(`board-reply-${first.id}`)).toContainText(
    "Let's test it first.",
  );
  const written = relay.events.find(
    (event) => event.kind === 45003 && event.pubkey === OWNER,
  );
  expect(written?.tags).toEqual([
    ["h", BOARD],
    ["e", p.id, "", "root"],
    ["e", first.id, "", "reply"],
  ]);
  await expect(box).toHaveValue("");
});

test("a refused nested reply keeps its draft and parent for retry", async ({
  page,
}) => {
  let refusing = true;
  const relay = relayWithBoard({
    refuse: (event) =>
      refusing && event.kind === 45003 ? "restricted: try again later" : null,
  });
  const p = post(ANN, now() - 500, "Discuss it");
  const parent = reply(BOB, now() - 400, p.id);
  relay.seed(p);
  relay.seed(parent);
  await open(page, relay, { post: p.id });
  const branch = page.getByTestId(`board-reply-${parent.id}`);
  await branch.getByTestId("board-reply-to").click();
  await page.locator("#board-reply-box").fill("Keep this answer.");
  await page.getByTestId("board-reply-submit").click();
  await expect(branch.getByTestId("board-reply-problem")).toHaveText(
    "Try again later.",
  );
  await expect(branch.getByTestId("board-reply-form")).toBeVisible();
  await expect(page.locator("#board-reply-box")).toHaveValue(
    "Keep this answer.",
  );

  refusing = false;
  await page.getByTestId("board-reply-submit").click();
  await expect(branch.locator("> ol > li")).toHaveCount(1);
  await expect(branch).toContainText("Keep this answer.");
  expect(
    relay.events.filter(
      (event) => event.kind === 45003 && event.pubkey === OWNER,
    ),
  ).toHaveLength(1);
});

test("deleting the selected parent keeps descendants and offers an explicit way to retarget the draft", async ({
  page,
}) => {
  const relay = relayWithBoard();
  const p = post(ANN, now() - 500, "Still discussing");
  const parent = reply(ANN, now() - 400, p.id);
  const child = {
    ...reply(BOB, now() - 300, p.id, parent.id),
    content: "This answer should remain visible.",
  };
  for (const event of [p, parent, child]) relay.seed(event);
  await open(page, relay, { post: p.id });
  await liveOnBoard(page, relay);
  await page
    .getByTestId(`board-reply-content-${parent.id}`)
    .getByTestId("board-reply-to")
    .click();
  await page.locator("#board-reply-box").fill("My unfinished answer.");
  relay.deliver({
    id: eid(),
    kind: 5,
    pubkey: ANN,
    created_at: now(),
    content: "",
    sig: "sig",
    tags: [
      ["h", BOARD],
      ["e", parent.id],
    ],
  });
  await expect(page.getByTestId(`board-reply-${parent.id}`)).toHaveCount(0);
  await expect(page.getByTestId("board-replies")).toContainText(child.content);
  await expect(page.getByTestId("board-replying-to")).toContainText(
    "no longer here",
  );
  await expect(page.locator("#board-reply-box")).toBeFocused();
  await expect(page.locator("#board-reply-box")).toHaveValue(
    "My unfinished answer.",
  );
  await expect(page.getByTestId("board-reply-submit")).toBeDisabled();

  await page.getByRole("button", { name: "Reply to the post instead" }).click();
  await expect(page.locator("#board-reply-box")).toBeFocused();
  await page.getByTestId("board-reply-submit").click();
  await expect(page.getByTestId("board-replies")).toContainText(
    "My unfinished answer.",
  );
  const written = relay.events.find(
    (event) => event.kind === 45003 && event.pubkey === OWNER,
  );
  expect(written?.tags).toEqual([
    ["h", BOARD],
    ["e", p.id, "", "reply"],
  ]);
});

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`nested replies keep their branches and fit at ${viewport.width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const relay = relayWithBoard();
    const p = post(
      ANN,
      now() - 600,
      "How should we ship the first version?",
      "Let's agree on a small release we can try together.",
    );
    const parent = {
      ...reply(ANN, now() - 500, p.id),
      content: "Start with a small group and collect their feedback.",
    };
    const other = {
      ...reply(BOB, now() - 400, p.id),
      content: "We should also write a short welcome guide.",
    };
    const branch = [parent];
    for (let i = 0; i < 6; i++)
      branch.push({
        ...reply(i % 2 ? ANN : BOB, now() - 300 + i, p.id, branch.at(-1)?.id),
        content:
          i === 0
            ? "Agreed. Can we invite the first ten people this week?"
            : `Follow-up ${i}: keep the first release small and easy to use.`,
      });
    for (const event of [p, other, ...branch.toReversed()]) relay.seed(event);
    await open(page, relay, { post: p.id });
    await expect(page.getByTestId("board-replies").locator("> li")).toHaveCount(
      2,
    );
    for (let i = 1; i < branch.length; i++) {
      await expect(
        page
          .getByTestId(`board-reply-${branch[i - 1].id}`)
          .locator("> ol > li"),
      ).toHaveAttribute("data-testid", `board-reply-${branch[i].id}`);
    }
    const firstBounds = await page
      .getByTestId(`board-reply-content-${parent.id}`)
      .boundingBox();
    const childBounds = await page
      .getByTestId(`board-reply-content-${branch[1].id}`)
      .boundingBox();
    expect(childBounds?.x).toBeGreaterThan(firstBounds?.x ?? 0);
    const deepest = page.getByTestId(
      `board-reply-content-${branch.at(-1)?.id}`,
    );
    expect((await deepest.boundingBox())?.width).toBeGreaterThan(200);
    const thread = page.getByTestId("board-thread");
    expect(
      await thread.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);

    await page
      .getByTestId(`board-reply-content-${parent.id}`)
      .getByTestId("board-reply-to")
      .click();
    await page
      .locator("#board-reply-box")
      .fill("Yes, let's invite them and learn from what they need.");
    await waitForAnimations(page);
    await thread.screenshot({
      path: testInfo.outputPath("board-nested-replies.png"),
    });
  });
}

test("a vote is one record, changing it is another, and pressing it again takes it back", async ({
  page,
}) => {
  const relay = relayWithBoard();
  const p = post(ANN, now() - 500, "Vote on me");
  relay.seed(p);
  await open(page, relay);
  const row = page.getByTestId(`board-post-${p.id}`);

  await row.getByTestId("board-vote-up").click();
  await expect(row.getByTestId("board-vote-score")).toContainText("1");
  await expect(row.getByTestId("board-vote-up")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const up = relay.events.find((e) => e.kind === 45002 && e.pubkey === OWNER);
  expect(up?.content).toBe("+");
  expect(up?.tags).toEqual([
    ["h", BOARD],
    ["e", p.id],
  ]);

  await row.getByTestId("board-vote-down").click();
  await expect(row.getByTestId("board-vote-score")).toContainText("-1");
  await expect(row.getByTestId("board-vote-down")).toHaveAttribute(
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

  await row.getByTestId("board-vote-down").click();
  await expect(row.getByTestId("board-vote-score")).toContainText("0");
  await expect(row.getByTestId("board-vote-down")).toHaveAttribute(
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
    page.getByTestId(`board-post-${p.id}`).getByTestId("board-vote-score"),
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
  await expect(page.getByText("Create your account to post.")).toBeVisible();
  await page
    .getByTestId(`board-post-${p.id}`)
    .getByTestId("board-vote-up")
    .click();
  await expect(page.getByText("Create your account to vote.")).toBeVisible();
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
  await expect(page.getByText("1 room · 1 board")).toBeVisible();

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
  // With a name: someone without one is not offered (a key is no way to tell who they are).
  relay.seed({
    id: eid(),
    pubkey: BOB,
    created_at: now() - 200,
    kind: 0,
    tags: [],
    content: JSON.stringify({ name: "Bob Okafor" }),
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
  await page.getByLabel("Add someone by their profile link").fill("not a key");
  await page.getByTestId("board-add-person").click();
  await expect(page.getByTestId("board-people-problem")).toContainText(
    "That isn't a profile link.",
  );
  expect(relay.events.filter((e) => e.kind === 9000)).toEqual([]);

  // A pasted link to their profile adds that person (an npub or a bare key works too: `members.test.mjs`).
  const carol = "c3".repeat(32);
  await page
    .getByLabel("Add someone by their profile link")
    .fill(`https://alpha.example.com/u/${carol}`);
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

test("a private board's owner takes someone off it after confirming; an admin is not offered to remove the owner", async ({
  page,
}) => {
  const relay = privateBoard("owner");
  await open(page, relay, { board: SECRET });
  await page.getByTestId("board-people-toggle").click();
  await expect(page.getByTestId("board-members").locator("li")).toHaveCount(2);
  // Offered for the other person only: removing yourself is leaving.
  await expect(page.getByTestId("board-remove-person")).toHaveCount(1);
  await page.getByTestId("board-remove-person").click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Remove", exact: true })
    .click();
  await expect
    .poll(() => relay.events.find((e) => e.kind === 9001)?.tags)
    .toEqual([
      ["h", SECRET],
      ["p", ANN],
    ]);
  await expect(page.getByTestId("board-members").locator("li")).toHaveCount(1);

  const asAdmin = privateBoard("admin");
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await open(page, asAdmin, { board: SECRET });
  await page.getByTestId("board-people-toggle").click();
  await expect(page.getByTestId("board-members")).toContainText("(owner)");
  await expect(page.getByTestId("board-remove-person")).toHaveCount(0);
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
    .getByLabel("Add someone by their profile link")
    .fill("d4".repeat(32));
  await page.getByTestId("board-add-person").click();
  // The server's reason as a sentence, without its machine prefix.
  await expect(page.getByTestId("board-people-problem")).toHaveText(
    "Only an admin can add people.",
  );
  await expect(page.getByTestId("board-members").locator("li")).toHaveCount(2);
});

test("someone without an account is asked to make one before writing in a room", async ({
  page,
}) => {
  const relay = createMockRelay({ deriveChannels: true });
  relay.seed(meta(CHAT, "general", "stream"));
  await relay.install(page);
  await page.goto(`/c/${COMMUNITY_HOST}`);
  await page.getByTestId("content-pane").waitFor();
  // Reading #general, which a community opens on, gives a visitor no key: they have not signed up.
  await expect(page.getByTestId("channel-general")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.waitForTimeout(500);
  expect(
    await page.evaluate(() =>
      window.localStorage.getItem("buzz.identity.nsec"),
    ),
  ).toBeNull();
  // No one is signed in, so there is nothing to start a board with.
  await expect(page.getByTestId("new-board")).toHaveCount(0);
  expect(relay.events.filter((e) => e.kind === 9007)).toEqual([]);
  // Writing in the room asks for an account too, and opens sign-up.
  const prompt = page.getByTestId("room-composer-sign-up");
  await expect(prompt).toContainText("Reading needs no account.");
  await prompt.getByRole("button", { name: "Create your account" }).click();
  await expect(page.getByTestId("onboarding-dialog")).toBeVisible();
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
    "doesn't know that project",
  );
  await expect(page.getByTestId("proposal-header")).toContainText(
    "not the project's vote",
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
    page.getByTestId(`board-post-${plain.id}`).getByTestId("board-vote-up"),
  ).toBeVisible();
  await expect(
    page.getByTestId(`board-post-${loved.id}`).getByTestId("board-vote-up"),
  ).toHaveCount(0);
  await expect(
    page.getByTestId(`board-post-${loved.id}`).getByTestId("board-vote-score"),
  ).toHaveCount(0);
  await expect(page.getByTestId(`board-post-${loved.id}`)).toContainText(
    "Proposal",
  );

  // Votes never rank a proposal: under "Top" the ordinary post's one vote puts it first, and the loved proposal's
  // four votes do not lift it past the newer proposal (proposals count as no score, newest first).
  await page.getByTestId("board-sort-top").click();
  await expectRows(page, [
    "Ordinary post",
    "Newest proposal",
    "Loved proposal",
  ]);

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
  const link = `http://${COMMUNITY_HOST}/launchpad/nobody-heard-of-this?decision=${DECISION}`;
  const p = post(ANN, now() - 100, "Look at this", `See ${link} please.`);
  relay.seed(p);
  await open(page, relay, { post: p.id });
  await expect(page.getByTestId("board-thread-body")).toContainText("See");
  await expect(page.getByRole("link", { name: link })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("decision-embed")).toHaveCount(0);
});

// ── moderation: report, and a board owner's removal ──────────────────────────────────────────────────────────────

/** The board's membership record, as the server writes it: who is on the board and in what role. */
function boardMembers(role: "owner" | "admin" | "member") {
  return {
    id: "members-board",
    pubkey: "b".repeat(64),
    created_at: 102,
    kind: 39002,
    tags: [
      ["d", BOARD],
      ["p", ANN, "", "member"],
      ["p", BOB, "", "member"],
      ["p", OWNER, "", role],
    ],
    content: "",
    sig: "sig",
  };
}

/** The membership record as the server rewrites it when roles change: `admins` get the admin role. */
function boardMembersWith(admins: string[], at: number) {
  return {
    id: `members-board-${at}`,
    pubkey: "b".repeat(64),
    created_at: at,
    kind: 39002,
    tags: [
      ["d", BOARD],
      ...[ANN, BOB, OWNER].map((who) => [
        "p",
        who,
        "",
        admins.includes(who) ? "admin" : "member",
      ]),
    ],
    content: "",
    sig: "sig",
  };
}

/** A moderator's removal of a post or reply, as the relay delivers it once it has checked the sender's role. */
function removalFrom(sender: string, target: string) {
  return {
    id: eid(),
    pubkey: sender,
    created_at: now(),
    kind: 9005,
    tags: [
      ["h", BOARD],
      ["e", target],
    ],
    content: "",
    sig: "sig",
  };
}

const openThread = async (page: Page, id: string) => {
  await page
    .getByTestId(`board-post-${id}`)
    .getByTestId("board-post-title")
    .click();
  await expect(page.getByTestId("board-thread")).toBeVisible();
};

test("someone else's post or reply can be reported to the moderators, and your own cannot", async ({
  page,
}) => {
  const relay = relayWithBoard();
  const theirs = post(ANN, now() - 600, "Not yours");
  const theirReply = reply(BOB, now() - 500, theirs.id);
  const mine = post(OWNER, now() - 400, "Mine");
  for (const e of [theirs, theirReply, mine]) relay.seed(e);
  await open(page, relay);

  await openThread(page, theirs.id);
  await page.getByTestId("board-report-post").click();
  await page.getByTestId("report-reason-spam").check();
  await page.getByTestId("report-submit").click();
  await expect(page.getByTestId("report-form")).toHaveCount(0);
  await page
    .getByTestId(`board-reply-content-${theirReply.id}`)
    .getByTestId("board-report-reply")
    .click();
  await page.getByTestId("report-reason-profanity").check();
  await page.getByTestId("report-submit").click();
  await expect(page.getByTestId("report-form")).toHaveCount(0);

  const sent = relay.events.filter((event) => event.kind === 1984);
  expect(sent).toHaveLength(2);
  expect(sent[0].tags).toContainEqual(["e", theirs.id, "spam"]);
  expect(sent[0].tags).toContainEqual(["p", ANN]);
  expect(sent[1].tags).toContainEqual(["e", theirReply.id, "profanity"]);
  expect(sent[1].tags).toContainEqual(["p", BOB]);

  await page.getByTestId("board-back").click();
  await openThread(page, mine.id);
  await expect(page.getByTestId("board-report-post")).toHaveCount(0);
});

test("a signed-out reader who presses Report is told to make an account, and nothing is sent", async ({
  page,
}) => {
  const relay = relayWithBoard();
  const theirs = post(ANN, now() - 600, "Not yours");
  relay.seed(theirs);
  await open(page, relay, { signedIn: false });
  await openThread(page, theirs.id);
  await page.getByTestId("board-report-post").click();
  await expect(page.getByTestId("report-form")).toHaveCount(0);
  expect(relay.events.filter((event) => event.kind === 1984)).toHaveLength(0);
});

test("only a board's owners and admins are offered Remove, and never on their own words", async ({
  page,
}) => {
  const relay = relayWithBoard();
  const theirs = post(ANN, now() - 600, "Not yours");
  const mine = post(OWNER, now() - 500, "Mine");
  relay.seed(boardMembers("member"));
  for (const e of [theirs, mine]) relay.seed(e);
  await open(page, relay);
  await openThread(page, theirs.id);
  await expect(page.getByTestId("board-report-post")).toBeVisible();
  // An ordinary member has nothing to moderate: no menu at all.
  await expect(page.getByTestId("board-moderate-post")).toHaveCount(0);

  const admin = relayWithBoard();
  admin.seed(boardMembers("admin"));
  for (const e of [theirs, mine]) admin.seed(e);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await open(page, admin);
  await openThread(page, theirs.id);
  await page.getByTestId("board-moderate-post").click();
  await expect(page.getByTestId("board-remove-post")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByTestId("board-back").click();
  await openThread(page, mine.id);
  // On their own post an admin may pin or lock the thread, but not remove it as a moderator (they have Delete).
  await page.getByTestId("board-moderate-post").click();
  await expect(page.getByTestId("board-thread-pin")).toBeVisible();
  await expect(page.getByTestId("board-remove-post")).toHaveCount(0);
});

test("a board owner removes someone else's reply and post, and they stay gone after a reload", async ({
  page,
}) => {
  const relay = relayWithBoard();
  const theirs = post(ANN, now() - 600, "Spam post");
  const keep = post(BOB, now() - 500, "Keep this");
  const theirReply = reply(BOB, now() - 400, theirs.id);
  relay.seed(boardMembers("owner"));
  for (const e of [theirs, keep, theirReply]) relay.seed(e);
  await open(page, relay);

  await openThread(page, theirs.id);
  await page
    .getByTestId(`board-reply-content-${theirReply.id}`)
    .getByTestId("board-moderate-reply")
    .click();
  await page.getByTestId("board-remove-reply").click();
  await page.getByTestId("board-remove-dialog-submit").click();
  await expect(page.getByTestId(`board-reply-${theirReply.id}`)).toHaveCount(0);

  await page.getByTestId("board-moderate-post").click();
  await page.getByTestId("board-remove-post").click();
  await page.getByTestId("board-remove-dialog-submit").click();
  await expect(page.getByTestId("board-posts")).toBeVisible();
  await expectRows(page, ["Keep this"]);

  const removals = relay.events.filter((event) => event.kind === 9005);
  expect(removals).toHaveLength(2);
  expect(removals[0].tags).toContainEqual(["h", BOARD]);
  expect(removals[0].tags).toContainEqual(["e", theirReply.id]);
  expect(removals[1].tags).toContainEqual(["e", theirs.id]);
  expect(removals.every((event) => event.pubkey === OWNER)).toBe(true);

  await page.reload();
  await page.getByTestId("content-pane").waitFor();
  await expectRows(page, ["Keep this"]);
});

test("a removal reaches another reader's open board at once, and only when an owner or admin sent it", async ({
  page,
}) => {
  const relay = relayWithBoard();
  const spam = post(ANN, now() - 600, "Spam post");
  const fine = post(BOB, now() - 500, "Fine post");
  relay.seed(boardMembers("owner"));
  for (const e of [spam, fine]) relay.seed(e);
  await open(page, relay, { signedIn: false });
  await expectRows(page, ["Fine post", "Spam post"]);
  await liveOnBoard(page, relay);
  // The members have to be read before a removal can be matched to someone who may send one.
  await expect.poll(() => relay.requestsFor(39002)).toBeGreaterThan(0);

  // Someone who is not an owner or admin: the board ignores it.
  relay.deliver(removalFrom(BOB, spam.id));
  await page.waitForTimeout(500);
  await expectRows(page, ["Fine post", "Spam post"]);
  // The owner's removal of a post on the board: it goes at once, with no reload.
  relay.deliver(removalFrom(OWNER, spam.id));
  await expectRows(page, ["Fine post"]);
});

/**
 * A reader's board has asked to hear about roster changes, so a change delivered now will reach it. It must ask by `#h`:
 * the real server delivers a board's records live only to subscriptions that name the board that way, never to `#d`.
 */
const rosterWatched = (relay: ReturnType<typeof createMockRelay>) =>
  expect
    .poll(() =>
      relay
        .subscriptionFilters()
        .some(
          (f) =>
            f.kinds?.includes(39002) &&
            (f["#h"] as string[] | undefined)?.includes(BOARD),
        ),
    )
    .toBe(true);

test("an open board follows a newly appointed admin's removal without a reload, and keeps it after that admin is demoted", async ({
  page,
}) => {
  const relay = relayWithBoard();
  const spam = post(BOB, now() - 600, "Spam post");
  const fine = post(BOB, now() - 500, "Fine post");
  relay.seed(boardMembersWith([], 102));
  for (const e of [spam, fine]) relay.seed(e);
  await open(page, relay, { signedIn: false });
  await expectRows(page, ["Fine post", "Spam post"]);
  await liveOnBoard(page, relay);
  await rosterWatched(relay);

  // Another session makes ANN an admin; the reader's roster follows, and ANN's removal then counts.
  const promoted = boardMembersWith([ANN], now() + 10);
  relay.seed(promoted);
  relay.deliver(promoted);
  relay.deliver(removalFrom(ANN, spam.id));
  await expectRows(page, ["Fine post"]);

  // ANN is demoted. What was removed stays removed, and a removal from ANN now counts for nothing.
  const demoted = boardMembersWith([], now() + 20);
  relay.seed(demoted);
  relay.deliver(demoted);
  await expect.poll(() => relay.requestsFor(39002)).toBeGreaterThanOrEqual(3);
  // Give the answer time to reach the board: until then it still thinks ANN is an admin, as it should.
  await page.waitForTimeout(600);
  await expectRows(page, ["Fine post"]);
  // The list holds still while it is read, so a removed post that came back would wait behind this notice, not show.
  await expect(page.getByTestId("board-show-new")).toHaveCount(0);
  relay.deliver(removalFrom(ANN, fine.id));
  await page.waitForTimeout(600);
  await expectRows(page, ["Fine post"]);
  await expect(page.getByTestId("board-show-new")).toHaveCount(0);
});

test("a removal from someone the reader does not yet know to be an admin makes the board check the roster again", async ({
  page,
}) => {
  const relay = relayWithBoard();
  const spam = post(BOB, now() - 600, "Spam post");
  const fine = post(BOB, now() - 500, "Fine post");
  relay.seed(boardMembersWith([], 102));
  for (const e of [spam, fine]) relay.seed(e);
  await open(page, relay, { signedIn: false });
  await expectRows(page, ["Fine post", "Spam post"]);
  await liveOnBoard(page, relay);
  await rosterWatched(relay);
  const before = relay.requestsFor(39002);

  // The server already lists ANN as an admin, but the reader never heard (no roster event reached it).
  relay.seed(boardMembersWith([ANN], now() + 10));
  relay.deliver(removalFrom(ANN, spam.id));
  await expectRows(page, ["Fine post"]);
  expect(relay.requestsFor(39002)).toBeGreaterThan(before);

  // Someone who is still not an admin after the check changes nothing (OWNER here is an ordinary member, and not the author).
  relay.deliver(removalFrom(OWNER, fine.id));
  await page.waitForTimeout(600);
  await expectRows(page, ["Fine post"]);
});

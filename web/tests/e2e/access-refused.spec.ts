import { expect, type Page, test } from "@playwright/test";

import { createMockRelay } from "./mock-relay";

/**
 * When the server restricts someone whose app is open: a ban arriving now, a timeout, a board mute. The person is told
 * in plain words what happened and what still works, live updates stop instead of retrying forever, and a write says
 * why it was refused instead of "the connection closed".
 *
 * The mock bans the way the real server does (an `OK false` frame with the reason, then a hang-up, then every login
 * refused with the same reason) and refuses writes with the real server's own words, which `refusal-text.test.mjs`
 * checks against the server's source.
 */

const BOARD = "b0a4d000-1111-2222-3333-666666666666";
const NSEC = "55".repeat(32);
const ANN = "a1".repeat(32);
const now = () => Math.floor(Date.now() / 1000);

function relayWithBoard(options?: Parameters<typeof createMockRelay>[0]) {
  const relay = createMockRelay(options);
  relay.seed({
    id: `meta-${BOARD}`,
    pubkey: "b".repeat(64),
    created_at: 100,
    kind: 39000,
    tags: [["d", BOARD], ["name", "ideas"], ["public"], ["t", "forum"]],
    content: "",
    sig: "sig",
  });
  relay.seed({
    id: "c3".repeat(32),
    pubkey: ANN,
    created_at: now() - 600,
    kind: 45001,
    tags: [["h", BOARD]],
    content: "# Already here",
    sig: "sig",
  });
  return relay;
}

async function open(page: Page, relay: ReturnType<typeof createMockRelay>) {
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
  }, NSEC);
  await page.goto(`/c/alpha.example.com?channel=${BOARD}`);
  await page.getByTestId("content-pane").waitFor();
  await expect(page.getByTestId("board-posts")).toContainText("Already here");
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

async function tryToPost(page: Page) {
  await page.getByTestId("board-new-post").click();
  await page.getByLabel("Title").fill("One more");
  await page.getByTestId("board-composer-submit").click();
}

test("a ban arriving while the board is open says so, stops live updates, and refuses a post in plain words", async ({
  page,
}) => {
  const relay = relayWithBoard();
  await open(page, relay);

  relay.ban("blocked: you are banned from this community");
  const status = page.getByTestId("board-live-status");
  await expect(status).toHaveText("You are banned from this community.");
  // Final: the subscription does not go back to "reconnecting" and try again.
  await page.waitForTimeout(2500);
  await expect(status).toHaveText("You are banned from this community.");

  await tryToPost(page);
  await expect(page.getByTestId("board-composer-problem")).toHaveText(
    "You are banned from this community.",
  );
});

test("a timeout and a board mute refuse a post with when they end, in plain words", async ({
  page,
}) => {
  const until = now() + 3600;
  let reason = `restricted: you are timed out until ${until}`;
  const relay = relayWithBoard({
    refuse: (event) => (event.kind === 45001 ? reason : null),
  });
  await open(page, relay);

  await tryToPost(page);
  const problem = page.getByTestId("board-composer-problem");
  await expect(problem).toContainText(
    "You are timed out in this community until",
  );
  await expect(problem).toContainText("You can still read");
  await expect(problem).not.toContainText(String(until));

  reason = `restricted: you are muted on this board until ${until}`;
  await page.getByTestId("board-composer-submit").click();
  await expect(problem).toContainText("You are muted on this board until");
  await expect(problem).not.toContainText(String(until));
});

test("removed from a board while it is open: the reader is told, and the page stops looking live", async ({
  page,
}) => {
  // Logged in from the start, as the real server always asks: a removal is then retried once, refused again, and final.
  const relay = relayWithBoard({ requireAuth: true, challengeDelayMs: 50 });
  await open(page, relay);

  relay.revoke(BOARD);
  const status = page.getByTestId("board-live-status");
  await expect(status).toHaveText(
    "You no longer have access to this room or board. Live updates stopped.",
  );
});

test("a ban arriving while a chat room is open says so under the room's header", async ({
  page,
}) => {
  const ROOM = "0f0f0f0f-1111-2222-3333-666666666666";
  const relay = createMockRelay();
  relay.seed({
    id: `meta-${ROOM}`,
    pubkey: "b".repeat(64),
    created_at: 100,
    kind: 39000,
    tags: [["d", ROOM], ["name", "general"], ["public"], ["t", "stream"]],
    content: "",
    sig: "sig",
  });
  await relay.install(page);
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
  }, NSEC);
  await page.goto(`/c/alpha.example.com?channel=${ROOM}`);
  await page.getByTestId("content-pane").waitFor();
  await expect
    .poll(() =>
      relay
        .subscriptionFilters()
        .some((f) => (f["#h"] as string[] | undefined)?.includes(ROOM)),
    )
    .toBe(true);

  relay.ban("blocked: you are banned from this community");
  await expect(page.getByTestId("live-refusal")).toHaveText(
    "You are banned from this community.",
  );
  await expect(page.getByTestId("live-status-chip")).toHaveText(
    "Live updates stopped",
  );
});

import { expect, type Page, type Route, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { expectAccessible } from "../helpers/a11y";
import { createMockRelay } from "./mock-relay";

/**
 * Unread rooms and boards (D101), from the server's read-state API: counts on the rooms and boards that are not open,
 * the open one read through the anchor the server gave once it has been on screen a moment, marks kept until the
 * server settles them, and no markers at all from a server that does not offer the API. The API is answered here; the
 * real server's counting is covered by its own tests (`crates/buzz-relay/src/api/buzz_v1`).
 */

const ROOM = "0f0f0f0f-1111-2222-3333-aaaaaaaaaaaa";
const OTHER = "0f0f0f0f-1111-2222-3333-bbbbbbbbbbbb";
const BOARD = "0f0f0f0f-1111-2222-3333-cccccccccccc";
const NSEC = "61".repeat(32);
const ME = getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);
const ANCHOR = "e1".repeat(32);
const now = () => Math.floor(Date.now() / 1000);

function meta(id: string, name: string, forum = false) {
  return {
    id: `meta-${id}`,
    pubkey: "9".repeat(64),
    kind: 39000,
    created_at: 100,
    tags: [["d", id], ["name", name], ...(forum ? [["t", "forum"]] : [])],
    content: "",
    sig: "sig",
  };
}

function relayWithRooms() {
  const relay = createMockRelay();
  relay.seed(meta(ROOM, "general"));
  relay.seed(meta(OTHER, "random"));
  relay.seed(meta(BOARD, "ideas", true));
  relay.seed({
    id: "m".padEnd(64, "1"),
    pubkey: "a1".repeat(32),
    kind: 9,
    created_at: now() - 60,
    tags: [["h", OTHER]],
    content: "news in random",
    sig: "sig",
  });
  return relay;
}

const row = (id: string, unread: number, attention = 0) => ({
  channel_id: id,
  name: "x",
  channel_type: "stream",
  archived: false,
  hidden: false,
  unread: { status: "exact", value: unread },
  attention: { status: "exact", value: attention },
  latest_message_id: unread > 0 ? ANCHOR : null,
  latest_message_at: unread > 0 ? now() : null,
  latest_message_complete: true,
  threads: { items: [], complete: true },
});

/** A server that offers read state: `counts` by room, and every write recorded (answered with `writeStatus`). */
async function offerReadState(
  page: Page,
  counts: Map<string, [number, number]>,
  writeStatus: () => number = () => 200,
) {
  const writes: {
    intents: { channel_id: string; message_id: string; type: string }[];
  }[] = [];
  await page.route("**/info", (route: Route) =>
    route.fulfill({
      json: { buzz_v1: { version: 1, base_path: "/buzz/v1" } },
    }),
  );
  await page.route("**/buzz/v1/me/sidebar*", (route: Route) =>
    route.fulfill({
      json: {
        account: { retention_seconds: 2592000, cutoff_ms: 0 },
        channels: [...counts].map(([id, [unread, attention]]) =>
          row(id, unread, attention),
        ),
        next_cursor: null,
      },
    }),
  );
  await page.route("**/buzz/v1/me/read-state", async (route: Route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    writes.push(body);
    const status = writeStatus();
    if (status !== 200) {
      await route.fulfill({ status, json: { error: { code: "unavailable" } } });
      return;
    }
    for (const intent of body.intents) counts.set(intent.channel_id, [0, 0]);
    await route.fulfill({
      json: {
        outcomes: body.intents.map(() => ({ status: "applied" })),
        projection_status: "not_requested",
      },
    });
  });
  return writes;
}

/** Opens the community; the mock server must be installed first (`relay.install`), then any routes over it. */
async function open(
  page: Page,
  relay: ReturnType<typeof createMockRelay>,
  channel?: string,
) {
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
    window.localStorage.setItem("buzz.identity.backedUp", "1");
  }, NSEC);
  await page.goto(
    `/c/alpha.example.com${channel ? `?channel=${channel}` : ""}`,
  );
  await page.getByTestId("content-pane").waitFor();
}

test("rooms and boards that are not open show what is unread; opening one reads it through the server's anchor", async ({
  page,
}) => {
  const relay = relayWithRooms();
  const counts = new Map<string, [number, number]>([
    [ROOM, [0, 0]],
    [OTHER, [3, 1]],
    [BOARD, [2, 0]],
  ]);
  await relay.install(page);
  const writes = await offerReadState(page, counts);
  await open(page, relay, ROOM);

  const random = page.getByTestId("channel-random-unread");
  await expect(random).toContainText("3");
  await expect(random).toContainText("some for you");
  await expect(page.getByTestId("board-nav-ideas-unread")).toContainText("2");
  // Nothing unread in the open room, and a zero shows nothing.
  await expect(page.getByTestId("channel-general-unread")).toHaveCount(0);
  await expectAccessible(page, "unread markers");

  await page.getByTestId("channel-random").click();
  await expect(page.getByText("news in random")).toBeVisible();
  await expect.poll(() => writes.length, { timeout: 10_000 }).toBe(1);
  expect(writes[0].intents).toEqual([
    { type: "mark_channel_read", channel_id: OTHER, message_id: ANCHOR },
  ]);
  await expect(page.getByTestId("channel-random-unread")).toHaveCount(0);
  // The board is still unread.
  await expect(page.getByTestId("board-nav-ideas-unread")).toContainText("2");
});

test("a mark the server did not settle is kept and sent again, unchanged, after a reload", async ({
  page,
}) => {
  const relay = relayWithRooms();
  const counts = new Map<string, [number, number]>([[OTHER, [1, 0]]]);
  let failing = true;
  await relay.install(page);
  const writes = await offerReadState(page, counts, () =>
    failing ? 503 : 200,
  );
  await open(page, relay, OTHER);
  await expect.poll(() => writes.length, { timeout: 10_000 }).toBe(1);

  failing = false;
  await page.reload();
  await page.getByTestId("content-pane").waitFor();
  await expect
    .poll(() => writes.length, { timeout: 10_000 })
    .toBeGreaterThan(1);
  expect(writes[1].intents[0]).toEqual({
    type: "mark_channel_read",
    channel_id: OTHER,
    message_id: ANCHOR,
  });
});

test("a server without read state shows no markers and is sent nothing", async ({
  page,
}) => {
  const relay = relayWithRooms();
  await relay.install(page);
  const asked: string[] = [];
  await page.route("**/buzz/v1/**", (route: Route) => {
    asked.push(route.request().url());
    return route.fulfill({ status: 404 });
  });
  await open(page, relay, ROOM);
  await expect(page.getByTestId("channel-random")).toBeVisible();
  await page.waitForTimeout(2_000);
  await expect(
    page.locator(
      "[data-testid^='channel-'][data-testid$='-unread'], [data-testid^='board-nav-'][data-testid$='-unread']",
    ),
  ).toHaveCount(0);
  expect(asked).toHaveLength(0);
});

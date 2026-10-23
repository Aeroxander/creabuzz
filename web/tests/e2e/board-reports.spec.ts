import { expect, type Page, type Route, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { expectAccessible } from "../helpers/a11y";
import { createMockRelay } from "./mock-relay";

/**
 * Board moderation pass 2 (D99): a board's moderators see its open reports and close them, the author of removed words
 * is told in the app, and a private chat room's owner sees who can read it and takes someone off it.
 *
 * The server is a mock that keeps what it is sent, and the report queue read is answered here, so what is checked is
 * what the page shows and what it sends. The real server's decisions (who may read and close a board's reports, the
 * notice to the author) are covered by `crates/buzz-relay/src/handlers/board_report_postgres_tests.rs`.
 */

const BOARD = "b0a4d000-1111-2222-3333-666666666666";
const ROOM = "0f0f0f0f-1111-2222-3333-777777777777";
const SERVER = "b".repeat(64);
const NSEC = "57".repeat(32);
const ME = getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);
const ANN = "a1".repeat(32);
const BOB = "b2".repeat(32);
const now = () => Math.floor(Date.now() / 1000);

type Relay = ReturnType<typeof createMockRelay>;

let counter = 0;
const eid = () =>
  `${(++counter).toString(16).padStart(8, "0")}`.padEnd(64, "e");

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

function post(author: string, title: string) {
  return {
    id: eid(),
    pubkey: author,
    created_at: now() - 600,
    kind: 45001,
    tags: [["h", BOARD]],
    content: `# ${title}`,
    sig: "sig",
  };
}

function profile(pubkey: string, name: string) {
  return {
    id: eid(),
    pubkey,
    created_at: 50,
    kind: 0,
    tags: [],
    content: JSON.stringify({ name }),
    sig: "sig",
  };
}

/** The board, with the reader as `role` and Bob as `bobRole`. */
function boardRelay(role: string, bobRole = "member", ...events: object[]) {
  const relay = createMockRelay({ applyDeletions: true });
  relay.seed(
    record(39000, [
      ["d", BOARD],
      ["name", "supporters"],
      ["public"],
      ["t", "forum"],
    ]),
  );
  relay.seed(
    record(39002, [
      ["d", BOARD],
      ["p", ANN, "", "member"],
      ["p", BOB, "", bobRole],
      ["p", ME, "", role],
    ]),
  );
  relay.seed(profile(ANN, "Ann"));
  relay.seed(profile(BOB, "Bob"));
  for (const event of events) relay.seed(event as ReturnType<typeof record>);
  return relay;
}

/** The signed report's id for a row named `r<n>`. */
const reportEventId = (id: string) => id.slice(1).padStart(64, "0");

function reportRow(id: string, target: string, note: string) {
  return {
    id,
    report_event_id: reportEventId(id),
    reporter_pubkey: null,
    target_kind: "event",
    target,
    channel_id: BOARD,
    report_type: "spam",
    note,
    status: "open",
    created_at: new Date().toISOString(),
  };
}

/** Answers the board's report read with `rows`, less those the page has closed (a 9044 naming them). */
async function serveReports(
  page: Page,
  relay: Relay,
  rows: ReturnType<typeof reportRow>[],
) {
  const asked: string[] = [];
  await page.route("**/moderation/reports*", async (route: Route) => {
    // The whole community's queue is not this reader's: only the board's read is answered.
    if (!new URL(route.request().url()).searchParams.has("channel")) {
      await route.fulfill({ status: 403, json: { error: "restricted" } });
      return;
    }
    asked.push(route.request().url());
    const closed = new Set(
      relay.events
        .filter((e) => e.kind === 9044)
        .map((e) => e.tags.find((t) => t[0] === "report")?.[1]),
    );
    await route.fulfill({
      json: rows.filter((row) => !closed.has(row.report_event_id)),
    });
  });
  return asked;
}

async function open(page: Page, relay: Relay, channel = BOARD) {
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
  }, NSEC);
  await page.goto(`/c/alpha.example.com?channel=${channel}`);
  await page.getByTestId("content-pane").waitFor();
}

test("a board's owner sees its open reports, removes a reported post with a reason, and dismisses another", async ({
  page,
}) => {
  const spam = post(ANN, "Cheap watches");
  const fine = post(BOB, "A fair question");
  const relay = boardRelay("owner", "member", spam, fine);
  const asked = await serveReports(page, relay, [
    reportRow("r1", spam.id, "selling things"),
    reportRow("r2", fine.id, "I disagree"),
  ]);
  await open(page, relay);

  // The count is on the Moderation button, before the panel is open.
  await expect(page.getByTestId("board-report-count")).toContainText("2");
  expect(new URL(asked[0]).searchParams.get("channel")).toBe(BOARD);
  expect(new URL(asked[0]).searchParams.get("status")).toBe("open");

  await page.getByTestId("board-moderation-toggle").click();
  const rows = page.getByTestId("board-report-row");
  await expect(rows).toHaveCount(2);
  const first = rows.filter({ hasText: "Cheap watches" });
  await expect(first).toContainText("Spam · a post by Ann");
  await expect(first).toContainText("Why: selling things");
  // Who reported is never shown here.
  await expect(page.getByTestId("board-reports")).not.toContainText(
    "Reported by",
  );
  await expectAccessible(page, "board reports");

  await first.getByTestId("board-report-remove").click();
  await page.getByTestId("board-report-remove-dialog-reason").fill("Spam");
  await page.getByTestId("board-report-remove-dialog-submit").click();
  await expect(rows).toHaveCount(1);
  const removal = relay.events.findIndex((e) => e.kind === 9005);
  const closing = relay.events.findIndex(
    (e) =>
      e.kind === 9044 &&
      e.tags.some((t) => t[0] === "report" && t[1] === reportEventId("r1")),
  );
  expect(removal).toBeGreaterThanOrEqual(0);
  // The words go first; the report says "acted on" only after.
  expect(closing).toBeGreaterThan(removal);
  expect(relay.events[removal].tags).toEqual([
    ["h", BOARD],
    ["e", spam.id],
    ["public_reason", "Spam"],
  ]);
  expect(relay.events[closing].tags).toEqual([
    ["report", reportEventId("r1")],
    ["status", "resolved"],
    ["action", "delete"],
  ]);

  await rows.first().getByTestId("board-report-dismiss").click();
  await expect(page.getByTestId("board-reports-empty")).toBeVisible();
  const dismissal = relay.events.filter((e) => e.kind === 9044).at(-1);
  expect(dismissal?.tags).toContainEqual(["action", "dismiss"]);
  expect(dismissal?.tags).toContainEqual(["status", "dismissed"]);
  // Dismissing removes nothing.
  expect(relay.events.filter((e) => e.kind === 9005)).toHaveLength(1);
  await expect(page.getByTestId("board-report-count")).toHaveCount(0);
});

test("a moderator is told who decides a report about an equal, and can close one about words already gone", async ({
  page,
}) => {
  const admins = post(BOB, "Admin notes");
  const relay = boardRelay("admin", "admin", admins);
  await serveReports(page, relay, [
    reportRow("r3", admins.id, "rude"),
    reportRow("r4", "f6".repeat(32), "already gone"),
  ]);
  await open(page, relay);
  await page.getByTestId("board-moderation-toggle").click();

  const equal = page
    .getByTestId("board-report-row")
    .filter({ hasText: "Admin notes" });
  await expect(equal).toContainText("same or higher standing");
  await expect(equal.getByTestId("board-report-remove")).toHaveCount(0);
  await expect(equal.getByTestId("board-report-dismiss")).toHaveCount(0);

  const gone = page
    .getByTestId("board-report-row")
    .filter({ hasText: "no longer on this board" });
  await expect(gone.getByTestId("board-report-remove")).toHaveCount(0);
  await gone.getByTestId("board-report-close").click();
  await expect(page.getByTestId("board-report-row")).toHaveCount(1);
  // Nothing to remove: only the report is closed.
  expect(relay.events.filter((e) => e.kind === 9005)).toHaveLength(0);
  expect(relay.events.find((e) => e.kind === 9044)?.tags).toContainEqual([
    "action",
    "delete",
  ]);
});

test("a reader who does not moderate the board is never shown reports, and the server is not asked", async ({
  page,
}) => {
  const relay = boardRelay("member", "member", post(ANN, "Hello"));
  const asked = await serveReports(page, relay, [
    reportRow("r5", "f7".repeat(32), "x"),
  ]);
  await open(page, relay);
  await page.getByTestId("board-moderation-toggle").click();
  await expect(page.getByTestId("board-moderation-panel")).toBeVisible();
  await expect(page.getByTestId("board-reports")).toHaveCount(0);
  await expect(page.getByTestId("board-report-count")).toHaveCount(0);
  expect(asked).toHaveLength(0);
});

test("the author of removed words is told in the notifications, with the reason", async ({
  page,
}) => {
  const relay = boardRelay(
    "member",
    "member",
    record(
      45004,
      [
        ["h", BOARD],
        ["action", "remove"],
        ["actor", BOB],
        ["role", "moderator"],
        ["e", "f8".repeat(32)],
        ["p", ME],
      ],
      "Off topic",
      now() - 30,
    ),
  );
  await open(page, relay);
  const bell = page.getByTestId("notifications-bell");
  await expect(bell).toContainText(/[1-9]/, { timeout: 30_000 });
  await bell.getByRole("button").first().click();
  await expect(bell.getByText("A moderator removed your post")).toBeVisible();
  await expect(bell.getByText(/Reason: Off topic\./)).toBeVisible();
});

test("a private room's owner sees who can read it and takes someone off it", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(record(39000, [["d", ROOM], ["name", "founders"], ["private"]]));
  relay.seed(
    record(39002, [
      ["d", ROOM],
      ["p", ME, "", "owner"],
      ["p", ANN, "", "member"],
    ]),
  );
  relay.seed(profile(ANN, "Ann"));
  await open(page, relay, ROOM);

  // The invitation card opens the list instead of copying a link that lets nobody in.
  await page.getByTestId("channel-add-people").click();
  const people = page.getByTestId("room-people");
  await expect(people).toContainText(
    "Only the people below can read this room",
  );
  await expect(people.getByTestId("room-members")).toContainText("Ann");
  await expectAccessible(page, "private room people");
  await page.getByRole("button", { name: "Remove Ann from this room" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Remove", exact: true })
    .click();
  await expect
    .poll(() => relay.events.filter((e) => e.kind === 9001).length)
    .toBe(1);
  expect(relay.events.find((e) => e.kind === 9001)?.tags).toEqual([
    ["h", ROOM],
    ["p", ANN],
  ]);
  await expect(people.getByTestId("room-members")).not.toContainText("Ann");
  // Nobody is offered to remove themself here: that is leaving.
  await expect(people.getByTestId("room-remove-person")).toHaveCount(0);
});

test("a direct-message thread is private but offers no people to add or remove", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(
    record(39000, [
      ["d", BOARD],
      ["name", "general"],
      ["t", "stream"],
    ]),
  );
  relay.seed(
    record(39000, [
      ["d", ROOM],
      ["name", "DM"],
      ["private"],
      ["hidden"],
      ["t", "dm"],
      ["p", ME],
      ["p", ANN],
    ]),
  );
  // The notice that puts the thread in Messages: it is opened there, not from the channel list.
  relay.seed(
    record(41001, [
      ["d", ROOM],
      ["p", ME],
      ["p", ANN],
    ]),
  );
  await open(page, relay);
  await page.getByTestId("dms-toggle").click();
  await page.getByTestId(`dm-${ROOM.slice(0, 8)}`).click();
  await expect(page.getByTestId("channel-add-people")).toBeVisible();
  await expect(page.getByTestId("room-people-toggle")).toHaveCount(0);
  await page.getByTestId("channel-add-people").click();
  await expect(page.getByTestId("room-people")).toHaveCount(0);
});

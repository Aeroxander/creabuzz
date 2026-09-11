import { expect, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { createMockRelay } from "./mock-relay";

/**
 * Cross-user behaviour: two clients, one relay.
 *
 * Single-page suites cannot show whether live delivery works, because nothing
 * has to reach a second subscriber. These tests share one in-memory relay
 * between two pages.
 */

const CHANNEL_ID = "0f0f0f0f-1111-2222-3333-444444444444";

function channelEvent() {
  return {
    id: "chan-event-1",
    pubkey: "b".repeat(64),
    created_at: 100,
    kind: 39000,
    tags: [
      ["d", CHANNEL_ID],
      ["name", "general"],
    ],
    content: "",
    sig: "sig",
  };
}

test("a page published in one client reaches the other live", async ({
  browser,
}) => {
  const relay = createMockRelay();
  const first = await browser.newContext();
  const second = await browser.newContext();
  const author = await first.newPage();
  const reader = await second.newPage();

  // Both clients know the channel (seeded history, like a real relay).
  relay.seed(channelEvent());
  await relay.install(author);
  await relay.install(reader);
  await author.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);
  await reader.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);
  await expect(author.getByText("No messages yet")).toBeVisible();

  // The reader subscribes; the author posts.
  await expect(reader.getByTestId("composer-input")).toBeVisible();
  await author.getByTestId("composer-input").fill("Live delivery check");
  await author.getByTestId("composer-send").click();

  // It must arrive without a reload, through the live subscription.
  await expect(reader.getByText("Live delivery check")).toBeVisible({
    timeout: 15_000,
  });

  await first.close();
  await second.close();
});

test("a mention from another user raises the notification bell", async ({
  browser,
}) => {
  // Two contexts: each page has its own identity in local storage, so the
  // mention targets a different pubkey than the author's.
  const relay = createMockRelay();
  const readerNsec = "22".repeat(32);
  const readerPubkey = getPublicKey(
    Uint8Array.from(
      readerNsec.match(/.{2}/g)!.map((b) => Number.parseInt(b, 16)),
    ),
  );

  const readerContext = await browser.newContext();
  await readerContext.addInitScript(
    ([nsec]) => window.localStorage.setItem("buzz.identity.nsec", nsec),
    [readerNsec],
  );
  const authorContext = await browser.newContext();

  const reader = await readerContext.newPage();
  const author = await authorContext.newPage();
  relay.seed(channelEvent());
  await relay.install(reader);
  await relay.install(author);
  await reader.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);
  await author.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);
  await expect(reader.getByTestId("content-pane")).toBeVisible();

  // Another user mentions the reader.
  relay.deliver({
    id: "mention-1",
    pubkey: "c".repeat(64),
    created_at: 200,
    kind: 9,
    tags: [
      ["h", CHANNEL_ID],
      ["p", readerPubkey],
    ],
    content: "@reader can you look at this?",
    sig: "sig",
  });

  // The bell must show the unread mention, list it, and route to the channel.
  // The feed polls (the relay does not fan out `#p`), so allow for one interval.
  const bell = reader.getByTestId("notifications-bell");
  await expect(bell).toContainText("1", { timeout: 30_000 });
  await bell.getByRole("button").first().click();
  // Scoped to the panel: the same text is also in the timeline behind it.
  await expect(bell.getByText("can you look at this?")).toBeVisible();

  await readerContext.close();
  await authorContext.close();
});

test("an edit and a reaction reach the other client live", async ({
  browser,
}) => {
  const relay = createMockRelay();
  const first = await browser.newContext();
  const second = await browser.newContext();
  const author = await first.newPage();
  const reader = await second.newPage();
  relay.seed(channelEvent());
  await relay.install(author);
  await relay.install(reader);
  await author.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);
  await reader.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);

  await author.getByTestId("composer-input").fill("Original wording");
  await author.getByTestId("composer-send").click();
  await expect(reader.getByText("Original wording")).toBeVisible({
    timeout: 15_000,
  });

  // The author edits the message.
  const authorRow = author.getByTestId("message-row").first();
  await authorRow.hover();
  await authorRow.getByTestId("edit-button").click();
  await author.getByTestId("composer-input").fill("Edited wording");
  await author.getByTestId("composer-send").click();

  // The reader must see the edit without a reload (kind 40003 overlay).
  // Scoped to the row: the composer and the row can both match otherwise.
  const readerRowText = reader.getByTestId("message-row").first();
  await expect(readerRowText).toContainText("Edited wording", {
    timeout: 15_000,
  });
  await expect(readerRowText).not.toContainText("Original wording");

  // The reader reacts; the author sees the pill.
  const readerRow = reader.getByTestId("message-row").first();
  await readerRow.hover();
  await readerRow.getByTestId("quick-react-👍").click();
  await expect(
    author.getByTestId("message-row").first().getByText("👍"),
  ).toBeVisible({ timeout: 15_000 });

  await first.close();
  await second.close();
});

test("a task created by one client appears on the other's board", async ({
  browser,
}) => {
  const relay = createMockRelay();
  const first = await browser.newContext();
  const second = await browser.newContext();
  const author = await first.newPage();
  const reader = await second.newPage();
  relay.seed(channelEvent());
  await relay.install(author);
  await relay.install(reader);
  await author.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);
  await reader.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);

  await author.getByTestId("work-toggle").click();
  await reader.getByTestId("work-toggle").click();
  await expect(reader.getByText("0 items")).toBeVisible();

  await author.getByTestId("kanban-add-open").click();
  await author.getByTestId("kanban-quick-input").fill("Cross-client task");
  await author
    .getByTestId("kanban-quick-input")
    .locator("xpath=following-sibling::button[1]")
    .click();

  await expect(reader.getByText("Cross-client task")).toBeVisible({
    timeout: 15_000,
  });

  await first.close();
  await second.close();
});

test("a client recovers after its connection drops", async ({ browser }) => {
  const relay = createMockRelay();
  const first = await browser.newContext();
  const second = await browser.newContext();
  const author = await first.newPage();
  const reader = await second.newPage();
  relay.seed(channelEvent());
  await relay.install(author);
  await relay.install(reader);
  await author.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);
  await reader.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);

  await author.getByTestId("composer-input").fill("Before the drop");
  await author.getByTestId("composer-send").click();
  await expect(reader.getByText("Before the drop")).toBeVisible({
    timeout: 15_000,
  });

  // The relay goes away.
  relay.dropConnections();
  await expect(reader.getByTestId("live-status-chip")).toBeVisible({
    timeout: 15_000,
  });

  // It comes back; the client must reconnect and resume live delivery.
  await author.getByTestId("composer-input").fill("After the drop");
  await author.getByTestId("composer-send").click();
  await expect(reader.getByText("After the drop")).toBeVisible({
    timeout: 30_000,
  });
  await expect(reader.getByTestId("live-status-chip")).toBeHidden({
    timeout: 15_000,
  });

  await first.close();
  await second.close();
});

test("a page deleted by one client disappears for the other", async ({
  browser,
}) => {
  // Exercises the NIP-09 tombstone end to end: publish, then the other client's
  // page list has to drop it without a reload.
  const relay = createMockRelay();
  const first = await browser.newContext();
  const second = await browser.newContext();
  const author = await first.newPage();
  const reader = await second.newPage();
  relay.seed(channelEvent());
  await relay.install(author);
  await relay.install(reader);
  await author.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);
  await reader.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);

  await author.getByTestId("wiki-toggle").click();
  await author.getByTestId("wiki-new-page").click();
  await author.getByTestId("page-name-input").fill("shared-page");
  await author.getByTestId("page-name-confirm").click();
  const editor = author.getByTestId("wiki-wysiwyg").locator(".ProseMirror");
  await editor.click();
  await author.keyboard.type("Content both clients should see");
  await author.getByTestId("wiki-save").click();
  await expect(author.getByText("Page saved")).toBeVisible();

  // The reader sees the published page.
  await reader.getByTestId("wiki-toggle").click();
  await expect(reader.getByTestId("wiki-page-shared-page")).toBeVisible({
    timeout: 20_000,
  });

  // The author deletes it; the tombstone must reach the reader.
  await author.getByTestId("wiki-delete").click();
  await author.getByTestId("confirm-accept").click();
  await expect(author.getByText("Deleted shared-page")).toBeVisible();

  await expect(reader.getByTestId("wiki-page-shared-page")).toBeHidden({
    timeout: 20_000,
  });

  await first.close();
  await second.close();
});

test("a deleted message disappears for the other client", async ({
  browser,
}) => {
  const relay = createMockRelay();
  const first = await browser.newContext();
  const second = await browser.newContext();
  const author = await first.newPage();
  const reader = await second.newPage();
  relay.seed(channelEvent());
  await relay.install(author);
  await relay.install(reader);
  await author.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);
  await reader.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);

  await author.getByTestId("composer-input").fill("Delete me");
  await author.getByTestId("composer-send").click();
  await expect(reader.getByText("Delete me")).toBeVisible({ timeout: 15_000 });

  const row = author.getByTestId("message-row").first();
  await row.hover();
  await row.getByTestId("delete-button").click();
  await author.getByTestId("confirm-accept").click();

  // The reader sees the deletion marker, not the original text.
  await expect(reader.getByText("message deleted")).toBeVisible({
    timeout: 15_000,
  });

  await first.close();
  await second.close();
});

test("the composer suggests people seen in the channel, not just agents", async ({
  browser,
}) => {
  // `useMentionCandidates` ran its query inside a `useMemo` and discarded the
  // result, so only roster agents ever appeared in the mention list.
  const relay = createMockRelay();
  const context = await browser.newContext();
  const page = await context.newPage();
  const alice = "d".repeat(64);
  relay.seed(channelEvent());
  relay.seed({
    id: "alice-message",
    pubkey: alice,
    created_at: 150,
    kind: 9,
    tags: [["h", CHANNEL_ID]],
    content: "Hello from Alice",
    sig: "sig",
  });
  relay.seed({
    id: "alice-profile",
    pubkey: alice,
    created_at: 140,
    kind: 0,
    tags: [],
    content: JSON.stringify({ name: "alice", display_name: "Alice Example" }),
    sig: "sig",
  });
  await relay.install(page);
  await page.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);
  await expect(page.getByText("Hello from Alice")).toBeVisible();

  const composer = page.getByTestId("composer-input");
  await composer.click();
  await composer.fill("@Ali");

  const candidates = page.getByTestId("mention-option");
  await expect(candidates.first()).toBeVisible({ timeout: 10_000 });
  await expect(candidates.filter({ hasText: "Alice Example" })).toHaveCount(1);

  await context.close();
});

test("a reply appears threaded for the other client", async ({ browser }) => {
  const relay = createMockRelay();
  const first = await browser.newContext();
  const second = await browser.newContext();
  const author = await first.newPage();
  const reader = await second.newPage();
  relay.seed(channelEvent());
  await relay.install(author);
  await relay.install(reader);
  await author.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);
  await reader.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);

  await author.getByTestId("composer-input").fill("Root message");
  await author.getByTestId("composer-send").click();
  await expect(reader.getByText("Root message")).toBeVisible({
    timeout: 15_000,
  });

  // The reader replies through the row's Reply action.
  const row = reader.getByTestId("message-row").first();
  await row.hover();
  await row.getByTestId("reply-button").click();
  await reader.getByTestId("composer-input").fill("Threaded reply");
  await reader.getByTestId("composer-send").click();

  // The author sees the reply, and it carries the root as its parent.
  await expect(author.getByText("Threaded reply")).toBeVisible({
    timeout: 15_000,
  });
  const rows = author.getByTestId("message-row");
  await expect(rows).toHaveCount(2);
  // The reply is indented, which is how the client renders a child row.
  const indented = await rows
    .nth(1)
    .evaluate((el) => el.className.includes("ml-8"));
  expect(indented).toBe(true);

  await first.close();
  await second.close();
});

test("an author without a profile does not borrow someone else's name", async ({
  browser,
}) => {
  // Profiles used to be returned as an array and zipped to authors by index, so
  // one author without metadata shifted every later author's name and avatar.
  const relay = createMockRelay();
  const context = await browser.newContext();
  const page = await context.newPage();
  const alice = "a".repeat(64);
  const bob = "b".repeat(64);
  relay.seed(channelEvent());
  relay.seed({
    id: "from-alice",
    pubkey: alice,
    created_at: 150,
    kind: 9,
    tags: [["h", CHANNEL_ID]],
    content: "Alice speaking without a profile",
    sig: "sig",
  });
  relay.seed({
    id: "from-bob",
    pubkey: bob,
    created_at: 160,
    kind: 9,
    tags: [["h", CHANNEL_ID]],
    content: "Bob speaking with a profile",
    sig: "sig",
  });
  relay.seed({
    id: "bob-profile",
    pubkey: bob,
    created_at: 140,
    kind: 0,
    tags: [],
    content: JSON.stringify({ display_name: "Bob Example" }),
    sig: "sig",
  });
  await relay.install(page);
  await page.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);

  const aliceRow = page
    .getByTestId("message-row")
    .filter({ hasText: "Alice speaking" });
  const bobRow = page
    .getByTestId("message-row")
    .filter({ hasText: "Bob speaking" });

  await expect(bobRow).toContainText("Bob Example");
  await expect(aliceRow).not.toContainText("Bob Example");

  await context.close();
});

test("an accept-then-close relay backs off instead of looping once a second", async ({
  page,
}) => {
  // A relay that accepts the socket and hangs up is the case the backoff exists
  // for. If the counter resets when the socket merely opens, the tab re-opens
  // every second forever and the reader never learns live updates stopped.
  const relay = createMockRelay();
  relay.seed(channelEvent());

  await relay.install(page);
  // Pin the jitter so the retry rhythm is deterministic.
  await page.addInitScript(() => {
    Math.random = () => 0.5;
  });
  await page.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);
  await expect(page.getByTestId("composer-input")).toBeVisible({
    timeout: 15_000,
  });

  relay.setClosingSockets(true);
  relay.dropConnections();
  await page.waitForTimeout(12_000);

  const offsets = relay.liveSubscriptionReqs();
  expect(
    offsets.length,
    "one reconnect per pump, a few times over — not a one-second loop",
  ).toBeLessThan(12);

  const gaps = offsets
    .slice(1)
    .map((time, index) => time - offsets[index])
    .sort((a, b) => b - a);
  // The first retry is ~1s; the next is ~2x, then ~4x. A reset-on-open policy
  // would hold every gap at ~1s and fail this.
  expect(gaps[0]).toBeGreaterThan(3_000);
});

test("a relay that drops the history query reports a failure, not an empty channel", async ({
  page,
}) => {
  // The one-shot client used to resolve whatever it had collected when the
  // socket closed, so a relay that hangs up mid-query looked like a channel
  // with no messages — an authoritative empty result for a failed read.
  const relay = createMockRelay();
  relay.seed(channelEvent());
  // Drop only the timeline read: the rest of the page must still load, so the
  // failure has to show up where the messages would have been.
  relay.setClosingSockets((filter) => filter?.kinds?.includes(9) ?? false);

  await relay.install(page);
  await page.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);

  await expect(page.getByTestId("timeline-load-error")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText(/No messages yet/)).toHaveCount(0);
});

test("a wiki page query the relay drops is reported, not shown as no pages", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(channelEvent());
  // Wiki pages are an addressable event (kind 44001) plus tombstones.
  relay.setClosingSockets((filter) => filter?.kinds?.includes(44001) ?? false);

  await relay.install(page);
  await page.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);
  await page.getByTestId("wiki-toggle").click();

  await expect(page.getByTestId("wiki-load-error")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText(/No pages yet/)).toHaveCount(0);
});

test("an attachment over the limit is refused without an upload attempt", async ({
  page,
}) => {
  // The upload path buffers and hashes the whole file before sending, so an
  // oversized file must be refused up front — otherwise the reader pays the
  // memory and the read time to be told by the relay.
  const relay = createMockRelay();
  relay.seed(channelEvent());
  await relay.install(page);

  const uploads: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/upload")) uploads.push(request.url());
  });

  await page.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);
  await expect(page.getByTestId("composer-input")).toBeVisible({
    timeout: 15_000,
  });

  // 11 MB animated GIF against the 10 MB GIF ceiling.
  await page.locator('input[type="file"]').setInputFiles({
    name: "reaction.gif",
    mimeType: "image/gif",
    buffer: Buffer.alloc(11 * 1024 * 1024),
  });

  await expect(page.getByText(/over the 10 MB limit/)).toBeVisible({
    timeout: 15_000,
  });
  expect(uploads, "no upload should have been started").toEqual([]);
});

test("a relay that answers only after NIP-42 still serves the channel history", async ({
  page,
}) => {
  // Buzz's relay compares the filter against the authenticated identity, so a
  // subscription that arrives before the AUTH handshake finishes is closed with
  // "restricted: ...". The client used to treat that as final. The challenge is
  // delayed past the client's own "send the REQ anyway" window to reproduce the
  // race the relay loses under load.
  const relay = createMockRelay({ requireAuth: true });
  relay.seed(channelEvent());
  relay.seed({
    id: "seed-1",
    pubkey: "b".repeat(64),
    created_at: 120,
    kind: 9,
    tags: [["h", CHANNEL_ID]],
    content: "Seeded before the race",
    sig: "sig",
  });

  await relay.install(page);
  await page.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);

  await expect(page.getByText("Seeded before the race")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("timeline-load-error")).toHaveCount(0);
  // The history query was refused before the handshake and re-issued on the
  // same socket afterwards; without that the query is simply lost.
  expect(relay.queryAuthRetries()).toBeGreaterThan(0);
});

test("a live subscription survives arriving before the AUTH handshake", async ({
  page,
}) => {
  const relay = createMockRelay({ requireAuth: true });
  relay.seed(channelEvent());

  await relay.install(page);
  await page.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);
  await expect(page.getByTestId("composer-input")).toBeVisible({
    timeout: 20_000,
  });

  // The live pump's own REQ is the one that raced the handshake. If it treated
  // the refusal as final the subscription would be dead for the whole session,
  // so a message published now would never arrive.
  relay.deliver({
    id: "live-after-auth",
    pubkey: "b".repeat(64),
    created_at: Math.floor(Date.now() / 1000),
    kind: 9,
    tags: [["h", CHANNEL_ID]],
    content: "Arrived after the handshake",
    sig: "sig",
  });
  await expect(page.getByText("Arrived after the handshake")).toBeVisible({
    timeout: 20_000,
  });
  expect(relay.queryAuthRetries()).toBeGreaterThan(0);
});

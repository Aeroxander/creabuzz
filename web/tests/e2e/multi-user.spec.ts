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

function historyMessage(index: number) {
  return {
    id: `history-${index}`,
    pubkey: "b".repeat(64),
    created_at: 1_000 + index,
    kind: 9,
    tags: [["h", CHANNEL_ID]],
    content: `history message ${index}`,
    sig: "sig",
  };
}

test("older messages can be read past the first page", async ({ page }) => {
  // The timeline only ever asked for the newest page, so everything older than
  // it was unreachable no matter how far the reader scrolled.
  const relay = createMockRelay();
  relay.seed(channelEvent());
  for (let index = 1; index <= 70; index += 1)
    relay.seed(historyMessage(index));

  await relay.install(page);
  await page.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);

  await expect(page.getByText("history message 70")).toBeVisible({
    timeout: 15_000,
  });
  // Exact: "history message 5" also matches "history message 50".
  await expect(
    page.getByText("history message 5", { exact: true }),
  ).toHaveCount(0);

  await page.getByTestId("load-older-messages").click();
  await expect(
    page.getByText("history message 5", { exact: true }),
  ).toBeVisible({
    timeout: 15_000,
  });
  // The whole older page is now reachable, newest page included.
  await expect(page.getByText("history message 70")).toBeVisible();
  // Ten messages older than the first page is a short page: nothing more to ask for.
  await expect(page.getByTestId("load-older-messages")).toHaveCount(0);
});

test("an older page the relay drops is reported, not silently absent", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(channelEvent());
  for (let index = 1; index <= 70; index += 1)
    relay.seed(historyMessage(index));
  // Drop only the backwards page: the first load must still succeed.
  relay.setClosingSockets((filter) => typeof filter?.until === "number");

  await relay.install(page);
  await page.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);
  await expect(page.getByText("history message 70")).toBeVisible({
    timeout: 15_000,
  });

  await page.getByTestId("load-older-messages").click();
  await expect(page.getByTestId("older-messages-error")).toBeVisible({
    timeout: 15_000,
  });
});

test("a wiki save does not write blind when the relay read fails", async ({
  page,
}) => {
  // The save is a read-modify-write of a whole-page snapshot. If the read fails
  // and the write still goes out, the writer silently overwrites whatever a
  // collaborator saved in the meantime.
  const relay = createMockRelay();
  relay.seed(channelEvent());
  relay.seed({
    id: "wiki-page-1",
    pubkey: "b".repeat(64),
    created_at: 100,
    kind: 44001,
    tags: [["d", "shared-page"]],
    content: "Original page body",
    sig: "sig",
  });

  await relay.install(page);
  await page.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);
  await page.getByTestId("wiki-toggle").click();
  await page.getByTestId("wiki-page-shared-page").click();
  const editor = page.getByTestId("wiki-wysiwyg").locator(".ProseMirror");
  await expect(editor).toContainText("Original page body", { timeout: 15_000 });

  // Now the relay stops answering wiki reads, as a flaky relay does.
  relay.setClosingSockets((filter) => filter?.kinds?.includes(44001) ?? false);
  const before = relay.events.filter((event) => event.kind === 44001).length;

  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" plus a local edit");
  // Past the auto-save debounce.
  await page.waitForTimeout(6_000);

  const after = relay.events.filter((event) => event.kind === 44001).length;
  expect(after, "no blind write while the read is failing").toBe(before);
  await expect(page.getByText(/Couldn't auto-save this page/)).toBeVisible({
    timeout: 10_000,
  });
});

test("a wiki delete the relay cannot confirm is not reported as done", async ({
  page,
}) => {
  // Deleting reads the relay first (to learn whether the page is published at
  // all). If that read fails, "Deleted" and "Discarded" are both claims about
  // state nobody checked — and a page the reader believes is gone must not
  // quietly stay live for everyone else.
  const relay = createMockRelay();
  relay.seed(channelEvent());
  relay.seed({
    id: "wiki-page-delete-1",
    pubkey: "b".repeat(64),
    created_at: 100,
    kind: 44001,
    tags: [["d", "doomed-page"]],
    content: "Page to delete",
    sig: "sig",
  });

  await relay.install(page);
  await page.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);
  await page.getByTestId("wiki-toggle").click();
  await page.getByTestId("wiki-page-doomed-page").click();
  await expect(
    page.getByTestId("wiki-wysiwyg").locator(".ProseMirror"),
  ).toContainText("Page to delete", { timeout: 15_000 });

  relay.setClosingSockets((filter) => filter?.kinds?.includes(44001) ?? false);
  /** Anything that would change that page on the relay: a rewrite or a tombstone. */
  const pageWrites = () =>
    relay.events.filter(
      (event) =>
        event.kind === 5 ||
        (event.kind === 44001 &&
          event.tags.some((tag) => tag[0] === "d" && tag[1] === "doomed-page")),
    ).length;
  const before = pageWrites();

  await page.getByTestId("wiki-delete").click();
  await page.getByRole("button", { name: "Delete page" }).click();

  await expect(page.getByText(/the page was not deleted/)).toBeVisible({
    timeout: 15_000,
  });
  expect(page.getByText("Deleted doomed-page")).toBeHidden();
  expect(
    pageWrites(),
    "nothing may be published for a delete that was not confirmed",
  ).toBe(before);
});

test("a mention reaches the bell when the relay enforces its p-gate", async ({
  page,
}) => {
  // The relay authorizes a p-gated read against the *authenticated* pubkey, and
  // every filter here is built from the durable identity. A client that
  // authenticates as anything else — a page-lifetime key — gets its mention
  // query refused while the connection still looks healthy: the bell just never
  // rings.
  const relay = createMockRelay({ requireAuth: true, enforcePGate: true });
  relay.seed(channelEvent());
  // The relay compares `#p` against the pubkey that signed the handshake, so the
  // filter has to name the identity the app actually holds.
  const meNsec = "dd".repeat(32);
  const me = getPublicKey(
    Uint8Array.from(meNsec.match(/.{2}/g) ?? [], (byte) =>
      Number.parseInt(byte, 16),
    ),
  );

  await page.addInitScript(
    ([nsec]) => window.localStorage.setItem("buzz.identity.nsec", nsec),
    [meNsec],
  );
  await relay.install(page);
  await page.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);
  await expect(page.getByTestId("composer-input")).toBeVisible({
    timeout: 15_000,
  });

  relay.deliver({
    id: "mention-1",
    pubkey: "b".repeat(64),
    created_at: Math.floor(Date.now() / 1000),
    kind: 9,
    tags: [
      ["h", CHANNEL_ID],
      ["p", me],
    ],
    content: "hey @you",
    sig: "sig",
  });

  // `requireAuth` challenges on demand, so the poll's first attempt is refused
  // and must be retried after the handshake — and the retry has to be signed by
  // the identity the filter names, or the gate refuses it again.
  await expect(page.getByTestId("notifications-bell")).toContainText(/[1-9]/, {
    timeout: 30_000,
  });
});

test("a locked passkey identity does not mint a second key", async ({
  page,
}) => {
  // Identity precedence ends with "create a key if there is none". For a reader
  // whose identity is a passkey, falling through that path mints a second,
  // durable identity and signs with it, so reads and writes would belong to
  // different people. A stored-but-locked passkey must fail instead.
  const relay = createMockRelay({ requireAuth: true, enforcePGate: true });
  relay.seed(channelEvent());

  await page.addInitScript(() => {
    // A registered passkey, none of it unlocked this session (the fields are
    // public: credential id, salt, pubkey — the key lives in memory only).
    window.localStorage.setItem("buzz.passkey.credentialId", "cred-1");
    window.localStorage.setItem("buzz.passkey.salt", "c2FsdA");
    window.localStorage.setItem("buzz.passkey.pubkey", "e".repeat(64));
    window.localStorage.setItem("buzz.passkey.mode", "prf");
    window.localStorage.removeItem("buzz.identity.nsec");
  });
  await relay.install(page);
  await page.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);

  await page.waitForTimeout(4_000);
  const stored = await page.evaluate(() =>
    window.localStorage.getItem("buzz.identity.nsec"),
  );
  expect(
    stored,
    "no second identity may be created for a passkey reader",
  ).toBeNull();

  // Signing is refused while the passkey is locked, and the refusal is shown —
  // the shell must not come up as an identity the reader does not own.
  await expect(page.getByRole("alert").first()).toBeVisible({
    timeout: 20_000,
  });
});

test("a community with more channels than one page can be paged", async ({
  page,
}) => {
  // The sidebar asked for one page of channel metadata and had no way to ask
  // for more, so every channel past the first 200 was unreachable — invisible,
  // with nothing on screen saying so.
  const relay = createMockRelay();
  relay.seed(channelEvent());
  for (let index = 1; index <= 210; index += 1) {
    relay.seed({
      id: `channel-meta-${index}`,
      pubkey: "b".repeat(64),
      created_at: 2_000 + index,
      kind: 39000,
      tags: [
        ["d", `chan-${String(index).padStart(3, "0")}`],
        ["name", `room-${String(index).padStart(3, "0")}`],
      ],
      content: "",
      sig: "sig",
    });
  }

  await relay.install(page);
  await page.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);

  await expect(page.getByTestId("channel-room-210")).toBeVisible({
    timeout: 15_000,
  });
  // The oldest ten are past the first page.
  await expect(page.getByTestId("channel-room-001")).toHaveCount(0);

  await page.getByTestId("load-more-channels").click();
  await expect(page.getByTestId("channel-room-001")).toBeVisible({
    timeout: 15_000,
  });
  // A short page ends the walk: no button left to press.
  await expect(page.getByTestId("load-more-channels")).toHaveCount(0);
});

test("an archived community explains why its channels do not load", async ({
  page,
}) => {
  // Archived communities keep their directory entry but their channel reads
  // fail. Without the explanation the reader sees a relay error for a community
  // that simply no longer serves channels.
  const relay = createMockRelay();
  relay.setClosingSockets((filter) => filter?.kinds?.includes(39000) ?? false);
  await relay.install(page);
  await page.route("**/communities", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        communities: [
          {
            host: "retired.example.com",
            name: "Retired",
            description: "No longer served.",
            icon: null,
            member_count: 4,
            archived: true,
          },
        ],
      }),
    });
  });

  await page.goto(`/c/retired.example.com?channel=${CHANNEL_ID}`);
  await expect(page.getByText(/This community is archived/)).toBeVisible({
    timeout: 20_000,
  });
});

test("reactions and edits do not appear as threaded replies", async ({
  page,
}) => {
  // The thread tree renders every event whose `e` tag names the parent, and a
  // reaction, an edit and a deletion all carry that tag. They are overlays on
  // the message they target — a reaction pill, replaced text, a deletion
  // marker — not replies.
  const relay = createMockRelay();
  relay.seed(channelEvent());
  const message = "message-1";
  relay.seed({
    id: message,
    pubkey: "b".repeat(64),
    created_at: 150,
    kind: 9,
    tags: [["h", CHANNEL_ID]],
    content: "The one message",
    sig: "sig",
  });
  relay.seed({
    id: "reaction-1",
    pubkey: "c".repeat(64),
    created_at: 160,
    kind: 7,
    tags: [
      ["h", CHANNEL_ID],
      ["e", message],
    ],
    content: "👍",
    sig: "sig",
  });
  relay.seed({
    id: "edit-1",
    pubkey: "b".repeat(64),
    created_at: 170,
    kind: 40003,
    tags: [
      ["h", CHANNEL_ID],
      ["e", message],
    ],
    content: "The edited message",
    sig: "sig",
  });

  // A second message, and a deletion tombstone for it.
  relay.seed({
    id: "message-2",
    pubkey: "b".repeat(64),
    created_at: 180,
    kind: 9,
    tags: [["h", CHANNEL_ID]],
    content: "Doomed message",
    sig: "sig",
  });
  relay.seed({
    id: "deletion-1",
    pubkey: "b".repeat(64),
    created_at: 190,
    kind: 5,
    tags: [
      ["h", CHANNEL_ID],
      ["e", "message-2"],
    ],
    content: "",
    sig: "sig",
  });

  await relay.install(page);
  await page.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);

  await expect(page.getByText("The edited message")).toBeVisible({
    timeout: 15_000,
  });
  // Two messages — one edited, one deleted — and no extra rows for the
  // reaction, the edit, or the tombstone.
  await expect(page.getByTestId("message-row")).toHaveCount(2);
  await expect(page.getByText("Doomed message")).toHaveCount(0);
  // The pill, not the quick-react button: the row contains both.
  await expect(
    page.getByTestId("message-row").first().getByText("👍 1"),
  ).toBeVisible();
});

test("a wiki page has an address that survives a reload", async ({ page }) => {
  // Knowledge objects had no address at all: a decision on a page could not be
  // linked to, and a reload dropped the surface back to the channel.
  const relay = createMockRelay();
  relay.seed(channelEvent());
  relay.seed({
    id: "wiki-page-1",
    pubkey: "b".repeat(64),
    created_at: 100,
    kind: 44001,
    tags: [["d", "release-plan"]],
    content: "The release plan",
    sig: "sig",
  });

  await relay.install(page);
  // Read the clipboard rather than trusting the toast: it proves the copied URL
  // carries both parameters.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/c/alpha.example.com?view=wiki&page=release-plan`);

  // The URL selects the page, not just the wiki surface.
  await expect(page.getByTestId("wiki-page-release-plan")).toHaveAttribute(
    "class",
    /bg-black\/10/,
    { timeout: 20_000 },
  );

  // Reloading keeps both the surface and the page.
  await page.reload();
  await expect(
    page.getByTestId("wiki-wysiwyg").locator(".ProseMirror"),
  ).toContainText("The release plan", { timeout: 20_000 });

  // And the page offers its own link, which carries both parameters.
  await page.getByTestId("wiki-copy-link").click();
  await expect(page.getByText("Page link copied")).toBeVisible({
    timeout: 10_000,
  });
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("view=wiki");
  expect(copied).toContain("page=release-plan");
});

test("search covers wiki pages and a hit opens the page", async ({ page }) => {
  // Search only ever queried channel-scoped conversation, so a decision written
  // on a wiki page was invisible to Cmd+K. Wiki pages are community-global, so
  // they need their own (channel-less) filter.
  const relay = createMockRelay();
  relay.seed(channelEvent());
  relay.seed({
    id: "wiki-page-search-1",
    pubkey: "b".repeat(64),
    created_at: Math.floor(Date.now() / 1000),
    kind: 44001,
    tags: [["d", "treasury-policy"]],
    content: "The treasury policy: allowances and a wind-down path.",
    sig: "sig",
  });
  await relay.install(page);

  const filters: unknown[] = [];
  await page.route("**/query", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "[]");
    filters.push(body);
    // Only the channel-less filter can legitimately return a wiki page: reply to
    // it, and leave the channel-scoped one empty.
    const wikiOnly = (Array.isArray(body) ? body : []).filter(
      (filter: { kinds?: number[] }) => filter.kinds?.includes(44001),
    );
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        wikiOnly.length > 0
          ? [
              {
                id: "wiki-page-search-1",
                pubkey: "b".repeat(64),
                created_at: Math.floor(Date.now() / 1000),
                kind: 44001,
                tags: [["d", "treasury-policy"]],
                content:
                  "The treasury policy: allowances and a wind-down path.",
                sig: "sig",
              },
            ]
          : [],
      ),
    });
  });

  await page.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);
  await page.getByTestId("search-input").fill("treasury");
  await page.keyboard.press("Enter");

  const hit = page.getByTestId("search-result").first();
  await expect(hit).toBeVisible({ timeout: 20_000 });
  await expect(hit).toContainText("wiki page");
  await expect(hit).toContainText("treasury policy");

  // Two filters were sent: the channel-scoped one and the knowledge one.
  expect(
    filters.some((batch) =>
      (Array.isArray(batch) ? batch : []).some(
        (filter: { kinds?: number[]; "#h"?: string[] }) =>
          filter.kinds?.includes(44001) && filter["#h"] === undefined,
      ),
    ),
    "search must ask for community-global knowledge as well as channel chat",
  ).toBe(true);

  // Following the hit lands on the page itself.
  await hit.click();
  await expect(page).toHaveURL(/view=wiki/);
  await expect(page).toHaveURL(/page=treasury-policy/);
});

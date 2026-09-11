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

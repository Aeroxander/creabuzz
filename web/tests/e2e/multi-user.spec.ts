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

import { expect, test } from "@playwright/test";

import { createMockRelay } from "./mock-relay";

/**
 * Screenshot harness for the web client: the desktop equivalent of
 * `just desktop-screenshot`. Seeded with the same conversation the desktop
 * harness uses, so the two can be compared side by side when reviewing look and
 * feel. PNGs land in `test-results/` (gitignored).
 */

const CHANNEL_ID = "0f0f0f0f-1111-2222-3333-444444444444";

const MESSAGES = [
  "Morning all — the CCA sale parameters are in the launchpad doc, review welcome.",
  "I pushed the vesting table to the wiki. Cliff at 3 months, then linear.",
  "Heads up: relay deploy at 16:00 UTC, expect a reconnect blip.",
  "Nice work on the treasury view — much easier to read now.",
];

test("the channel view renders a conversation", async ({ page }) => {
  const relay = createMockRelay();
  relay.seed({
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
  });
  MESSAGES.forEach((content, index) => {
    relay.seed({
      id: `msg-${index}`,
      pubkey: "b".repeat(64),
      created_at: 1_000 + index,
      kind: 9,
      tags: [["h", CHANNEL_ID]],
      content,
      sig: "sig",
    });
  });
  await relay.install(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);
  await expect(page.getByText(MESSAGES[0])).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: "test-results/web-channel.png" });
});

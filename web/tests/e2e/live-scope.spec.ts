import { expect, test } from "@playwright/test";

import { createMockRelay } from "./mock-relay";

/**
 * Live updates follow the real server's routing (`buzz-relay/src/subscription.rs`, mirrored by the mock): a record kept
 * under a room reaches only subscriptions tied to that room by `#h`. A view that follows records which may be kept in a
 * room or in none must hold both kinds of subscription, or the room's records never arrive while it is open.
 */

const CHANNEL = "0f0f0f0f-1111-2222-3333-555555555555";

test("a task tied to a room arrives live in the agents view", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed({
    id: `meta-${CHANNEL}`,
    pubkey: "b".repeat(64),
    created_at: 100,
    kind: 39000,
    tags: [["d", CHANNEL], ["name", "general"], ["public"], ["t", "stream"]],
    content: "",
    sig: "sig",
  });
  await relay.install(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/c/alpha.example.com?channel=${CHANNEL}`);
  await page.getByTestId("content-pane").waitFor();
  await page.getByTestId("fleet-toggle").click();

  await expect
    .poll(() =>
      relay
        .subscriptionFilters()
        .some(
          (f) =>
            f.kinds?.includes(44011) &&
            (f["#h"] as string[] | undefined)?.includes(CHANNEL),
        ),
    )
    .toBe(true);
  relay.deliver({
    id: "7a".repeat(32),
    pubkey: "c".repeat(64),
    created_at: Math.floor(Date.now() / 1000),
    kind: 44011,
    tags: [
      ["d", "room-task-1"],
      ["h", CHANNEL],
    ],
    content: JSON.stringify({ title: "Tidy the room's wiki", status: "open" }),
    sig: "sig",
  });
  await expect(page.getByText("Tidy the room's wiki")).toBeVisible();
});

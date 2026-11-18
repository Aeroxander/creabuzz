import { expect, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { COMMUNITY_HOST, createMockRelay } from "./mock-relay";

/**
 * Lists that refresh themselves must stop. The workflow runs list polls every
 * ten seconds, but only for fifteen minutes after a person last asked: then it
 * says "Auto-refresh paused" and waits for the Refresh button. A timer tick
 * counting as "a person asked" would keep it polling forever, which the list
 * showed before this was fixed.
 */

const NSEC = "33".repeat(32);
const ME = getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);

const channel = {
  id: "chan-1",
  pubkey: ME,
  created_at: 100,
  kind: 39000,
  tags: [
    ["d", "0f0f0f0f-1111-2222-3333-444444444444"],
    ["name", "general"],
  ],
  content: "",
  sig: "sig",
};

test("the workflow runs list pauses its own refreshing after fifteen minutes, and Refresh resumes it", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(channel);
  await page.clock.install();
  await relay.install(page);
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
  }, NSEC);
  await page.goto(`/c/${COMMUNITY_HOST}`);
  await page.getByTestId("content-pane").waitFor();

  await page.getByRole("button", { name: "Notifications" }).click();
  await page.getByTestId("open-workflow-runs").click();
  const panel = page.getByTestId("workflow-runs-panel");
  await expect(panel).toContainText("Recent runs");

  // Minute by minute, every tick a poll. Some of the page's own timers fire on
  // the mock relay's closed sockets while time is faked and throw; the clock
  // still advances, so keep going until the list has paused (or half an hour
  // has passed, which is the failure).
  for (let minute = 0; minute < 30; minute += 1) {
    await page.clock.runFor("01:00").catch(() => {});
    if (await panel.getByText("Auto-refresh paused").isVisible()) break;
  }
  await expect(panel).toContainText("Auto-refresh paused");

  await page.getByTestId("workflow-runs-refresh").click();
  await expect(panel).toContainText("Recent runs");
});

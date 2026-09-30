import { expect, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { createMockRelay } from "./mock-relay";

/**
 * The browser-hosted fleet agent, end to end.
 *
 * The tab agent is the only fleet member that runs in the page, and before
 * this file it had no behavioural coverage at all — the agents view was only
 * checked for accessibility. These tests drive the real path: start it,
 * hand it a relay task, and read what it publishes back.
 */

const CHANNEL_ID = "0f0f0f0f-1111-2222-3333-444444444444";
const AGENT_NSEC = "ab".repeat(32);
const AGENT_PUBKEY = getPublicKey(
  Uint8Array.from(AGENT_NSEC.match(/.{2}/g).map((b) => Number.parseInt(b, 16))),
);
const HUMAN_PUBKEY = "c".repeat(64);
const TASK_ID = "task-browser-1";

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

/** A task row addressed to the tab agent, as the board publishes one. */
function assignedTask() {
  return {
    id: "task-event-1",
    pubkey: HUMAN_PUBKEY,
    created_at: Math.floor(Date.now() / 1000),
    kind: 44011,
    tags: [
      ["d", TASK_ID],
      ["h", CHANNEL_ID],
      ["p", AGENT_PUBKEY],
    ],
    content: JSON.stringify({
      title: "Summarise the release notes",
      description: "Keep it to three bullets.",
      status: "open",
    }),
    sig: "sig",
  };
}

/** Start the tab agent on the given page, with a mocked gateway. */
async function startAgent(page: import("@playwright/test").Page) {
  await page.route("**/llm/chat/completions", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        choices: [{ message: { content: "Reply from the gateway" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    });
  });
  await page.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);
  await page.getByTestId("fleet-toggle").click();
  await page.getByTestId("browser-agent-toggle").click();
  await expect(page.getByTestId("browser-agent-toggle")).toContainText(
    /running|stop/i,
    { timeout: 15_000 },
  );
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([nsec]) => window.localStorage.setItem("buzz.agent.nsec", nsec),
    [AGENT_NSEC],
  );
});

test("the tab agent announces itself to the relay when started", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(channelEvent());
  await relay.install(page);

  await startAgent(page);

  // Capabilities are what make it a fleet member rather than a tab.
  const announced = await expect
    .poll(
      () =>
        relay.events.some(
          (event) =>
            event.kind === 44010 &&
            event.pubkey === AGENT_PUBKEY &&
            event.tags.some((tag) => tag[0] === "d" && tag[1] === AGENT_PUBKEY),
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
  expect(announced).toBeUndefined();
});

test("the tab agent works a task it was assigned and reports the outcome", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(channelEvent());
  await relay.install(page);

  await startAgent(page);
  // Watch the channel the agent answers in, not the agents pane.
  await page.getByTestId("fleet-toggle").click();
  await expect(page.getByTestId("composer-input")).toBeVisible();
  relay.deliver(assignedTask());

  // It answers in the channel that the task came from, and the board sees the
  // status rows the answer claims.
  await expect(
    page.getByText(/Working: Summarise the release notes/),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Done: Summarise the release notes/)).toBeVisible(
    { timeout: 20_000 },
  );
  await expect(page.getByText("Reply from the gateway")).toBeVisible({
    timeout: 20_000,
  });

  const statuses = relay.events
    .filter((event) => event.kind === 44011 && event.pubkey === AGENT_PUBKEY)
    .map((event) => JSON.parse(event.content).status);
  expect(statuses).toEqual(["in_progress", "done"]);
});

test("a refused status row is reported instead of claimed as done", async ({
  page,
}) => {
  const relay = createMockRelay({
    refuse: (event) =>
      event.kind === 44011 && event.pubkey === AGENT_PUBKEY
        ? "restricted: not a channel member"
        : null,
  });
  relay.seed(channelEvent());
  await relay.install(page);

  let gatewayCalls = 0;
  await page.route("**/llm/chat/completions", async (route) => {
    gatewayCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        choices: [{ message: { content: "never asked" } }],
      }),
    });
  });

  await page.goto(`/c/alpha.example.com?channel=${CHANNEL_ID}`);
  await page.getByTestId("fleet-toggle").click();
  await page.getByTestId("browser-agent-toggle").click();
  await expect(page.getByTestId("browser-agent-toggle")).toContainText(
    /running|stop/i,
    { timeout: 15_000 },
  );
  await page.getByTestId("fleet-toggle").click();
  await expect(page.getByTestId("composer-input")).toBeVisible();

  relay.deliver(assignedTask());

  // The board never accepted the task moving, so the agent must say so rather
  // than run the work and post a "Done" the board cannot show. It must also not
  // spend a gateway call on a task it cannot record.
  await expect(page.getByText(/Task failed: restricted/)).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText(/Done: Summarise/)).toHaveCount(0);
  expect(gatewayCalls).toBe(0);
  expect(
    relay.events.filter(
      (event) => event.kind === 44011 && event.pubkey === AGENT_PUBKEY,
    ),
  ).toEqual([]);
});

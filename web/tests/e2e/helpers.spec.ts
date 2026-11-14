import { expect, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { COMMUNITY_HOST, createMockRelay } from "./mock-relay";

/**
 * A project's helpers: the seats a template gives them, running one in this
 * tab under its own name and prompt, and what the three ways to run a helper
 * say about this server. The server and the AI service are mocks; what is
 * checked is what the page publishes and what it shows.
 */

const CHANNEL_ID = "0f0f0f0f-1111-2222-3333-444444444444";
const OWNER_NSEC = "55".repeat(32);
const OWNER = getPublicKey(
  Uint8Array.from(OWNER_NSEC.match(/.{2}/g) ?? [], (b) =>
    Number.parseInt(b, 16),
  ),
);
const AGENT_NSEC = "ab".repeat(32);
const AGENT = getPublicKey(
  Uint8Array.from(AGENT_NSEC.match(/.{2}/g) ?? [], (b) =>
    Number.parseInt(b, 16),
  ),
);
const NOW = () => Math.floor(Date.now() / 1000);

const channel = {
  id: "chan-1",
  pubkey: "b".repeat(64),
  created_at: 100,
  kind: 39000,
  tags: [
    ["d", CHANNEL_ID],
    ["name", "writers-room"],
  ],
  content: "",
  sig: "sig",
};

function orgNode(id: string, body: Record<string, unknown>) {
  return {
    id: `org-${id}`,
    pubkey: OWNER,
    created_at: 200,
    kind: 37010,
    tags: [
      ["d", id],
      ["name", String(body.name)],
    ],
    content: JSON.stringify({ v: 1, holders: [], agentSeats: [], ...body }),
    sig: "sig",
  };
}

const root = orgNode("root", {
  name: "Studio",
  kind: "role",
  holders: [OWNER],
  scope: { readBelow: true, assignBelow: true, canGrant: ["read", "task"] },
});
const seat = orgNode("seat-writer", {
  name: "The Writer",
  kind: "agent_seat",
  parent: "root",
  scope: { readBelow: false, assignBelow: false, canGrant: [] },
});
const persona = {
  id: "persona-writer",
  pubkey: OWNER,
  created_at: 200,
  kind: 30175,
  tags: [["d", "writer"]],
  content: JSON.stringify({
    display_name: "The Writer",
    system_prompt: "You write stories. SENTINEL-PROMPT",
  }),
  sig: "sig",
};

async function open(
  page: import("@playwright/test").Page,
  relay: ReturnType<typeof createMockRelay>,
  gateway: "available" | "missing" = "available",
) {
  const prompts: string[] = [];
  // Installed first: the last route registered wins, and the mock server
  // would otherwise answer the AI service path with a 404.
  await relay.install(page);
  // The channel history a helper reads before it answers.
  await page.route("**/query", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "[]",
    }),
  );
  await page.route("**/llm/chat/completions", async (route) => {
    if (gateway === "missing") {
      await route.fulfill({ status: 404, body: "not found" });
      return;
    }
    const body = route.request().postData() ?? "";
    if (body !== "{}") prompts.push(body);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        choices: [{ message: { content: "The first scene opens at dawn." } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    });
  });
  await page.addInitScript(
    ([owner, agent]) => {
      window.localStorage.setItem("buzz.identity.nsec", owner);
      window.localStorage.setItem("buzz.agent.nsec", agent);
    },
    [OWNER_NSEC, AGENT_NSEC],
  );
  await page.goto(`/c/${COMMUNITY_HOST}?channel=${CHANNEL_ID}`);
  await page.getByTestId("content-pane").waitFor();
  await page.getByTestId("fleet-toggle").click();
  return prompts;
}

function seeded(options?: Parameters<typeof createMockRelay>[0]) {
  const relay = createMockRelay(options);
  for (const event of [channel, root, seat, persona]) relay.seed(event);
  return relay;
}

test("a project's helper runs in the tab under its own name, takes its seat, and answers its own mentions", async ({
  page,
}) => {
  const relay = seeded();
  const prompts = await open(page, relay);

  // The seat is open, and the three ways are laid out with this server's facts.
  await expect(page.getByTestId("helper-seat-writer-status")).toHaveText(
    "Open seat",
  );
  await expect(page.getByTestId("helper-way-tab-state")).toHaveText("Ready");
  await expect(page.getByTestId("helper-way-server-state")).toHaveText(
    "Not available",
  );
  // This build has no desktop app, so the computer is not offered (and nothing links to another product's downloads).
  await expect(page.getByTestId("helper-way-computer-state")).toHaveCount(0);
  await expect(page.getByText("Get the desktop app")).toHaveCount(0);

  await page.getByTestId("seat-run-writer").click();
  await expect(page.getByTestId("helper-seat-writer-status")).toHaveText(
    "The Writer · online",
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("helper-way-tab-status")).toContainText(
    "The Writer is running in this tab",
  );

  // It announced itself under the helper's name, and the owner put it in the seat.
  const announced = relay.events.find(
    (e) => e.kind === 44010 && e.pubkey === AGENT,
  );
  expect(JSON.parse(announced?.content ?? "{}").name).toBe("The Writer");
  const filled = relay.events
    .filter(
      (e) =>
        e.kind === 37010 &&
        e.tags.some((t) => t[0] === "d" && t[1] === "seat-writer"),
    )
    .sort((a, b) => b.created_at - a.created_at)[0];
  expect(filled.pubkey).toBe(OWNER);
  expect(JSON.parse(filled.content).agentSeats).toEqual([AGENT]);
  expect(JSON.parse(filled.content).parent).toBe("root");

  // In the channel, a mention of the helper is answered with its own prompt...
  await page.getByTestId("fleet-toggle").click();
  await expect(page.getByTestId("composer-input")).toBeVisible();
  relay.deliver({
    id: "mention-1",
    pubkey: OWNER,
    created_at: NOW(),
    kind: 9,
    tags: [["h", CHANNEL_ID]],
    content: "@The Writer how should the first scene open?",
    sig: "sig",
  });
  await expect(page.getByText("The first scene opens at dawn.")).toBeVisible({
    timeout: 30_000,
  });
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("SENTINEL-PROMPT");
  expect(prompts[0]).toContain("You are The Writer");

  // ...and the generic assistant's name no longer reaches it.
  relay.deliver({
    id: "mention-2",
    pubkey: OWNER,
    created_at: NOW(),
    kind: 9,
    tags: [["h", CHANNEL_ID]],
    content: "@buzz-tab are you there?",
    sig: "sig",
  });
  await page.waitForTimeout(2_000);
  expect(prompts).toHaveLength(1);
});

test("when the server has no AI service, the tab way says so and no helper can be started there", async ({
  page,
}) => {
  const relay = seeded();
  await open(page, relay, "missing");
  await expect(page.getByTestId("helper-way-tab-state")).toHaveText(
    "Not available",
  );
  await expect(page.getByTestId("helper-way-tab-status")).toContainText(
    "no AI service set up",
  );
  await expect(page.getByTestId("seat-run-writer")).toBeDisabled();
});

test("a helper running on the server is reported by its place, not guessed", async ({
  page,
}) => {
  const relay = seeded();
  relay.seed({
    id: "worker-1",
    pubkey: "d".repeat(64),
    created_at: NOW(),
    kind: 44010,
    tags: [["d", "worker"]],
    content: JSON.stringify({
      name: "Studio Worker",
      runtype: "sandbox",
      status: "available",
      tools: [],
      heartbeat: NOW(),
    }),
    sig: "sig",
  });
  await open(page, relay);
  await expect(page.getByTestId("helper-way-server-state")).toHaveText(
    "Running",
  );
  await expect(page.getByTestId("helper-way-server-status")).toContainText(
    "Studio Worker is running on this server",
  );
});

test("a seat the server will not fill is said so, and the helper keeps running", async ({
  page,
}) => {
  const relay = seeded({
    refuse: (event) =>
      event.kind === 37010 && event.pubkey === OWNER
        ? "restricted: only a team lead can change the team"
        : null,
  });
  await open(page, relay);

  await page.getByTestId("seat-run-writer").click();
  await expect(page.getByTestId("helper-seat-problem")).toContainText(
    "The Writer is running, but couldn't take its seat",
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("helper-seat-problem")).toContainText(
    "only a team lead",
  );
  // Running is not the same as seated: the tab still says it is working.
  await expect(page.getByTestId("helper-way-tab-status")).toContainText(
    "The Writer is running in this tab",
  );
  await expect(page.getByTestId("helper-seat-writer-status")).not.toHaveText(
    "The Writer · online",
  );
});

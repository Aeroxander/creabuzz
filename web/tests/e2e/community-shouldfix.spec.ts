import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { expectAccessible } from "../helpers/a11y";
import { PHONE } from "../helpers/layout";
import { createMockRelay } from "./mock-relay";

/**
 * The community screen audit's fixes (2026-10-30): what a room offers depends on who is reading it, a room shows only
 * its own notes, and community search finds board posts and can be left on a phone.
 */

const NSEC = "56".repeat(32);
const ME = getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);
const SERVER = "9".repeat(64);
const ALICE = "a".repeat(64);
const GENERAL = "0f0f0f0f-1111-2222-3333-444444444444";
const DESIGN = "0f0f0f0f-1111-2222-3333-555555555555";
const SUPPORTERS = "0f0f0f0f-1111-2222-3333-666666666666";
const POST = "e".repeat(64);
const now = () => Math.floor(Date.now() / 1000);

function room(id: string, name: string, extra: string[][] = []) {
  return {
    id: `meta-${name}`,
    pubkey: SERVER,
    kind: 39000,
    created_at: 100,
    tags: [["d", id], ["name", name], ...extra],
    content: "",
    sig: "sig",
  };
}

function createdNote(roomId: string, actor: string, at: number) {
  return {
    id: `note-${roomId.slice(-4)}`,
    pubkey: SERVER,
    kind: 40099,
    created_at: at,
    tags: [["h", roomId]],
    content: JSON.stringify({ type: "channel_created", actor }),
    sig: "sig",
  };
}

function community(role: "owner" | "member" | null) {
  const relay = createMockRelay();
  relay.seed(room(GENERAL, "general"));
  relay.seed(room(DESIGN, "design"));
  relay.seed(room(SUPPORTERS, "supporters", [["t", "forum"]]));
  if (role) {
    relay.seed({
      id: "member-list",
      pubkey: SERVER,
      created_at: 200,
      kind: 13534,
      tags: [["member", ME, role]],
      content: "",
      sig: "sig",
    });
  }
  relay.seed(createdNote(GENERAL, ALICE, now() - 600));
  relay.seed(createdNote(DESIGN, ME, now() - 300));
  relay.seed({
    id: "hello",
    pubkey: ALICE,
    kind: 9,
    created_at: now() - 120,
    tags: [["h", GENERAL]],
    content: "Hello from general",
    sig: "sig",
  });
  relay.seed({
    id: POST,
    pubkey: ALICE,
    kind: 45001,
    created_at: now() - 60,
    tags: [["h", SUPPORTERS]],
    content: "# Why we back Creaton\n\nThe Creaton crew ships every week.",
    sig: "sig",
  });
  return relay;
}

/** The server's search, answered from what the mock relay holds: kinds, rooms and words as the real one matches them. */
async function answerSearch(page: Page, relay: ReturnType<typeof community>) {
  await page.route("**/query", async (route) => {
    const filters = JSON.parse(route.request().postData() ?? "[]") as {
      kinds?: number[];
      "#h"?: string[];
      search?: string;
    }[];
    const hits = relay.events.filter((event) =>
      filters.some((filter) => {
        if (!filter.search) return false;
        if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
        const h = event.tags.find((t) => t[0] === "h")?.[1];
        if (filter["#h"] ? !h || !filter["#h"].includes(h) : h) return false;
        return event.content
          .toLowerCase()
          .includes(filter.search.toLowerCase());
      }),
    );
    await route.fulfill({ json: hits });
  });
}

async function open(
  page: Page,
  relay: ReturnType<typeof community>,
  { signedIn, moderator }: { signedIn: boolean; moderator: boolean },
) {
  await page.route("**/moderation/reports*", (route) =>
    moderator
      ? route.fulfill({ json: { reports: [] } })
      : route.fulfill({ status: 403, body: "" }),
  );
  await relay.install(page);
  if (signedIn) {
    await page.addInitScript((nsec) => {
      window.localStorage.setItem("buzz.identity.nsec", nsec);
      window.localStorage.setItem("buzz.identity.backedUp", "1");
    }, NSEC);
  }
  await page.goto(`/c/alpha.example.com?channel=${GENERAL}`);
  await expect(page.getByText("Hello from general")).toBeVisible({
    timeout: 20_000,
  });
}

test("a visitor reads a room and is offered nothing to add or make", async ({
  page,
}) => {
  await open(page, community(null), { signedIn: false, moderator: false });
  for (const testId of [
    "channel-add-agent",
    "channel-add-people",
    "channel-new-work",
    "new-channel",
    "new-board",
  ]) {
    await expect(page.getByTestId(testId)).toHaveCount(0);
  }
});

test("a member can share a room, and only whoever runs the community adds AI helpers and tasks", async ({
  page,
}) => {
  await open(page, community("member"), { signedIn: true, moderator: false });
  const share = page.getByTestId("channel-add-people");
  await expect(share).toContainText("Share this room");
  await expect(share).toContainText("Copy a link to this room.");
  await expect(page.getByTestId("channel-add-agent")).toHaveCount(0);
  await expect(page.getByTestId("channel-new-work")).toHaveCount(0);
  // Signed in, they can still start a room or a board.
  await expect(page.getByTestId("new-channel")).toBeVisible();
});

test("the owner adds AI helpers and tasks, and Add people opens the community's invites", async ({
  page,
}) => {
  await open(page, community("owner"), { signedIn: true, moderator: false });
  await expect(page.getByTestId("channel-add-agent")).toContainText(
    "Add an AI helper",
  );
  await expect(page.getByTestId("channel-new-work")).toHaveText("New task");
  const add = page.getByTestId("channel-add-people");
  await expect(add).toContainText("Make an invite link.");
  await add.click();
  await expect(page.getByTestId("people-section")).toBeVisible({
    timeout: 20_000,
  });
});

test("a moderator the member list does not name as owner or admin is not offered setup", async ({
  page,
}) => {
  await open(page, community(null), { signedIn: true, moderator: true });
  await expect(page.getByTestId("moderation-toggle")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("wiki-toggle")).toBeVisible();
  await expect(page.getByTestId("start-project-toggle")).toHaveCount(0);
});

test("a room shows only its own notes: the last room's never carry over", async ({
  page,
}) => {
  await open(page, community("member"), { signedIn: true, moderator: false });
  const pane = page.getByTestId("content-pane");
  await expect(pane.getByText(/created this channel/)).toHaveCount(1);
  await page.getByTestId("channel-design").click();
  await expect(pane.getByText("You created this channel")).toBeVisible({
    timeout: 20_000,
  });
  await expect(pane.getByText(/created this channel/)).toHaveCount(1);
  await expect(pane.getByText("Hello from general")).toHaveCount(0);
});

test("community search finds a board post and opens it", async ({ page }) => {
  const relay = community("member");
  await answerSearch(page, relay);
  await open(page, relay, { signedIn: true, moderator: false });
  await page.getByTestId("search-input").fill("creaton");
  const hit = page.getByTestId("search-result");
  await expect(hit).toHaveCount(1, { timeout: 20_000 });
  await expect(hit).toContainText("supporters · board post");
  await expect(hit).toContainText("Why we back Creaton");
  await expect(hit).not.toContainText("# Why");
  await hit.click();
  await expect(page).toHaveURL(new RegExp(`post=${POST}`));
  await expect(page).toHaveURL(new RegExp(`channel=${SUPPORTERS}`));
});

test("on a phone the search results keep the query, and Back leaves them", async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  const relay = community("member");
  await answerSearch(page, relay);
  await open(page, relay, { signedIn: true, moderator: false });
  await page.getByTestId("open-channel-list").click();
  await page.getByTestId("search-input").fill("creaton");
  const box = page.getByTestId("search-phone-input");
  await expect(box).toBeVisible();
  await expect(box).toHaveValue("creaton");
  await expect(page.getByTestId("search-result")).toHaveCount(1, {
    timeout: 20_000,
  });
  await expectAccessible(page, "community search on a phone");
  await page.getByTestId("search-back").click();
  await expect(page.getByTestId("search-phone-input")).toHaveCount(0);
  await expect(page.getByText("Hello from general")).toBeVisible();
});

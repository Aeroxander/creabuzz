import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { expectAccessible } from "../helpers/a11y";
import { PHONE } from "../helpers/layout";
import { COMMUNITY_HOST, createMockRelay } from "./mock-relay";

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
  await page.goto(`/c/${COMMUNITY_HOST}?channel=${GENERAL}`);
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
  await expect(pane.getByText(/created this room/)).toHaveCount(1);
  await page.getByTestId("channel-design").click();
  await expect(pane.getByText("You created this room")).toBeVisible({
    timeout: 20_000,
  });
  await expect(pane.getByText(/created this room/)).toHaveCount(1);
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

/*
 * The shell fixes (outside review B 2 and B 10, 2026-11-01): opening a community on another server is checked before it
 * is saved; the emergency-stop dialog is the app's modal shell; a page that crashes keeps the navigation; the timeline
 * tabs work from the keyboard.
 */

const storedServer = (page: Page) =>
  page.evaluate(() => window.localStorage.getItem("buzz.relayUrl"));

/**
 * Another community server, as a real one behaves towards this page: it accepts a connection, but its public
 * description is readable only by pages on its own address (servers send no cross-site permission for other pages), so
 * a check that reads it from here would always fail.
 */
async function otherServer(page: Page, host: RegExp, hostUrl: string) {
  await page.routeWebSocket(host, () => {});
  await page.route(hostUrl, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/nostr+json",
      // A hosted server allows only its own address (its configured allowed origins). Said explicitly, because a
      // fulfilled request otherwise gets a permissive header added for it.
      headers: { "access-control-allow-origin": new URL(hostUrl).origin },
      body: JSON.stringify({ name: "Film club", supported_nips: [1, 11, 29] }),
    }),
  );
}

/** An address that answers the connection with something else (a parked page): it hangs up before opening. */
async function notAServer(page: Page, host: RegExp) {
  await page.routeWebSocket(host, (ws) => ws.close());
}

async function openAdvanced(page: Page) {
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
    window.localStorage.setItem("buzz.identity.backedUp", "1");
  }, NSEC);
  await community("member").install(page);
  await page.goto("/c");
  await page.getByText("Advanced: open a community on another server").click();
}

test("a typo or a server that does not answer is never saved", async ({
  page,
}) => {
  await notAServer(page, /parked\.example\.com/);
  await openAdvanced(page);
  const input = page.getByTestId("add-community-input");
  const problem = page.getByTestId("add-community-problem");

  await input.fill("community example com");
  await input.press("Enter");
  await expect(problem).toContainText("no spaces");

  // Nothing listens there: the browser's own connection is refused.
  await input.fill("127.0.0.1:9");
  await page.getByTestId("add-community-submit").click();
  await expect(problem).toContainText(
    "127.0.0.1:9 didn't answer as a community server",
  );
  await expect(input).toHaveAttribute("aria-invalid", "true");

  await input.fill("parked.example.com");
  await input.press("Enter");
  await expect(problem).toContainText("parked.example.com didn't answer");

  // Nothing was saved and the page never left this server.
  expect(await storedServer(page)).toBeNull();
  await expect(page).toHaveURL(/\/c$/);
  await expect(page.getByTestId("add-community-confirm")).toHaveCount(0);
});

test("a server that answers is opened only after the person confirms, and Cancel changes nothing", async ({
  page,
}) => {
  await otherServer(page, /other\.example\.com/, "http://other.example.com/");
  await openAdvanced(page);
  const input = page.getByTestId("add-community-input");
  await input.fill("other.example.com");
  await input.press("Enter");
  await expect(page.getByTestId("add-community-confirm-text")).toContainText(
    "other.example.com answered",
  );
  await page.getByTestId("add-community-cancel").click();
  await expect(page.getByTestId("add-community-confirm")).toHaveCount(0);
  expect(await storedServer(page)).toBeNull();

  await input.press("Enter");
  const reloaded = page.waitForEvent("load");
  await page.getByRole("button", { name: "Open other.example.com" }).click();
  await reloaded;
  expect(await storedServer(page)).toBe("ws://other.example.com");
});

test("joining a community on a server that does not answer keeps the person where they are", async ({
  page,
}) => {
  await notAServer(page, /gone\.example\.com/);
  // No rooms on this server, so the address's public card offers to join it.
  await createMockRelay().install(page);
  await page.goto("/c/gone.example.com");
  await page.getByRole("button", { name: "Join this community" }).click();
  await expect(page.getByTestId("community-join-problem")).toContainText(
    "gone.example.com didn't answer",
  );
  expect(await storedServer(page)).toBeNull();
  await expect(
    page.getByRole("button", { name: "Join this community" }),
  ).toBeEnabled();
});

test("joining a community on a server that answers saves it and opens it", async ({
  page,
}) => {
  await otherServer(page, /film\.example\.com/, "http://film.example.com/");
  await createMockRelay().install(page);
  await page.goto("/c/film.example.com");
  const reloaded = page.waitForEvent("load");
  await page.getByRole("button", { name: "Join this community" }).click();
  await reloaded;
  expect(await storedServer(page)).toBe("ws://film.example.com");
});

test("a join check still running when the person leaves the card neither saves nor reloads", async ({
  page,
}) => {
  let answer = () => {};
  const answered = new Promise<void>((resolve) => {
    answer = resolve;
  });
  // The server takes its time to accept the connection.
  await page.routeWebSocket(/slow\.example\.com/, async () => {
    await answered;
  });
  await createMockRelay().install(page);
  await page.goto("/c/slow.example.com");
  await page.evaluate(() => {
    (window as unknown as { stayed: boolean }).stayed = true;
  });
  await page.getByRole("button", { name: "Join this community" }).click();
  await expect(page.getByTestId("community-join-problem")).toContainText(
    "Checking slow.example.com",
  );
  await page.getByRole("link", { name: "All communities" }).click();
  await expect(page).toHaveURL(/\/c$/);

  answer();
  // Long enough for a late answer to save the address and reload, as it did before.
  await page.waitForTimeout(1_500);
  expect(await storedServer(page)).toBeNull();
  await expect(page).toHaveURL(/\/c$/);
  expect(
    await page.evaluate(
      () => (window as unknown as { stayed?: boolean }).stayed,
    ),
  ).toBe(true);
});

test("a page that crashes keeps the navigation, so the person can go elsewhere", async ({
  page,
}) => {
  await community("member").install(page);
  // A directory in a shape the page cannot read makes the page throw while drawing.
  await page.route("**/communities", (route) =>
    route.fulfill({ json: { communities: "not-an-array" } }),
  );
  await page.goto("/c");
  await expect(page.getByTestId("route-error")).toBeVisible();
  // The crash is caught inside the layout: the main navigation is still there and still works.
  const nav = page.getByTestId("app-nav");
  await expect(nav).toBeVisible();
  await expect(page.locator("main").getByTestId("route-error")).toBeVisible();
});

test("the timeline tabs are one tab stop, and the arrow keys move between them", async ({
  page,
}) => {
  await community("member").install(page);
  await page.goto("/?tab=everyone");
  const tabs = page.getByRole("tablist", { name: "Timeline" });
  const everyone = tabs.getByRole("tab", { name: "Everyone" });
  const following = tabs.getByRole("tab", { name: "Following" });
  const updates = tabs.getByRole("tab", { name: "Updates" });
  await expect(everyone).toHaveAttribute("aria-selected", "true");
  await expect(tabs.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
  await everyone.focus();
  await page.keyboard.press("ArrowRight");
  await expect(following).toBeFocused();
  await expect(following).toHaveAttribute("aria-selected", "true");
  await expect(following).toHaveAttribute("tabindex", "0");
  await expect(everyone).toHaveAttribute("tabindex", "-1");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(updates).toBeFocused();
  await expect(updates).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await expect(everyone).toBeFocused();
  await expect(everyone).toHaveAttribute("aria-selected", "true");
});

test("the emergency stop is a modal: focus starts on Cancel, stays inside, and returns to the button that opened it", async ({
  page,
}) => {
  const AGENT = "c".repeat(64);
  const relay = community("member");
  relay.seed({
    id: "org-cto",
    pubkey: ALICE,
    created_at: 100,
    kind: 37010,
    tags: [
      ["d", "cto"],
      ["name", "CTO"],
    ],
    content: JSON.stringify({
      v: 1,
      name: "CTO",
      kind: "role",
      holders: [ALICE],
      agentSeats: [AGENT],
    }),
    sig: "sig",
  });
  await relay.install(page);
  await page.goto(`/c/${COMMUNITY_HOST}?channel=${GENERAL}`);
  await page.getByTestId("org-toggle").click();
  const opener = page.getByTestId(`stop-agent-${AGENT}`);
  await opener.click();

  const dialog = page.getByRole("alertdialog", { name: /^Stop .*\?$/ });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  const cancel = page.getByTestId("agent-stop-cancel");
  await expect(cancel).toBeFocused();
  // Tab and Shift+Tab stay inside: ban toggle, Cancel, Stop, and round again.
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("agent-stop-confirm")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("agent-stop-ban-toggle")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByTestId("agent-stop-confirm")).toBeFocused();
  await expectAccessible(page, "emergency stop dialog");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();

  // The backdrop cancels too, and the opener gets focus back.
  await opener.click();
  await expect(dialog).toBeVisible();
  await page.getByTestId("modal-backdrop").click({ position: { x: 5, y: 5 } });
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("two activations of Stop in the same moment start one stop, not two", async ({
  page,
}) => {
  const AGENT = "c".repeat(64);
  const relay = community("member");
  relay.seed({
    id: "org-cto",
    pubkey: ALICE,
    created_at: 100,
    kind: 37010,
    tags: [
      ["d", "cto"],
      ["name", "CTO"],
    ],
    content: JSON.stringify({
      v: 1,
      name: "CTO",
      kind: "role",
      holders: [ALICE],
      agentSeats: [AGENT],
    }),
    sig: "sig",
  });
  await relay.install(page);
  await page.goto(`/c/${COMMUNITY_HOST}?channel=${GENERAL}`);
  await page.getByTestId("org-toggle").click();
  await page.getByTestId(`stop-agent-${AGENT}`).click();
  const before = relay.events.length;
  // A double Enter or a click and Enter: both land before React draws "Stopping…".
  await page.evaluate(() => {
    const stop = document.querySelector<HTMLButtonElement>(
      "[data-testid='agent-stop-confirm']",
    );
    stop?.click();
    stop?.click();
  });
  await expect(page.getByRole("alertdialog")).toHaveCount(0, {
    timeout: 20_000,
  });
  // Let a second, overlapping run finish publishing if one had started.
  await page.waitForTimeout(1_000);
  const steps = relay.events
    .slice(before)
    .map(
      (event) =>
        `${event.kind}:${event.tags.find((t) => t[0] === "d")?.[1] ?? ""}`,
    );
  expect(steps.length).toBeGreaterThan(0);
  expect(new Set(steps).size).toBe(steps.length);
});

import { expect, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { expectAccessible } from "../helpers/a11y";
import { createMockRelay } from "./mock-relay";

/**
 * Starting a project from a ready-made team, in the browser: the picker, what
 * gets written (counted by kind, read back from the server), opening the first
 * channel, and what happens when the server refuses a step. The mock server
 * keeps what it is sent and derives a channel's record from its creation, as
 * the real one does.
 */

const NSEC = "44".repeat(32);
const ME = getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);
const TEMPLATE = "ai-media-studio";

const general = {
  id: "chan-general",
  pubkey: "b".repeat(64),
  created_at: 100,
  kind: 39000,
  tags: [
    ["d", "0f0f0f0f-1111-2222-3333-444444444444"],
    ["name", "general"],
  ],
  content: "",
  sig: "sig",
};

function membership(role: "owner" | "admin" | "member", created_at = 100) {
  return {
    id: `members-${role}-${created_at}`,
    pubkey: "b".repeat(64),
    created_at,
    kind: 13534,
    tags: [["-"], ["member", ME, role]],
    content: "",
    sig: "sig",
  };
}

async function open(
  page: import("@playwright/test").Page,
  relay: ReturnType<typeof createMockRelay>,
  {
    signedIn = true,
    role = "owner",
  }: { signedIn?: boolean; role?: "owner" | "admin" | "member" | null } = {},
) {
  if (role) relay.seed(membership(role));
  await relay.install(page);
  if (signedIn) {
    await page.addInitScript((nsec) => {
      window.localStorage.setItem("buzz.identity.nsec", nsec);
    }, NSEC);
  }
  await page.goto("/c/alpha.example.com");
  await page.getByTestId("content-pane").waitFor();
  if (await page.getByTestId("open-channel-list").isVisible()) {
    await page.getByTestId("open-channel-list").click();
  }
  await page.getByTestId("start-project-toggle").click();
}

function count(
  relay: ReturnType<typeof createMockRelay>,
  kind: number,
  marked = true,
) {
  return relay.events.filter(
    (event) =>
      event.kind === kind &&
      (!marked || event.tags.some((t) => t[0] === "t" && t[1] === TEMPLATE)),
  ).length;
}

/** What Home's checklist has been told about, from this browser's storage. */
function firstSteps(page: import("@playwright/test").Page) {
  return page.evaluate(() =>
    JSON.parse(window.localStorage.getItem("creaton.first-steps") ?? "[]"),
  );
}

test("a team is picked, set up step by step, and its first channel opens", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const relay = createMockRelay({ deriveChannels: true });
  relay.seed(general);
  await open(page, relay);

  // Two starting points come first, in plain words; the other teams wait under "More kinds of team".
  const picker = page.getByTestId("start-project");
  await expect(picker).toBeVisible();
  await expect(
    picker.getByRole("heading", { name: "Set up this community" }),
  ).toBeVisible();
  await expect(page.getByTestId("start-project-confirm")).toHaveText(
    "Set up community",
  );
  await expect(
    page.getByTestId("template-option-ai-media-studio"),
  ).toBeChecked();
  await expect(picker).toContainText("Creative project");
  await expect(picker).toContainText("Technical project");
  await expect(picker).toContainText("Film, music, audio or any creative work");
  await expect(picker).toContainText(
    "4 channels · 2 boards · 6 AI helpers · 3 shared pages",
  );
  const more = page.getByTestId("more-templates");
  await expect(more).toHaveJSProperty("open", false);
  await expect(
    more.getByTestId("template-option-crypto-app-studio"),
  ).toBeHidden();

  await expectAccessible(page, "the community setup picker");

  // What it adds is one line until asked for, then said in plain words.
  const preview = page.getByTestId("template-preview");
  await expect(preview).toHaveJSProperty("open", false);
  await expect(preview.getByText("#writers-room")).toBeHidden();
  await page.getByTestId("template-preview-toggle").click();
  await expect(preview).toContainText("Channels that already exist here");
  await expectAccessible(
    page,
    "the community setup picker with its details open",
  );
  await expect(preview).toContainText("#writers-room");
  await expect(preview).toContainText("The Writer");
  await expect(preview).toContainText(
    "Each helper can run 200 times, start 20 tasks",
  );
  await expect(preview).toContainText(
    "in this browser, on the server, or on your computer",
  );

  await page.getByTestId("start-project-confirm").click();
  await expect(page.getByTestId("start-project-done")).toBeVisible({
    timeout: 60_000,
  });

  // Home's "Get started" list can now tick "Start a project".
  expect(await firstSteps(page)).toEqual(["project"]);

  // What was written, read back from the server.
  expect(count(relay, 9007, false)).toBe(6); // four channels and two boards
  expect(count(relay, 9)).toBe(5); // four first messages and the welcome
  expect(count(relay, 45001)).toBe(2); // a first post on each board
  expect(count(relay, 30175)).toBe(6); // helpers
  expect(count(relay, 37010)).toBe(7); // the founder seat and six helper seats
  expect(count(relay, 37012)).toBe(1); // the default limit
  expect(count(relay, 30620)).toBe(2); // automations
  expect(count(relay, 44001)).toBe(3); // shared pages
  expect(count(relay, 30180)).toBe(1); // a skill
  // The founder seat is held by the person who set it up.
  const root = relay.events.find(
    (e) =>
      e.kind === 37010 && e.tags.some((t) => t[0] === "d" && t[1] === "root"),
  );
  expect(root?.pubkey).toBe(ME);
  expect(JSON.parse(root?.content ?? "{}").holders).toEqual([ME]);

  // The first channel opens on its first message, and the channel list has it.
  await page.getByTestId("start-project-open-channel").click();
  await expect(page.getByTestId("composer-input")).toBeVisible();
  await expect(page.getByText("Welcome to the writing table")).toBeVisible();
  await expect(page.getByText("writers-room").first()).toBeVisible();

  // The two boards were created as boards (the founders' one private), and each
  // opens with its first post.
  const boards = relay.events.filter(
    (e) =>
      e.kind === 9007 &&
      e.tags.some((t) => t[0] === "channel_type" && t[1] === "forum"),
  );
  const named = (name: string) =>
    boards.find((e) => e.tags.some((t) => t[0] === "name" && t[1] === name));
  expect(boards).toHaveLength(2);
  expect(named("supporters")?.tags).toContainEqual(["visibility", "open"]);
  expect(named("founders")?.tags).toContainEqual(["visibility", "private"]);
  await page.getByTestId("board-nav-supporters").click();
  await expect(page.getByTestId("board-posts")).toContainText(
    "Welcome, supporters",
  );
  await page.getByTestId("board-nav-founders").click();
  await expect(page.getByTestId("board-posts")).toContainText(
    "The founders' board",
  );
});

test("a refusal after preflight keeps progress and retry finishes without repeating anything", async ({
  page,
}) => {
  test.setTimeout(120_000);
  let refuseOrg = true;
  const relay = createMockRelay({
    deriveChannels: true,
    refuse: (event) =>
      refuseOrg && event.kind === 37010
        ? "restricted: only the community owner may publish an org root"
        : null,
  });
  relay.seed(general);
  await open(page, relay, { role: "admin" });
  await page.getByTestId("start-project-confirm").click();

  await expect(page.getByTestId("start-project-problem-text")).toContainText(
    "Only this community's owner or an admin can set up the team",
    { timeout: 60_000 },
  );
  await expect(page.getByTestId("start-project-problem-text")).toContainText(
    "Whatever already went through is kept",
  );
  // Everything before the team went through; nothing after it was tried.
  expect(count(relay, 9007, false)).toBe(6);
  expect(count(relay, 30175)).toBe(6);
  expect(count(relay, 37010)).toBe(0);
  expect(count(relay, 44001)).toBe(0);
  // A project that stopped partway is not a finished one.
  expect(await firstSteps(page)).toEqual([]);

  refuseOrg = false;
  await page.getByTestId("start-project-retry").click();
  await expect(page.getByTestId("start-project-done")).toBeVisible({
    timeout: 60_000,
  });
  expect(await firstSteps(page)).toEqual(["project"]);
  // Finished from where it stopped: nothing was written twice.
  expect(count(relay, 9007, false)).toBe(6);
  expect(count(relay, 9)).toBe(5);
  expect(count(relay, 30175)).toBe(6);
  expect(count(relay, 37010)).toBe(7);
  expect(count(relay, 44001)).toBe(3);
});

test("someone without an account is asked to create one first", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(general);
  await open(page, relay, { signedIn: false });
  await expect(page.getByTestId("start-project-confirm")).toHaveCount(0);
  await page.getByTestId("start-project-sign-up").click();
  await expect(page.getByTestId("onboarding-dialog")).toBeVisible();
});

test("a community with no channels offers community setup instead of showing a dead end", async ({
  page,
}) => {
  const relay = createMockRelay();
  await relay.install(page);
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
  }, NSEC);
  // This browser is connected to the server it opens (the page's own address),
  // so there is nothing to join: the empty community opens in the app.
  await page.goto("/c/127.0.0.1:4173");
  await page.getByTestId("content-pane").waitFor();

  await expect(page.getByTestId("empty-community")).toContainText(
    "Nothing here yet",
  );
  await expect(
    page.getByText("Select a channel to start reading."),
  ).toHaveCount(0);
  await page.getByTestId("empty-community-start").click();
  await expect(page.getByTestId("start-project")).toBeVisible();
});

test("another kind of team can be picked from under More kinds of team", async ({
  page,
}) => {
  const relay = createMockRelay({ deriveChannels: true });
  relay.seed(general);
  await open(page, relay);

  await page
    .getByTestId("more-templates")
    .getByText("More kinds of team")
    .click();
  const crypto = page.getByTestId("template-option-crypto-app-studio");
  await expect(crypto).toBeAttached();
  await crypto.check({ force: true });
  await expect(crypto).toBeChecked();
  await expect(
    page.getByTestId("template-option-ai-media-studio"),
  ).not.toBeChecked();
  // The preview follows the pick, and setup is offered for it.
  await page.getByTestId("template-preview-toggle").click();
  await expect(page.getByTestId("template-preview")).toContainText("#security");
  await expect(page.getByTestId("start-project-confirm")).toBeEnabled();
});

test("members see the restriction before setup and can recheck after promotion", async ({
  page,
}) => {
  let writes = 0;
  const relay = createMockRelay({
    refuse: () => {
      writes += 1;
      return null;
    },
  });
  relay.seed(general);
  await open(page, relay, { role: "member" });
  await page.getByTestId("template-option-vanilla-app-studio").focus();
  await page.keyboard.press("Space");
  await expect(
    page.getByTestId("template-option-vanilla-app-studio"),
  ).toBeChecked();
  await expect(page.getByTestId("start-project-access")).toContainText(
    "Only this community's owner or an admin",
  );
  await expect(page.getByTestId("start-project-confirm")).toBeDisabled();
  expect(writes).toBe(0);
  expect(await firstSteps(page)).toEqual([]);

  relay.seed(membership("admin", 200));
  await page.getByTestId("start-project-check-access").click();
  await expect(page.getByTestId("start-project-confirm")).toBeEnabled();
  expect(writes).toBe(0);
});

test("a missing member list never grants setup permission", async ({
  page,
}) => {
  let writes = 0;
  const relay = createMockRelay({
    refuse: () => {
      writes += 1;
      return null;
    },
  });
  relay.seed(general);
  await open(page, relay, { role: null });
  await expect(page.getByTestId("start-project-access")).toContainText(
    "Couldn't confirm your role",
  );
  await expect(page.getByTestId("start-project-confirm")).toBeDisabled();
  expect(writes).toBe(0);
});

test("permission lost after opening the picker is caught before any writes", async ({
  page,
}) => {
  let writes = 0;
  const relay = createMockRelay({
    refuse: () => {
      writes += 1;
      return null;
    },
  });
  relay.seed(general);
  await open(page, relay);
  await expect(page.getByTestId("start-project-confirm")).toBeEnabled();
  relay.seed(membership("member", 200));
  await page.getByTestId("start-project-confirm").click();
  await expect(page.getByTestId("start-project-access")).toContainText(
    "Only this community's owner or an admin",
  );
  await expect(page.getByTestId("start-project-confirm")).toBeDisabled();
  expect(writes).toBe(0);
});

test("a failed permission read disables setup and offers a working retry", async ({
  page,
}) => {
  let writes = 0;
  const relay = createMockRelay({
    refuse: () => {
      writes += 1;
      return null;
    },
  });
  relay.seed(general);
  relay.setClosingSockets((filter) => filter?.kinds?.includes(13534) ?? false);
  await open(page, relay);
  await expect(page.getByTestId("start-project-access")).toContainText(
    "Couldn't check your community permissions",
  );
  await expect(page.getByTestId("start-project-confirm")).toBeDisabled();
  expect(writes).toBe(0);
  relay.setClosingSockets(false);
  await page.getByTestId("start-project-check-access").click();
  await expect(page.getByTestId("start-project-confirm")).toBeEnabled();
});

for (const viewport of [
  { width: 1024, height: 480 },
  { width: 390, height: 600 },
]) {
  test(`community setup scrolls by pointer and keyboard at ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const relay = createMockRelay();
    relay.seed(general);
    await open(page, relay);
    const scroll = page.getByTestId("community-setup-scroll");
    const confirm = page.getByTestId("start-project-confirm");
    await expect(confirm).toBeEnabled();
    // The long view: everything the team adds, opened. The panel must scroll so none of it is out of reach.
    await page.getByTestId("template-preview-toggle").click();
    expect(
      await scroll.evaluate((el) => el.scrollHeight > el.clientHeight),
    ).toBe(true);
    const bounds = await scroll.boundingBox();
    expect(bounds).not.toBeNull();
    expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(
      viewport.height,
    );

    await scroll.hover();
    await page.mouse.wheel(0, 4000);
    await expect(confirm).toBeInViewport();
    const bottom = await scroll.evaluate((el) => el.scrollTop);
    await scroll.focus();
    await scroll.press("PageUp");
    await expect
      .poll(() => scroll.evaluate((el) => el.scrollTop))
      .toBeLessThan(bottom);
    await scroll.press("PageDown");
    await expect(confirm).toBeInViewport();
    // Keyboard users can reach the action as well as scroll its panel.
    await confirm.focus();
    await expect(confirm).toBeFocused();
  });
}

test("a community that has channels does not show the empty prompt", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(general);
  await relay.install(page);
  await page.goto("/c/alpha.example.com");
  await page.getByTestId("content-pane").waitFor();
  await expect(
    page.getByText("Select a channel to start reading."),
  ).toBeVisible();
  await expect(page.getByTestId("empty-community")).toHaveCount(0);
});

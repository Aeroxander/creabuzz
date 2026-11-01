import { expect, type Page, test } from "@playwright/test";
import { getPublicKey, verifyEvent } from "nostr-tools/pure";

import { expectAccessible } from "../helpers/a11y";
import { expectNoSidewaysScroll, PHONE } from "../helpers/layout";
import { COMMUNITY_HOST, createMockRelay } from "./mock-relay";

/**
 * Changing a room or board after it is made: its name, what it is for, and who can read it. Offered to its owners and
 * admins only. The mock keeps what it is sent and, as the server does, writes the room's new metadata record when an
 * edit is accepted, so the spec checks the record the page signs and what the page shows after.
 */

const BOARD = "b0a4d000-1111-2222-3333-555555555555";
const CHAT = "c4a70000-1111-2222-3333-555555555555";
const NSEC = "66".repeat(32);
const ME = getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);
const ANN = "a1".repeat(32);
const SERVER = "b".repeat(64);

function meta(
  id: string,
  name: string,
  type: "forum" | "stream",
  at = 100,
  extra: { about?: string; private?: boolean } = {},
) {
  return {
    id: `meta-${id}-${at}`,
    pubkey: SERVER,
    created_at: at,
    kind: 39000,
    tags: [
      ["d", id],
      ["name", name],
      ...(extra.about ? [["about", extra.about]] : []),
      [extra.private ? "private" : "public"],
      ["t", type],
    ],
    content: "",
    sig: "sig",
  };
}

function members(id: string, role: "owner" | "admin" | "member") {
  return {
    id: `members-${id}`,
    pubkey: SERVER,
    created_at: 101,
    kind: 39002,
    tags: [
      ["d", id],
      ["p", ANN, "", "owner"],
      ["p", ME, "", role],
    ],
    content: "",
    sig: "sig",
  };
}

async function open(
  page: Page,
  {
    role = "owner",
    channel = BOARD,
    refuse,
  }: {
    role?: "owner" | "admin" | "member";
    channel?: string;
    refuse?: string;
  } = {},
) {
  // The server's record of each room, as it stands: an accepted edit replaces it, as the real server does.
  const rooms = new Map([
    [
      BOARD,
      { name: "ideas", type: "forum" as const, about: "", private: false },
    ],
    [
      CHAT,
      {
        name: "general",
        type: "stream" as const,
        about: "Say hello",
        private: false,
      },
    ],
  ]);
  const relay = createMockRelay({
    refuse: (event) => {
      if (event.kind !== 9002) return null;
      if (refuse) return refuse;
      const id = event.tags.find((t) => t[0] === "h")?.[1] ?? "";
      const room = rooms.get(id);
      if (!room) return "channel not found";
      const value = (name: string) =>
        event.tags.find((t) => t[0] === name)?.[1];
      const next = {
        ...room,
        name: value("name") ?? room.name,
        about: value("about") ?? room.about,
        private:
          value("visibility") === undefined
            ? room.private
            : value("visibility") === "private",
      };
      rooms.set(id, next);
      relay.seed(
        meta(id, next.name, next.type, event.created_at, {
          about: next.about,
          private: next.private,
        }),
      );
      return null;
    },
  });
  relay.seed(meta(BOARD, "ideas", "forum"));
  relay.seed(meta(CHAT, "general", "stream", 100, { about: "Say hello" }));
  relay.seed(members(BOARD, role));
  relay.seed(members(CHAT, role));
  await page.route("http://127.0.0.1:8545/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x10" }),
    }),
  );
  await relay.install(page);
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
  }, NSEC);
  await page.goto(`/c/${COMMUNITY_HOST}?channel=${channel}`);
  await page.getByTestId("content-pane").waitFor();
  return relay;
}

const edits = (relay: ReturnType<typeof createMockRelay>) =>
  relay.events.filter((event) => event.kind === 9002);

test("a board's owner renames it and says what it is for: one signed record with only what changed", async ({
  page,
}) => {
  const relay = await open(page);
  await expect(page.getByTestId("board-name")).toHaveText("ideas");
  await page.getByTestId("board-edit").click();
  const dialog = page.getByTestId("edit-channel-dialog");
  await expect(dialog).toBeVisible();
  // A form: it starts in the name field, not on Cancel.
  await expect(page.getByTestId("edit-channel-name")).toBeFocused();
  // Nothing to save until something changes, and the button says why.
  await expect(page.getByTestId("edit-channel-save")).toBeDisabled();
  await expect(page.getByTestId("edit-channel-why")).toHaveText(
    "Nothing has changed yet.",
  );

  await page.getByTestId("edit-channel-name").fill("#project-ideas");
  await page
    .getByTestId("edit-channel-description")
    .fill("Ideas for the next release");
  await page.getByTestId("edit-channel-save").click();

  await expect.poll(() => edits(relay).length).toBe(1);
  const [edit] = edits(relay);
  expect(edit.pubkey).toBe(ME);
  expect(verifyEvent(edit as never)).toBe(true);
  expect(edit.tags).toEqual([
    ["h", BOARD],
    ["name", "project-ideas"],
    ["about", "Ideas for the next release"],
  ]);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("board-name")).toHaveText("project-ideas");
  await expect(page.getByTestId("board")).toContainText(
    "Ideas for the next release",
  );
});

test("making a board private says what it does first, and sends only who can read it", async ({
  page,
}) => {
  const relay = await open(page);
  await page.getByTestId("board-edit").click();
  await expect(page.getByTestId("edit-channel-visibility-note")).toHaveCount(0);
  await page.getByTestId("edit-channel-visibility").selectOption("private");
  const note = page.getByTestId("edit-channel-visibility-note");
  await expect(note).toContainText(
    "Only the people on its list will be able to read it",
  );
  // How many keep it: the two people on its list.
  await expect(note).toContainText("2 people are on it now");
  await page.getByTestId("edit-channel-save").click();
  await expect.poll(() => edits(relay).length).toBe(1);
  expect(edits(relay)[0].tags).toEqual([
    ["h", BOARD],
    ["visibility", "private"],
  ]);
  // A private board shows who can read it.
  await expect(page.getByTestId("board-people-toggle")).toBeVisible();
});

test("an empty name cannot be saved, and cancelling sends nothing", async ({
  page,
}) => {
  const relay = await open(page, { role: "admin" });
  await page.getByTestId("board-edit").click();
  await page.getByTestId("edit-channel-name").fill(" # ");
  await expect(page.getByTestId("edit-channel-save")).toBeDisabled();
  await expect(page.getByTestId("edit-channel-why")).toHaveText(
    "Give it a name first.",
  );
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("edit-channel-dialog")).toHaveCount(0);
  expect(edits(relay)).toEqual([]);
});

test("a chat room's owner edits it from the room's header", async ({
  page,
}) => {
  const relay = await open(page, { channel: CHAT });
  await page.getByTestId("room-edit").click();
  await expect(page.getByTestId("edit-channel-description")).toHaveValue(
    "Say hello",
  );
  await page.getByTestId("edit-channel-description").fill("");
  await page.getByTestId("edit-channel-save").click();
  await expect.poll(() => edits(relay).length).toBe(1);
  // An emptied description is cleared, not left as it was.
  expect(edits(relay)[0].tags).toEqual([
    ["h", CHAT],
    ["about", ""],
  ]);
  await expect(page.getByTestId("content-pane")).not.toContainText("Say hello");
});

test("a member is offered no way to edit a board or a room", async ({
  page,
}) => {
  await open(page, { role: "member" });
  await expect(page.getByTestId("board-name")).toHaveText("ideas");
  await expect(page.getByTestId("board-edit")).toHaveCount(0);
  await page.goto(`/c/${COMMUNITY_HOST}?channel=${CHAT}`);
  await page.getByTestId("content-pane").waitFor();
  await expect(
    page.getByRole("heading", { name: "general", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("room-edit")).toHaveCount(0);
});

test("when the server refuses the edit, its words are shown and the dialog keeps what was typed", async ({
  page,
}) => {
  await open(page, {
    refuse:
      "invalid: actor not authorized for name/about/archived/visibility/ttl changes",
  });
  await page.getByTestId("board-edit").click();
  await page.getByTestId("edit-channel-name").fill("renamed");
  await page.getByTestId("edit-channel-save").click();
  await expect(page.getByTestId("edit-channel-error")).toHaveText(
    "The server did not save the changes: only the board's owners and admins can change it.",
  );
  const details = page.getByTestId("edit-channel-error-details");
  await details.locator("summary").click();
  await expect(details).toContainText("actor not authorized");
  await expect(page.getByTestId("edit-channel-name")).toHaveValue("renamed");
  await expect(page.getByTestId("board-name")).toHaveText("ideas");
});

test("the edit dialog is accessible", async ({ page }) => {
  await open(page);
  await page.getByTestId("board-edit").click();
  await page.getByTestId("edit-channel-visibility").selectOption("private");
  await expect(page.getByTestId("edit-channel-visibility-note")).toBeVisible();
  await expectAccessible(page, "the edit dialog for a board");
});

test("the edit dialog fits a phone", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await open(page);
  await page.getByTestId("board-edit").click();
  await expect(page.getByTestId("edit-channel-dialog")).toBeVisible();
  await expectNoSidewaysScroll(page, "the edit dialog on a phone");
  await expect(page.getByTestId("edit-channel-save")).toBeInViewport();
});

test("a room's header keeps Edit room on screen on a phone", async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await open(page, { channel: CHAT });
  await expect(page.getByTestId("room-edit")).toBeInViewport();
  await expectNoSidewaysScroll(
    page,
    "a room's header with Edit room on a phone",
  );
});

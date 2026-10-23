import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { expectAccessible } from "../helpers/a11y";
import { createMockRelay } from "./mock-relay";

/**
 * Two rough edges of the chat rooms, seen on a local server: a direct-message thread was listed under Channels (as
 * "DM", opening to "Connecting…") instead of only under Messages, and the server's notes in a room ("created this
 * channel", "added …") showed their raw body. The server's own handling of both is covered by its tests; here the spec
 * checks what the app lists and how it words the notes, from history and live.
 */

const NSEC = "77".repeat(32);
const ME = getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);
/** The server's own key: it signs rooms' metadata, conversation notices and room notes. */
const SERVER = "5".repeat(64);
const BOARD = "b".repeat(64);
const REPLY = "c".repeat(64);
const MALLORY = "e".repeat(64);
const GENERAL_ID = "0a0a0a0a-1111-2222-3333-444444444444";
const PLANNING_ID = "0b0b0b0b-1111-2222-3333-444444444444";
const DM_ID = "0d0d0d0d-1111-2222-3333-444444444444";
const now = () => Math.floor(Date.now() / 1000);

type Relay = ReturnType<typeof createMockRelay>;

const profile = (pubkey: string, name: string) => ({
  id: `profile-${pubkey.slice(0, 6)}`,
  pubkey,
  created_at: 50,
  kind: 0,
  tags: [],
  content: JSON.stringify({ name }),
  sig: "sig",
});

const roomRecord = (id: string, name: string, extra: string[][] = []) => ({
  id: `meta-${id.slice(0, 8)}`,
  pubkey: SERVER,
  kind: 39000,
  created_at: 100,
  tags: [["d", id], ["name", name], ...extra],
  content: "",
  sig: "sig",
});

let noteCount = 0;
const note = (body: object, at = now() - 60, signer = SERVER) => ({
  id: `note-${++noteCount}-${at}`,
  pubkey: signer,
  kind: 40099,
  created_at: at,
  tags: [["h", PLANNING_ID]],
  content: JSON.stringify(body),
  sig: "sig",
});

function community() {
  const relay = createMockRelay();
  for (const [pubkey, name] of [
    [SERVER, "localhost:3001 Moderation"],
    [BOARD, "Board Tester"],
    [REPLY, "Reply Tester"],
    [MALLORY, "Mallory"],
  ]) {
    relay.seed(profile(pubkey, name));
  }
  relay.seed(roomRecord(GENERAL_ID, "general", [["public"], ["t", "stream"]]));
  relay.seed(
    roomRecord(PLANNING_ID, "planning", [["private"], ["t", "stream"]]),
  );
  // The DM thread's metadata, as the server writes it: hidden, typed dm, naming who is in it.
  relay.seed(
    roomRecord(DM_ID, "DM", [
      ["private"],
      ["hidden"],
      ["p", ME],
      ["p", BOARD],
      ["closed"],
      ["t", "dm"],
    ]),
  );
  // The notice that puts the conversation in the reader's Messages.
  relay.seed({
    id: "dm-notice",
    pubkey: SERVER,
    kind: 41001,
    created_at: 110,
    tags: [
      ["d", DM_ID],
      ["p", ME],
      ["p", BOARD],
    ],
    content: "",
    sig: "sig",
  });
  relay.seed({
    id: "dm-hello",
    pubkey: BOARD,
    kind: 9,
    created_at: now() - 30,
    tags: [["h", DM_ID]],
    content: "Just between us",
    sig: "sig",
  });
  return relay;
}

async function open(page: Page, relay: Relay) {
  await relay.install(page);
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
    window.localStorage.setItem("buzz.identity.backedUp", "1");
  }, NSEC);
  await page.goto("/c/alpha.example.com");
  await page.getByTestId("content-pane").waitFor();
  await expect(page.getByTestId("channel-general")).toBeVisible({
    timeout: 20_000,
  });
}

/** The room's live subscription is open, so a note delivered now will reach it. */
const roomWatched = (relay: Relay, roomId: string) =>
  expect
    .poll(() =>
      relay
        .subscriptionFilters()
        .some((f) => (f["#h"] as string[] | undefined)?.includes(roomId)),
    )
    .toBe(true);

test("a direct-message thread is under Messages and nowhere in the channel list", async ({
  page,
}) => {
  const relay = community();
  await open(page, relay);
  await expect(page.getByTestId("channel-planning")).toBeVisible();
  await expect(page.getByTestId("channel-DM")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "DM", exact: true }),
  ).toHaveCount(0);

  await page.getByTestId("dms-toggle").click();
  const thread = page.getByTestId(`dm-${DM_ID.slice(0, 8)}`);
  await expect(thread).toBeVisible({ timeout: 20_000 });
  await expect(thread).toContainText("Board Tester");
  await thread.click();
  await expect(page.getByText("Just between us")).toBeVisible({
    timeout: 20_000,
  });
});

test("a thread the server opened itself (its moderation notices) is listed under Messages too", async ({
  page,
}) => {
  // The server opens it without a creation notice: only its metadata record says it exists, naming the reader alone.
  const MOD_ID = "0e0e0e0e-1111-2222-3333-444444444444";
  const relay = community();
  relay.seed(
    roomRecord(MOD_ID, "DM", [
      ["private"],
      ["hidden"],
      ["p", ME],
      ["closed"],
      ["t", "dm"],
    ]),
  );
  relay.seed({
    id: "mod-notice",
    pubkey: SERVER,
    kind: 9,
    created_at: now() - 20,
    tags: [["h", MOD_ID]],
    content: "A moderator removed your post on the board ideas.",
    sig: "sig",
  });
  await open(page, relay);
  await expect(page.getByTestId("channel-DM")).toHaveCount(0);
  await page.getByTestId("dms-toggle").click();
  const thread = page.getByTestId(`dm-${MOD_ID.slice(0, 8)}`);
  await expect(thread).toContainText("localhost:3001 Moderation", {
    timeout: 20_000,
  });
  await thread.click();
  await expect(
    page.getByText("A moderator removed your post on the board ideas."),
  ).toBeVisible({ timeout: 20_000 });
});

test("a new private room's notes read as sentences with names, from history and live", async ({
  page,
}) => {
  const relay = community();
  relay.seed(note({ actor: BOARD, type: "channel_created" }, now() - 120));
  relay.seed(
    note({ actor: BOARD, target: REPLY, type: "member_joined" }, now() - 110),
  );
  relay.seed(
    note({ actor: BOARD, target: ME, type: "member_joined" }, now() - 100),
  );
  relay.seed(
    note({ actor: BOARD, type: "a_change_this_app_does_not_know" }, now() - 90),
  );
  relay.seed({
    id: "planning-hello",
    pubkey: REPLY,
    kind: 9,
    created_at: now() - 80,
    tags: [["h", PLANNING_ID]],
    content: "Thanks for adding me",
    sig: "sig",
  });
  await open(page, relay);
  await page.getByTestId("channel-planning").click();
  await expect(page.getByText("Thanks for adding me")).toBeVisible({
    timeout: 20_000,
  });

  const notes = page.getByTestId("system-note");
  await expect(notes).toHaveCount(4);
  await expect(notes.nth(0)).toContainText("Board Tester created this channel");
  await expect(notes.nth(1)).toContainText(
    "Reply Tester was added by Board Tester",
  );
  await expect(notes.nth(2)).toContainText("You were added by Board Tester");
  await expect(notes.nth(3)).toContainText("Board Tester updated this channel");
  // No raw body, no server name as an author, and nothing to reply to or report on a note.
  await expect(page.getByText('"type"')).toHaveCount(0);
  await expect(page.getByText("localhost:3001 Moderation")).toHaveCount(0);
  await expect(notes.getByRole("button")).toHaveCount(0);
  // Only the person's message is a message.
  await expect(page.getByTestId("message-row")).toHaveCount(1);
  await expectAccessible(page, "a room with the server's notes");

  // Someone added while the room is open reads the same way.
  await roomWatched(relay, PLANNING_ID);
  relay.deliver(
    note({ actor: ME, target: MALLORY, type: "member_joined" }, now() + 1),
  );
  await expect(notes).toHaveCount(5);
  await expect(notes.nth(4)).toContainText("Mallory was added by you");
});

test("a note-shaped message from a member is shown as that member's message, not as the server's note", async ({
  page,
}) => {
  const relay = community();
  relay.seed(note({ actor: BOARD, type: "channel_created" }, now() - 120));
  relay.seed(
    note(
      { actor: BOARD, target: REPLY, type: "member_removed" },
      now() - 60,
      MALLORY,
    ),
  );
  await open(page, relay);
  await page.getByTestId("channel-planning").click();
  const notes = page.getByTestId("system-note");
  await expect(notes).toHaveCount(1, { timeout: 20_000 });
  await expect(notes).toContainText("Board Tester created this channel");
  await expect(page.getByText("removed Reply Tester")).toHaveCount(0);
  const forged = page.getByTestId("message-row");
  await expect(forged).toHaveCount(1);
  await expect(forged).toContainText("Mallory");
});

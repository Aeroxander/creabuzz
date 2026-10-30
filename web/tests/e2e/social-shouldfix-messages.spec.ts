import {
  expect,
  type Page,
  type Route,
  type WebSocketRoute,
  test,
} from "@playwright/test";
import * as nip44 from "nostr-tools/nip44";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";

import { expectAccessible } from "../helpers/a11y";
import { createDirectMessageWraps } from "../../src/features/social/lib/nip17.ts";
import { createMockRelay } from "./mock-relay";

/**
 * The social audit's should-fix items for messages (D143): the community's own inbox says what it is (the server's
 * notices and messages in this community), points to the private Messages on Home, finds people by name, works on a
 * phone and has a dark dialog; the "let other apps message you" offer is not made on an invite-only server; a board
 * read on its own page is read everywhere; and new private messages show as a dot on Messages.
 */

const hexKey = (hex: string) =>
  Uint8Array.from(hex.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16));
const NSEC = "4d".repeat(32);
const ME = getPublicKey(hexKey(NSEC));
const ALICE_NSEC = "5e".repeat(32);
const ALICE = getPublicKey(hexKey(ALICE_NSEC));
/** The server's own key: it signs rooms' metadata and conversation notices. */
const SERVER = "5".repeat(64);
const BOARD_PERSON = "b".repeat(64);
const GENERAL = "0a0a0a0a-1111-2222-3333-555555555555";
const DM = "0d0d0d0d-1111-2222-3333-555555555555";
const NEW_DM = "0e0e0e0e-1111-2222-3333-555555555555";
const BOARD = "0c0c0c0c-1111-2222-3333-555555555555";
const ANCHOR = "e1".repeat(32);
const now = () => Math.floor(Date.now() / 1000);

type Relay = ReturnType<typeof createMockRelay>;

const profile = (pubkey: string, name: string) => ({
  id: `profile-${pubkey.slice(0, 8)}`,
  pubkey,
  created_at: 50,
  kind: 0,
  tags: [],
  content: JSON.stringify({ name, display_name: name }),
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

/** A direct thread as the server writes it: its metadata and the notice that lists it for the reader. */
function dmThread(relay: Relay, id: string, other: string) {
  relay.seed(
    roomRecord(id, "DM", [
      ["private"],
      ["hidden"],
      ["p", ME],
      ["p", other],
      ["closed"],
      ["t", "dm"],
    ]),
  );
  relay.seed({
    id: `dm-notice-${id.slice(0, 8)}`,
    pubkey: SERVER,
    kind: 41001,
    created_at: 110,
    tags: [
      ["d", id],
      ["p", ME],
      ["p", other],
    ],
    content: "",
    sig: "sig",
  });
}

function community(options: Parameters<typeof createMockRelay>[0] = {}) {
  const relay = createMockRelay(options);
  relay.seed(profile(SERVER, "Community moderators"));
  relay.seed(profile(BOARD_PERSON, "Board Tester"));
  relay.seed(profile(ALICE, "Alice Archer"));
  relay.seed(roomRecord(GENERAL, "general", [["public"], ["t", "stream"]]));
  dmThread(relay, DM, BOARD_PERSON);
  relay.seed({
    id: "dm-hello",
    pubkey: BOARD_PERSON,
    kind: 9,
    created_at: now() - 30,
    tags: [["h", DM]],
    content: "Just between us",
    sig: "sig",
  });
  return relay;
}

async function signIn(page: Page) {
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
    window.localStorage.setItem("buzz.identity.backedUp", "1");
  }, NSEC);
  // Home reads the chain for its money parts; answer it so nothing waits on a node.
  await page.route("http://127.0.0.1:8545/**", (route) =>
    route.fulfill({
      json: { jsonrpc: "2.0", id: 1, result: "0x10" },
    }),
  );
}

/**
 * The mock server, with one thing the real server does that the mock does not: it confirms a conversation the reader
 * opens (kind 41010) with the conversation's id, and lists it. Every socket goes through the mock; only that answer
 * is rewritten.
 */
async function installConfirmingDmOpen(page: Page, relay: Relay) {
  let mockSocket: ((ws: WebSocketRoute) => void) | null = null;
  let origin: string | RegExp | null = null;
  const capture = {
    route: page.route.bind(page),
    routeWebSocket: async (
      url: string | RegExp,
      handler: (ws: WebSocketRoute) => void,
    ) => {
      origin = url;
      mockSocket = handler;
    },
  } as unknown as Page;
  await relay.install(capture);
  if (!origin || !mockSocket) throw new Error("the mock did not open a socket");
  const handler = mockSocket as (ws: WebSocketRoute) => void;
  await page.routeWebSocket(origin, (ws) => {
    const opens = new Set<string>();
    let onMessage: ((message: string | Buffer) => void) | null = null;
    ws.onMessage((message) => {
      try {
        const frame = JSON.parse(String(message));
        if (frame[0] === "EVENT" && frame[1]?.kind === 41010) {
          opens.add(frame[1].id);
          // The server opens the thread and lists it before it answers.
          dmThread(
            relay,
            NEW_DM,
            frame[1].tags.find((t: string[]) => t[0] === "p")?.[1],
          );
        }
      } catch {
        // Not a frame the mock reads either.
      }
      onMessage?.(message);
    });
    handler({
      send: (payload: string) => {
        const frame = JSON.parse(payload);
        if (frame[0] === "OK" && opens.has(frame[1])) {
          frame[3] = `response:${JSON.stringify({ channel_id: NEW_DM, created: true })}`;
          ws.send(JSON.stringify(frame));
          return;
        }
        ws.send(payload);
      },
      close: () => ws.close(),
      onClose: (fn: () => void) => ws.onClose(fn),
      onMessage: (fn: (message: string | Buffer) => void) => {
        onMessage = fn;
      },
    } as unknown as WebSocketRoute);
  });
}

async function openCommunityPanel(page: Page) {
  await page.goto("/c/alpha.example.com");
  await page.getByTestId("content-pane").waitFor();
  const opener = page.getByTestId("open-channel-list");
  if (await opener.isVisible()) await opener.click();
  await page.getByTestId("dms-toggle").click();
}

test("the community panel says what it holds and where private messages are", async ({
  page,
}) => {
  const relay = community();
  await relay.install(page);
  await signIn(page);
  await openCommunityPanel(page);
  await expect(page.getByTestId("dms-toggle")).toHaveText(
    "Notices and messages",
  );
  await expect(
    page.getByRole("heading", {
      name: "Notices and messages in this community",
    }),
  ).toBeVisible();
  const home = page.getByTestId("dm-home-messages");
  await expect(home).toHaveText("Messages on Home");
  await expect(page.getByTestId(`dm-${DM.slice(0, 8)}`)).toBeVisible({
    timeout: 20_000,
  });
  await expectAccessible(page, "the community's notices and messages");
  await home.click();
  await expect(page).toHaveURL(/\/social\/messages$/);
});

test("on a phone the community panel shows the list, then one conversation with Back", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const relay = community();
  await relay.install(page);
  await signIn(page);
  await openCommunityPanel(page);

  const list = page.getByTestId("dm-list");
  const row = page.getByTestId(`dm-${DM.slice(0, 8)}`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  // The list has the screen, not a narrow column beside an empty pane.
  const box = await list.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(340);
  await expect(
    page.getByText("Select a conversation to start reading."),
  ).toBeHidden();

  await row.click();
  await expect(page.getByText("Just between us")).toBeVisible({
    timeout: 20_000,
  });
  await expect(list).toBeHidden();
  const back = page.getByTestId("dm-back");
  await expect(back).toBeFocused();
  await expectAccessible(page, "a community conversation on a phone");

  // Back by keyboard, as by pointer: the list again, with focus on the conversation it came from.
  await page.keyboard.press("Enter");
  await expect(list).toBeVisible();
  await expect(row).toBeFocused();
  await expect(page.getByText("Just between us")).toBeHidden();
});

test("a conversation in the community is started by finding the person by name, in a dark dialog", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  const relay = community();
  await installConfirmingDmOpen(page, relay);
  await signIn(page);
  await openCommunityPanel(page);

  await page.getByTestId("new-dm-open").click();
  const dialog = page.getByTestId("new-dm-dialog");
  await expect(dialog).toBeVisible();
  // Dark mode gets a dark surface under its light text.
  const surface = await dialog.evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );
  expect(surface).not.toBe("rgb(255, 255, 255)");
  // No key format asked for: the search is the way in.
  await expect(dialog).not.toContainText("npub");
  const search = page.getByTestId("new-dm-recipient");
  await expect(search).toBeFocused();
  await expect(search).toHaveAttribute(
    "placeholder",
    "Search for someone, or paste their public key",
  );

  await search.fill("Alice");
  const result = dialog
    .getByTestId("person-search-result")
    .filter({ hasText: "Alice Archer" });
  await expect(result).toBeVisible({ timeout: 20_000 });
  await expectAccessible(page, "the new-message dialog in dark mode");
  await result.click();

  await expect
    .poll(() =>
      relay.events
        .filter((e) => e.kind === 41010 && e.pubkey === ME)
        .map((e) => e.tags.filter((t) => t[0] === "p").map((t) => t[1])),
    )
    .toEqual([[ALICE]]);
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  await expect(page.getByTestId(`dm-${NEW_DM.slice(0, 8)}`)).toContainText(
    "Alice Archer",
    { timeout: 20_000 },
  );
  await expect(
    page.getByText("Select a conversation to start reading."),
  ).toBeHidden();
});

test("a conversation the server could not start says so plainly, with the server's words under Technical details", async ({
  page,
}) => {
  const relay = community({
    refuse: (event) =>
      event.kind === 41010 ? "error: database error: down" : null,
  });
  await relay.install(page);
  await signIn(page);
  await openCommunityPanel(page);

  await page.getByTestId("new-dm-open").click();
  const dialog = page.getByTestId("new-dm-dialog");
  await page.getByTestId("new-dm-recipient").fill("Alice");
  await dialog
    .getByTestId("person-search-result")
    .filter({ hasText: "Alice Archer" })
    .click({ timeout: 20_000 });

  await expect(page.getByTestId("new-dm-error")).toHaveText(
    "Couldn't start the conversation. Try again.",
    { timeout: 15_000 },
  );
  // Not in the main copy: only inside the closed disclosure.
  await expect(dialog.getByText("error: database error: down")).toBeHidden();
  const details = page.getByTestId("new-dm-error-details");
  await details.locator("summary").click();
  await expect(details).toContainText("error: database error: down");
  // The search is still there to try again or pick someone else.
  await expect(page.getByTestId("new-dm-recipient")).toBeVisible();
});

async function answerInfo(page: Page, info: object) {
  await page.route("**/info", (route: Route) =>
    route.fulfill({ contentType: "application/nostr+json", json: info }),
  );
}

test("Messages does not offer other apps a way in on an invite-only server", async ({
  page,
}) => {
  const relay = community();
  await relay.install(page);
  await signIn(page);

  // An open server: the offer is made (the reader has not said where to reach them).
  await answerInfo(page, { name: "Open server", access: "open" });
  await page.goto("/social/messages");
  await expect(page.getByTestId("social-dm-relay-banner")).toBeVisible({
    timeout: 20_000,
  });

  await answerInfo(page, { name: "Pilot", access: "invite_only" });
  await page.reload();
  await expect(page.getByTestId("social-messages-empty")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("social-dm-relay-banner")).toHaveCount(0);
});

/** A server that keeps read state, counting the board as `counts` says, and recording every mark it is sent. */
async function offerReadState(
  page: Page,
  counts: Map<string, number>,
): Promise<{ channel_id: string; message_id: string }[]> {
  const marks: { channel_id: string; message_id: string }[] = [];
  await answerInfo(page, { buzz_v1: { version: 1, base_path: "/buzz/v1" } });
  await page.route("**/buzz/v1/me/sidebar*", (route: Route) =>
    route.fulfill({
      json: {
        account: { retention_seconds: 2592000, cutoff_ms: 0 },
        channels: [...counts].map(([id, unread]) => ({
          channel_id: id,
          name: "x",
          channel_type: "forum",
          archived: false,
          hidden: false,
          unread: { status: "exact", value: unread },
          attention: { status: "exact", value: 0 },
          latest_message_id: unread > 0 ? ANCHOR : null,
          latest_message_at: unread > 0 ? now() : null,
          latest_message_complete: true,
          threads: { items: [], complete: true },
        })),
        next_cursor: null,
      },
    }),
  );
  await page.route("**/buzz/v1/me/read-state", async (route: Route) => {
    const intents = JSON.parse(route.request().postData() ?? "{}").intents;
    for (const intent of intents) {
      marks.push(intent);
      counts.set(intent.channel_id, 0);
    }
    await route.fulfill({
      json: {
        outcomes: intents.map(() => ({ status: "applied" })),
        projection_status: "not_requested",
      },
    });
  });
  return marks;
}

test("a board read on its own page is read everywhere: Home's board list and the community's sidebar", async ({
  page,
}) => {
  const relay = community();
  relay.seed(roomRecord(BOARD, "ideas", [["public"], ["t", "forum"]]));
  relay.seed({
    id: "board-members",
    pubkey: SERVER,
    created_at: 200,
    kind: 39002,
    tags: [
      ["d", BOARD],
      ["p", ME, "", "member"],
    ],
    content: "",
    sig: "sig",
  });
  relay.seed({
    id: "board-post".padEnd(64, "0"),
    pubkey: BOARD_PERSON,
    created_at: now() - 60,
    kind: 45001,
    tags: [["h", BOARD]],
    content: "# A new idea",
    sig: "sig",
  });
  const counts = new Map([[BOARD, 2]]);
  await relay.install(page);
  await signIn(page);
  const marks = await offerReadState(page, counts);

  // Home's board list shows what is unread on a board the reader joined.
  await page.goto("/?tab=boards");
  const listed = page.getByTestId(`board-directory-${BOARD}-unread`);
  await expect(listed).toHaveText("2", { timeout: 20_000 });
  // A screen reader hears the count with the board's name.
  await expect(
    page
      .getByTestId(`board-directory-${BOARD}`)
      .getByTestId("board-directory-name"),
  ).toHaveAccessibleName(/^ideas\s*, 2 unread$/);

  // Opened from there, on its own page: the server is told once it has been on screen a moment.
  await page.goto(`/b/${BOARD}`);
  await expect
    .poll(() => marks, { timeout: 10_000 })
    .toEqual([
      { type: "mark_channel_read", channel_id: BOARD, message_id: ANCHOR },
    ]);

  await page.goto("/?tab=boards");
  await expect(page.getByTestId(`board-directory-${BOARD}`)).toBeVisible({
    timeout: 20_000,
  });
  await expect(listed).toHaveCount(0);
  await page.goto("/c/alpha.example.com");
  await page.getByTestId("content-pane").waitFor();
  await expect(page.getByTestId("board-nav-ideas")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("board-nav-ideas-unread")).toHaveCount(0);
});

/** A private message from Alice to the reader, written at `at`. */
async function messageFromAlice(relay: Relay, text: string, at: number) {
  const signer = {
    pubkey: ALICE,
    sign: async (template: {
      kind: number;
      tags: string[][];
      content: string;
    }) => finalizeEvent({ created_at: at, ...template }, hexKey(ALICE_NSEC)),
    encrypt: async (peer: string, plain: string) =>
      nip44.encrypt(plain, nip44.getConversationKey(hexKey(ALICE_NSEC), peer)),
    decrypt: async (peer: string, cipher: string) =>
      nip44.decrypt(cipher, nip44.getConversationKey(hexKey(ALICE_NSEC), peer)),
  };
  const wraps = await createDirectMessageWraps(signer as never, ME, text, at);
  relay.seed(wraps.toRecipient as never);
}

/** What this browser last saw of Messages, as an earlier visit left it. */
async function seenBefore(page: Page, since: number) {
  await page.addInitScript(
    ([me, at]) => {
      if (window.sessionStorage.getItem("seeded")) return;
      window.sessionStorage.setItem("seeded", "1");
      window.localStorage.setItem(
        `buzz.messages-seen.${window.location.host}.${me}`,
        JSON.stringify({ since: Number(at), list: 0, peers: {} }),
      );
    },
    [ME, String(since)] as const,
  );
}

test("a message newer than the reader last saw puts a dot on Messages, until they read it", async ({
  page,
}) => {
  const relay = community();
  await messageFromAlice(relay, "Are you free on Friday?", now() - 60);
  await relay.install(page);
  await signIn(page);
  await seenBefore(page, now() - 3600);

  await page.goto("/");
  const nav = page.getByTestId("social-nav-messages").first();
  await expect(page.getByTestId("social-new-messages-dot").first()).toBeVisible(
    { timeout: 20_000 },
  );
  await expect(nav).toHaveAccessibleName("Messages, new messages");
  await expectAccessible(page, "Home with new messages");

  // Reading the conversation answers it, here and after a reload.
  await page.goto(`/social/messages/${ALICE}`);
  await expect(page.getByTestId("social-thread-messages")).toContainText(
    "Are you free on Friday?",
    { timeout: 20_000 },
  );
  await expect(page.getByTestId("social-new-messages-dot")).toHaveCount(0);
  await page.goto("/");
  await expect(page.getByTestId("social-nav-messages").first()).toBeVisible();
  await page.waitForTimeout(1_500);
  await expect(page.getByTestId("social-new-messages-dot")).toHaveCount(0);
});

test("a first visit starts the record on Home: old messages are not new, later ones are", async ({
  page,
}) => {
  const relay = community();
  await messageFromAlice(relay, "From last week", now() - 7 * 86_400);
  await relay.install(page);
  await signIn(page);

  // Home only: Messages is never opened, so nothing but the first visit itself writes the record.
  await page.goto("/");
  await expect(page.getByTestId("social-nav-messages").first()).toBeVisible();
  const key = `buzz.messages-seen.${new URL(page.url()).host}.${ME}`;
  await expect
    .poll(() =>
      page.evaluate(
        (k) =>
          typeof JSON.parse(window.localStorage.getItem(k) ?? "null")?.since,
        key,
      ),
    )
    .toBe("number");
  // The inbox has been read (the nav asks for private messages) and has had time to settle into the dot or not.
  await expect.poll(() => relay.requestsFor(1059)).toBeGreaterThan(0);
  await page.waitForTimeout(1_500);
  await expect(page.getByTestId("social-new-messages-dot")).toHaveCount(0);

  // A message after the first visit is new, still without opening Messages.
  await page.waitForTimeout(1_100);
  await messageFromAlice(relay, "Hello again", now());
  await page.reload();
  await expect(page.getByTestId("social-new-messages-dot").first()).toBeVisible(
    { timeout: 20_000 },
  );
  await expect(
    page.getByTestId("social-nav-messages").first(),
  ).toHaveAccessibleName("Messages, new messages");
});

test("while a conversation is open, a new message shows within seconds", async ({
  page,
}) => {
  const relay = community();
  await messageFromAlice(relay, "First", now() - 120);
  await relay.install(page);
  await signIn(page);
  await page.goto(`/social/messages/${ALICE}`);
  const thread = page.getByTestId("social-thread-messages");
  await expect(thread).toContainText("First", { timeout: 20_000 });

  // The mock does not push private messages: only the page asking again finds it.
  await messageFromAlice(relay, "Second, a moment later", now());
  await expect(thread).toContainText("Second, a moment later", {
    timeout: 8_000,
  });
});

import { expect, type Page, type Route, test } from "@playwright/test";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import * as nip44 from "nostr-tools/nip44";

import { expectAccessible } from "../helpers/a11y";
import { createDirectMessageWraps } from "../../src/features/social/lib/nip17.ts";
import { createMockRelay } from "./mock-relay";

/**
 * Reports and the moderation tools, as the social run's moderators and members meet them: the community's queue shows
 * what was reported and by whom it was written (or whom), with links, names the person in a ban or a timeout, keeps an
 * escalated report in view and reads older ones on request; a board post's report says who reads it; a board post a
 * moderator removed says so, with the reason; appointing a board moderator from the buttons asks first; and a person
 * reported from a private conversation is told the messages are not sent.
 */

const hexKey = (hex: string) =>
  Uint8Array.from(hex.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16));
const ME_NSEC = "55".repeat(32);
const ME = getPublicKey(hexKey(ME_NSEC));
const ALICE = "a1".repeat(32);
const BOB = "b2".repeat(32);
const CAROL = "c3".repeat(32);
const ROOM = "0f0f0f0f-1111-2222-3333-444444444444";
const BOARD = "b0a4d000-1111-2222-3333-555555555555";
const HOME_POST = "e".repeat(64);
const ROOM_MESSAGE = "d".repeat(64);
const GONE_POST = "9".repeat(64);
// A room message the moderator's read does not return: removed, or in a room they aren't in.
const UNSEEN_MESSAGE = "8".repeat(64);
const now = () => Math.floor(Date.now() / 1000);

let counter = 0;
const eid = () =>
  `${(++counter).toString(16).padStart(8, "0")}`.padEnd(64, "f");

function profile(pubkey: string, name: string) {
  return {
    id: eid(),
    pubkey,
    kind: 0,
    created_at: now() - 3600,
    tags: [],
    content: JSON.stringify({ name }),
    sig: "sig",
  };
}

function reportRow(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    report_event_id: [...id]
      .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
      .join("")
      .padEnd(64, "0"),
    reporter_pubkey: BOB,
    target_kind: "event",
    target: HOME_POST,
    channel_id: null,
    report_type: "spam",
    status: "open",
    created_at: "2026-10-29T10:00:00Z",
    ...overrides,
  };
}

function communityRelay() {
  const relay = createMockRelay();
  relay.seed({
    id: "meta",
    pubkey: "9".repeat(64),
    kind: 39000,
    created_at: 100,
    tags: [
      ["d", ROOM],
      ["name", "general"],
    ],
    content: "",
    sig: "sig",
  });
  relay.seed({
    id: HOME_POST,
    pubkey: ALICE,
    kind: 1,
    created_at: now() - 60,
    tags: [],
    content: "Send me your seed phrase",
    sig: "sig",
  });
  relay.seed({
    id: ROOM_MESSAGE,
    pubkey: ALICE,
    kind: 9,
    created_at: now() - 50,
    tags: [["h", ROOM]],
    content: "You are all idiots",
    sig: "sig",
  });
  relay.seed(profile(ALICE, "Alice Reyes"));
  relay.seed(profile(BOB, "Bob Stone"));
  relay.seed(profile(CAROL, "Carol Ng"));
  return relay;
}

async function signIn(page: Page) {
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
    window.localStorage.setItem("buzz.identity.backedUp", "1");
  }, ME_NSEC);
}

/** The queue's server: `answer` decides each read from its search (`status`, `limit`); every read is kept. */
async function serveQueue(
  page: Page,
  answer: (search: URLSearchParams) => Record<string, unknown>[],
) {
  const reads: URLSearchParams[] = [];
  await page.route("**/moderation/reports*", async (route: Route) => {
    const search = new URL(route.request().url()).searchParams;
    reads.push(search);
    await route.fulfill({ json: answer(search) });
  });
  return reads;
}

async function openQueue(
  page: Page,
  relay: ReturnType<typeof createMockRelay>,
) {
  await relay.install(page);
  await signIn(page);
  await page.goto("/c/alpha.example.com");
  await page.getByTestId("moderation-toggle").click({ timeout: 20_000 });
}

const rowWith = (page: Page, text: string) =>
  page.getByTestId("moderation-report-row").filter({ hasText: text });

test("each queue row shows the reported words or person, who wrote them, and links to see them in place", async ({
  page,
}) => {
  const relay = communityRelay();
  await serveQueue(page, () => [
    reportRow("r1"),
    reportRow("r2", {
      target: ROOM_MESSAGE,
      channel_id: ROOM,
      report_type: "profanity",
    }),
    reportRow("r3", {
      target_kind: "pubkey",
      target: CAROL,
      report_type: "impersonation",
      note: "says she is the founder",
    }),
    reportRow("r4", { target: GONE_POST, report_type: "other" }),
    reportRow("r5", {
      target: UNSEEN_MESSAGE,
      channel_id: ROOM,
      report_type: "other",
    }),
  ]);
  await openQueue(page, relay);

  const home = rowWith(page, "Send me your seed phrase");
  await expect(home).toContainText("about a post on Home");
  await expect(home).toContainText("Written by Alice Reyes");
  await expect(home).toContainText("Reported by Bob Stone");
  await expect(home.getByTestId("moderation-report-author")).toHaveAttribute(
    "href",
    `/u/${ALICE}`,
  );
  await expect(home.getByTestId("moderation-report-link")).toHaveAttribute(
    "href",
    `/social/post/${HOME_POST}`,
  );

  const room = rowWith(page, "You are all idiots");
  await expect(room).toContainText("about a message");
  await expect(room.getByTestId("moderation-report-link")).toHaveAttribute(
    "href",
    `/c/alpha.example.com?channel=${ROOM}&message=${ROOM_MESSAGE}`,
  );

  const person = rowWith(page, "says she is the founder");
  await expect(person.getByTestId("moderation-report-person")).toHaveText(
    "Carol Ng",
  );
  await expect(person.getByTestId("moderation-report-person")).toHaveAttribute(
    "href",
    `/u/${CAROL}`,
  );

  // Words the server no longer has are said to be gone, not shown as empty.
  await expect(page.getByTestId("moderation-report-gone")).toHaveCount(1);
  await expect(page.getByTestId("moderation-report-gone")).toContainText(
    "aren’t here any more",
  );
  // A room message the read did not return may still be up in a room the moderator isn't in: never call it gone.
  await expect(page.getByTestId("moderation-report-not-found")).toHaveCount(1);
  await expect(page.getByTestId("moderation-report-not-found")).toContainText(
    "or be in a room or board you aren’t in",
  );
  // No key is shown where a name is known.
  await expect(page.getByTestId("moderation-queue-panel")).not.toContainText(
    ALICE.slice(0, 8),
  );
  await expectAccessible(page, "the moderation queue with reported words");
});

test("a ban from the queue names the person, and a timeout says whom it is for", async ({
  page,
}) => {
  const relay = communityRelay();
  await serveQueue(page, () => [
    reportRow("r2", {
      target: ROOM_MESSAGE,
      channel_id: ROOM,
      report_type: "profanity",
    }),
    reportRow("r3", { target_kind: "pubkey", target: CAROL }),
  ]);
  await openQueue(page, relay);

  const room = rowWith(page, "You are all idiots");
  await room.getByTestId("moderation-timeout").click();
  await expect(room.getByTestId("timeout-choices")).toContainText(
    "Mute Alice Reyes everywhere in this community for",
  );
  await room.getByRole("button", { name: "Cancel" }).click();

  const person = rowWith(page, "Carol Ng");
  await person.getByTestId("moderation-ban").click();
  const confirm = page.getByTestId("confirm-dialog");
  await expect(confirm).toContainText("Ban Carol Ng?");
  await expect(confirm).toContainText("Carol Ng can no longer post");
  await confirm.getByTestId("confirm-accept").click();
  await expect
    .poll(() => relay.events.find((event) => event.kind === 9040)?.tags)
    .toContainEqual(["p", CAROL]);
  await expect(person.getByTestId("moderation-report-status")).toHaveText(
    "Resolved",
  );
});

test("an escalated report stays in view with its status, the Escalated filter reads escalated ones, and Show older reads further back", async ({
  page,
}) => {
  const relay = communityRelay();
  let escalated = false;
  const reads = await serveQueue(page, (search) => {
    const status = search.get("status");
    const limit = Number(search.get("limit"));
    if (status === "open") return escalated ? [] : [reportRow("r1")];
    if (status === "escalated")
      return escalated ? [reportRow("r1", { status: "escalated" })] : [];
    // All: a full first page, and fewer than a full second.
    const count = limit >= 60 ? 45 : limit;
    return Array.from({ length: count }, (_, at) =>
      reportRow(`old${at}`, { status: "dismissed", note: `old report ${at}` }),
    );
  });
  await openQueue(page, relay);

  // A full page: there may be older ones.
  await expect(page.getByTestId("moderation-report-row")).toHaveCount(30);
  await page.getByTestId("moderation-show-older").click();
  await expect(page.getByTestId("moderation-report-row")).toHaveCount(45);
  expect(reads.some((search) => search.get("limit") === "60")).toBe(true);
  await expect(page.getByTestId("moderation-show-older")).toHaveCount(0);

  await page.getByTestId("moderation-filter-open").click();
  await expect(page.getByTestId("moderation-filter-open")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const row = rowWith(page, "Send me your seed phrase");
  await expect(row).toHaveCount(1);
  await row.getByTestId("moderation-escalate").click();
  escalated = true;
  await expect
    .poll(
      () =>
        relay.events
          .find((event) => event.kind === 9044)
          ?.tags.find((tag) => tag[0] === "action")?.[1],
    )
    .toBe("escalate");
  // The open read no longer has it, and it is still on screen, said to be escalated.
  await expect
    .poll(
      () => reads.filter((search) => search.get("status") === "open").length,
    )
    .toBeGreaterThanOrEqual(2);
  await expect(row.getByTestId("moderation-report-status")).toHaveText(
    "Escalated",
  );
  await expect(row.getByTestId("moderation-report-escalated")).toBeVisible();

  await page.getByTestId("moderation-filter-escalated").click();
  await expect(rowWith(page, "Send me your seed phrase")).toContainText(
    "Escalated",
  );
  expect(reads.at(-1)?.get("status")).toBe("escalated");
});

// The board's own records, as in board-moderation.spec.ts.
const SERVER = "5e".repeat(32);

function boardRecord(kind: number, tags: string[][], content = "", at = 100) {
  return {
    id: eid(),
    pubkey: SERVER,
    created_at: at,
    kind,
    tags,
    content,
    sig: "sig",
  };
}

function boardPost(author: string, title: string) {
  return {
    id: eid(),
    pubkey: author,
    created_at: now() - 600,
    kind: 45001,
    tags: [["h", BOARD]],
    content: `# ${title}`,
    sig: "sig",
  };
}

function boardRelay(role: "owner" | "member", ...events: object[]) {
  const relay = createMockRelay({ applyDeletions: true });
  relay.seed(
    boardRecord(39000, [
      ["d", BOARD],
      ["name", "supporters"],
      ["public"],
      ["t", "forum"],
    ]),
  );
  relay.seed(
    boardRecord(39002, [
      ["d", BOARD],
      ["p", ALICE, "", "member"],
      ["p", CAROL, "", "member"],
      ["p", ME, "", role],
    ]),
  );
  relay.seed(profile(ALICE, "Alice Reyes"));
  relay.seed(profile(CAROL, "Carol Ng"));
  for (const event of events) relay.seed(event as never);
  return relay;
}

async function openBoard(
  page: Page,
  relay: ReturnType<typeof createMockRelay>,
  postId?: string,
) {
  await relay.install(page);
  await signIn(page);
  await page.goto(
    `/c/alpha.example.com?channel=${BOARD}${postId ? `&post=${postId}` : ""}`,
  );
  await page.getByTestId("content-pane").waitFor();
}

test("reporting a board post says its moderators see the report without the reporter's name", async ({
  page,
}) => {
  const theirs = boardPost(ALICE, "Buy my course");
  const relay = boardRelay("member", theirs);
  await openBoard(page, relay, theirs.id);
  await page.getByTestId("board-report-post").click({ timeout: 20_000 });
  const privacy = page.getByTestId("report-privacy");
  await expect(privacy).toContainText(
    "Board moderators don't see who reported. The community's moderators do.",
  );
});

test("a board post a moderator removed says so, with the reason from the board's log", async ({
  page,
}) => {
  // Not all digits: the address would read an all-digit id as a number.
  const removed = "7a".repeat(32);
  const relay = boardRelay(
    "member",
    boardRecord(
      45004,
      [
        ["h", BOARD],
        ["action", "remove"],
        ["actor", CAROL],
        ["role", "moderator"],
        ["e", removed],
        ["p", ALICE],
      ],
      "Spam link",
      now() - 30,
    ),
  );
  await openBoard(page, relay, removed);
  const missing = page.getByTestId("board-missing-post");
  await expect(missing).toContainText("A moderator removed this post.", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("board-missing-post-reason")).toHaveText(
    "Reason: Spam link",
  );
  await expect(missing).not.toContainText("It may have been deleted");
});

test("appointing a board moderator from the buttons asks first, naming them; the box takes a profile link", async ({
  page,
}) => {
  const relay = boardRelay("owner", boardPost(ALICE, "Hello"));
  await openBoard(page, relay);
  await page.getByTestId("board-moderation-toggle").click({ timeout: 20_000 });
  await expect(page.getByTestId("board-appoint-person")).toHaveAttribute(
    "placeholder",
    "Their profile link",
  );

  await page
    .getByTestId("board-appoint-candidate")
    .filter({ hasText: "Alice Reyes" })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(
    "Make Alice Reyes a moderator of this board?",
  );
  await expectAccessible(page, "the appoint-a-moderator confirmation");
  // Nothing is sent until it is confirmed; Cancel sends nothing.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  expect(relay.events.filter((event) => event.kind === 9052)).toHaveLength(0);

  await page
    .getByTestId("board-appoint-candidate")
    .filter({ hasText: "Alice Reyes" })
    .click();
  await page.getByTestId("board-appoint-confirm").click();
  await expect
    .poll(() => relay.events.find((event) => event.kind === 9052)?.tags)
    .toEqual([
      ["h", BOARD],
      ["p", ALICE],
    ]);

  await page
    .getByTestId("board-appoint-person")
    .fill(`https://alpha.example.com/u/${CAROL}`);
  await page.getByTestId("board-appoint-submit").click();
  await expect
    .poll(() =>
      relay.events
        .filter((event) => event.kind === 9052)
        .map((event) => event.tags[1]?.[1]),
    )
    .toContain(CAROL);
});

test("reporting someone from a private conversation says the messages are not sent, and asks what happened", async ({
  page,
}) => {
  const ALICE_NSEC = "99".repeat(32);
  const alice = getPublicKey(hexKey(ALICE_NSEC));
  const relay = createMockRelay();
  relay.seed(profile(alice, "Alice Archer"));
  const signer = {
    pubkey: alice,
    sign: async (template: {
      kind: number;
      tags: string[][];
      content: string;
    }) =>
      finalizeEvent(
        { created_at: now() - 60, ...template },
        hexKey(ALICE_NSEC),
      ),
    encrypt: async (peer: string, text: string) =>
      nip44.encrypt(text, nip44.getConversationKey(hexKey(ALICE_NSEC), peer)),
    decrypt: async (peer: string, text: string) =>
      nip44.decrypt(text, nip44.getConversationKey(hexKey(ALICE_NSEC), peer)),
  };
  const dm = await createDirectMessageWraps(
    signer as never,
    ME,
    "Send me money or else",
  );
  relay.seed(dm.toRecipient as never);
  await relay.install(page);
  await signIn(page);
  await page.goto("/social/messages");
  await page.getByTestId("social-conversation").click({ timeout: 20_000 });
  await expect(page.getByTestId("social-thread-messages")).toContainText(
    "Send me money",
    { timeout: 20_000 },
  );

  await page.getByTestId("conversation-report").click();
  await expect(page.getByTestId("report-evidence")).toHaveText(
    "Your messages with them are not sent with the report. Say in the note what happened.",
  );
  await expect(page.getByLabel("What happened? (optional)")).toBeVisible();
  await page.getByTestId("report-reason-other").check();
  await page.getByTestId("report-note").fill("Threatened me");
  await page.getByTestId("report-submit").click();
  await expect(page.getByTestId("report-form")).toHaveCount(0);
  const sent = relay.events.filter((event) => event.kind === 1984);
  expect(sent).toHaveLength(1);
  // The person and the note only: nothing from the conversation.
  expect(sent[0].tags).toEqual([["p", alice, "other"]]);
  expect(sent[0].content).toBe("Threatened me");
});

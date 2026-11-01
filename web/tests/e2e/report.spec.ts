import { expect, test, type Page } from "@playwright/test";
import { getPublicKey, verifyEvent } from "nostr-tools/pure";

import { expectAccessible } from "../helpers/a11y";
import { expectNoSidewaysScroll, PHONE } from "../helpers/layout";
import { COMMUNITY_HOST, createMockRelay } from "./mock-relay";

/**
 * Reporting a message or a post to the community's moderators. The server's own checks (the target must exist in this
 * community, one of seven reasons) are covered by its tests and by `scripts/web-invite-only-e2e.sh`; here the spec
 * checks what the app sends and what it does with each answer.
 */

const NSEC = "55".repeat(32);
const ME = getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);
const ALICE = "b".repeat(64);
const CHANNEL_ID = "0f0f0f0f-1111-2222-3333-444444444444";
const THEIR_MESSAGE = "c".repeat(64);
const MY_MESSAGE = "d".repeat(64);
const THEIR_POST = "e".repeat(64);
const now = () => Math.floor(Date.now() / 1000);

async function signIn(page: Page) {
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
    window.localStorage.setItem("buzz.identity.backedUp", "1");
  }, NSEC);
}

function chatRelay(
  refuse?: string,
  /** The community's list of people, as [key, role]; absent for a community that has none. */
  members?: [string, string][],
) {
  const relay = createMockRelay({
    refuse: (event) => (refuse && event.kind === 1984 ? refuse : undefined),
  });
  if (members) {
    relay.seed({
      id: "member-list",
      pubkey: "d".repeat(64),
      created_at: 200,
      kind: 13534,
      tags: members.map(([key, role]) => ["member", key, role]),
      content: "",
      sig: "sig",
    });
  }
  relay.seed({
    id: "meta",
    pubkey: "9".repeat(64),
    kind: 39000,
    created_at: 100,
    tags: [
      ["d", CHANNEL_ID],
      ["name", "general"],
    ],
    content: "",
    sig: "sig",
  });
  for (const [id, pubkey, text] of [
    [THEIR_MESSAGE, ALICE, "Buy my coin at example dot com"],
    [MY_MESSAGE, ME, "A message of mine"],
  ] as const) {
    relay.seed({
      id,
      pubkey,
      kind: 9,
      created_at: now() - 60,
      tags: [["h", CHANNEL_ID]],
      content: text,
      sig: "sig",
    });
  }
  return relay;
}

async function openChat(
  page: Page,
  relay: ReturnType<typeof chatRelay>,
  /** On a phone the channel list is a drawer: open it first. */
  phone = false,
) {
  await relay.install(page);
  await signIn(page);
  await page.goto(`/c/${COMMUNITY_HOST}`);
  await page.getByTestId("content-pane").waitFor();
  if (phone) await page.getByTestId("open-channel-list").click();
  await page.getByTestId("channel-general").click();
  await expect(page.getByText("Buy my coin at example dot com")).toBeVisible({
    timeout: 20_000,
  });
}

const theirRow = (page: Page) =>
  page.getByTestId("message-row").filter({ hasText: "Buy my coin" });

test("a message by someone else can be reported with a reason and a note, and it is signed by the reporter", async ({
  page,
}) => {
  const relay = chatRelay();
  await openChat(page, relay);

  await theirRow(page).hover();
  await theirRow(page).getByTestId("report-button").click();
  await expect(page.getByRole("dialog")).toContainText(
    "The moderators see this report and your name.",
  );
  // A reason has to be chosen first: nothing is sent without one.
  await expect(page.getByTestId("report-submit")).toBeDisabled();
  await page.getByTestId("report-reason-spam").check();
  await page.getByTestId("report-note").fill("  a scam link  ");
  await page.getByTestId("report-submit").click();
  await expect(page.getByTestId("report-form")).toHaveCount(0);

  const sent = relay.events.filter((event) => event.kind === 1984);
  expect(sent).toHaveLength(1);
  expect(sent[0].tags).toContainEqual(["e", THEIR_MESSAGE, "spam"]);
  expect(sent[0].tags).toContainEqual(["p", ALICE]);
  expect(sent[0].content).toBe("a scam link");
  expect(sent[0].pubkey).toBe(ME);
  expect(verifyEvent(sent[0] as never)).toBe(true);
});

test("your own messages have no Report, and other people's do", async ({
  page,
}) => {
  const relay = chatRelay();
  await openChat(page, relay);
  const mine = page
    .getByTestId("message-row")
    .filter({ hasText: "A message of mine" });
  await mine.hover();
  await expect(mine.getByTestId("report-button")).toHaveCount(0);
  await expect(theirRow(page).getByTestId("report-button")).toHaveCount(1);
});

test("cancelling a report sends nothing", async ({ page }) => {
  const relay = chatRelay();
  await openChat(page, relay);
  await theirRow(page).hover();
  await theirRow(page).getByTestId("report-button").click();
  await page.getByTestId("report-reason-other").check();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("report-form")).toHaveCount(0);
  expect(relay.events.filter((event) => event.kind === 1984)).toHaveLength(0);
});

test("when the server will not take the report, its words are shown and the form stays open", async ({
  page,
}) => {
  const relay = chatRelay("invalid: report target event not found");
  await openChat(page, relay);
  await theirRow(page).hover();
  await theirRow(page).getByTestId("report-button").click();
  await page.getByTestId("report-reason-spam").check();
  await page.getByTestId("report-submit").click();
  // Plain words in main copy; the server's own words only under Technical details.
  await expect(page.getByTestId("report-error")).toHaveText(
    "Report target event not found.",
  );
  const details = page.getByTestId("report-error-details");
  await expect(details).toHaveJSProperty("open", false);
  await details.locator("summary").click();
  await expect(details).toContainText("invalid: report target event not found");
  await expect(page.getByTestId("report-form")).toBeVisible();
  // Try again once the reason is changed: the old answer is gone with the next attempt.
  await expect(page.getByTestId("report-submit")).toBeEnabled();
});

test("a post by someone else on Home can be reported, and your own cannot", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed({
    id: THEIR_POST,
    pubkey: ALICE,
    kind: 1,
    created_at: now() - 60,
    tags: [],
    content: "Send me your seed phrase",
    sig: "sig",
  });
  await relay.install(page);
  await signIn(page);
  await page.goto("/");
  await page.getByTestId("social-composer-input").fill("A note of my own");
  await page.getByTestId("social-composer-submit").click();
  const mine = page
    .getByTestId("social-post")
    .filter({ hasText: "A note of my own" });
  await expect(mine).toBeVisible();
  await expect(mine.getByTestId("social-report")).toHaveCount(0);

  const theirs = page
    .getByTestId("social-post")
    .filter({ hasText: "Send me your seed phrase" });
  await theirs.getByTestId("social-report").click();
  await page.getByTestId("report-reason-spam").check();
  await page.getByTestId("report-submit").click();
  await expect(page.getByTestId("report-form")).toHaveCount(0);

  const sent = relay.events.filter((event) => event.kind === 1984);
  expect(sent).toHaveLength(1);
  expect(sent[0].tags).toContainEqual(["e", THEIR_POST, "spam"]);
  expect(sent[0].tags).toContainEqual(["p", ALICE]);
});

test("every signed read carries its own nonce, so the moderator check and the queue read are never the same request", async ({
  page,
}) => {
  const relay = chatRelay();
  const seen: string[] = [];
  await page.route("**/moderation/reports*", async (route) => {
    seen.push(route.request().headers().authorization ?? "");
    await route.fulfill({ json: { reports: [] } });
  });
  await relay.install(page);
  await signIn(page);
  await page.goto(`/c/${COMMUNITY_HOST}`);
  await page.getByTestId("moderation-toggle").click({ timeout: 20_000 });
  await expect.poll(() => seen.length).toBeGreaterThanOrEqual(2);

  const events = seen.map((header) =>
    JSON.parse(atob(header.slice("Nostr ".length))),
  );
  const nonces = events.map(
    (event) => event.tags.find((tag: string[]) => tag[0] === "nonce")?.[1],
  );
  for (const nonce of nonces) expect(nonce).toBeTruthy();
  // A server that has seen an authorization refuses it a second time, so two reads must never share one.
  expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
  expect(new Set(nonces).size).toBe(nonces.length);
});

test("the moderation queue names the person who reported, not their key", async ({
  page,
}) => {
  const relay = chatRelay();
  relay.seed({
    id: "alice-profile",
    pubkey: ALICE,
    kind: 0,
    created_at: now() - 3600,
    tags: [],
    content: JSON.stringify({ name: "Alice Reyes" }),
    sig: "sig",
  });
  await page.route("**/moderation/reports*", async (route) => {
    await route.fulfill({
      json: [
        {
          id: "r1",
          report_event_id: "f".repeat(64),
          reporter_pubkey: ALICE,
          target_kind: "event",
          target: THEIR_MESSAGE,
          report_type: "spam",
          status: "open",
          created_at: "2026-10-13T10:00:00Z",
        },
      ],
    });
  });
  await relay.install(page);
  await signIn(page);
  await page.goto(`/c/${COMMUNITY_HOST}`);
  await page.getByTestId("moderation-toggle").click({ timeout: 20_000 });
  const row = page.getByTestId("moderation-report-row");
  await expect(row).toContainText("Reported by Alice Reyes");
  await expect(row).not.toContainText(ALICE.slice(0, 8));
});

test("the report dialog is accessible, with an error showing", async ({
  page,
}) => {
  const relay = chatRelay("invalid: report target event not found");
  await openChat(page, relay);
  await theirRow(page).hover();
  await theirRow(page).getByTestId("report-button").click();
  await page.getByTestId("report-reason-spam").check();
  await page.getByTestId("report-submit").click();
  await expect(page.getByTestId("report-error")).toBeVisible();
  await expectAccessible(page, "report dialog");
});

test("the message actions are reachable and visible from the keyboard, not only on hover", async ({
  page,
}) => {
  const relay = chatRelay();
  await openChat(page, relay);
  const button = theirRow(page).getByTestId("report-button");
  const actions = button.locator("..");
  // Hidden until the row is hovered or something inside it has focus.
  await page.mouse.move(0, 0);
  await expect(actions).toHaveCSS("opacity", "0");
  await button.focus();
  await expect(actions).toHaveCSS("opacity", "1");
  // And it works from the keyboard: Enter opens the dialog.
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("report-form")).toBeVisible();
});

test("the report dialog fits a phone", async ({ page }) => {
  await page.setViewportSize(PHONE);
  const relay = chatRelay();
  await openChat(page, relay, true);
  await theirRow(page).hover();
  await theirRow(page).getByTestId("report-button").click();
  await expect(page.getByTestId("report-form")).toBeVisible();
  await expectNoSidewaysScroll(page, "the report dialog on a phone");
  // Both buttons can be reached without scrolling the page sideways.
  await expect(page.getByTestId("report-submit")).toBeInViewport();
});

test("the owner can ban the person who wrote a message, even a visitor who is not on the list", async ({
  page,
}) => {
  // ALICE wrote it and is not on the community's list, as a visitor to an open community would not be.
  const relay = chatRelay(undefined, [[ME, "owner"]]);
  await openChat(page, relay);

  await expect(
    page
      .getByTestId("message-row")
      .filter({ hasText: "A message of mine" })
      .getByTestId("ban-author-button"),
  ).toHaveCount(0);

  await theirRow(page).hover();
  await theirRow(page).getByTestId("ban-author-button").click();
  await expect(page.getByTestId("ban-form")).toContainText(
    "even with an invite link",
  );
  await page.getByTestId("ban-length").selectOption({ label: "1 day" });
  await page.getByTestId("ban-reason").fill("Scam links");
  const before = Math.floor(Date.now() / 1000);
  await page.getByTestId("ban-yes").click();
  await expect(page.getByTestId("ban-form")).toHaveCount(0);

  const sent = relay.events.filter((event) => event.kind === 9040);
  expect(sent).toHaveLength(1);
  expect(sent[0].pubkey).toBe(ME);
  expect(sent[0].tags).toContainEqual(["p", ALICE]);
  expect(sent[0].tags).toContainEqual(["reason", "Scam links"]);
  const until = Number(
    sent[0].tags.find((tag) => tag[0] === "expiration")?.[1],
  );
  expect(until).toBeGreaterThanOrEqual(before + 86_400);
  expect(until).toBeLessThan(before + 86_400 + 120);
});

test("an admin can ban a member or a visitor from a message but not the owner or another admin", async ({
  page,
}) => {
  const BOB = "1".repeat(64);
  const relay = chatRelay(undefined, [
    [ALICE, "owner"],
    [ME, "admin"],
    [BOB, "admin"],
  ]);
  relay.seed({
    id: "f".repeat(64),
    pubkey: BOB,
    kind: 9,
    created_at: now() - 50,
    tags: [["h", CHANNEL_ID]],
    content: "Another admin speaking",
    sig: "sig",
  });
  relay.seed({
    id: "9".repeat(64),
    pubkey: "2".repeat(64),
    kind: 9,
    created_at: now() - 40,
    tags: [["h", CHANNEL_ID]],
    content: "A visitor speaking",
    sig: "sig",
  });
  await openChat(page, relay);
  await expect(page.getByText("A visitor speaking")).toBeVisible();

  // The visitor: Ban. That only appears once the community's list of people has loaded, so it is checked first, and
  // the rest are not passing just because nothing has loaded yet.
  await expect(
    page
      .getByTestId("message-row")
      .filter({ hasText: "A visitor speaking" })
      .getByTestId("ban-author-button"),
  ).toHaveCount(1);
  // The owner wrote "Buy my coin": no Ban. Another admin wrote the next: no Ban.
  await expect(theirRow(page).getByTestId("ban-author-button")).toHaveCount(0);
  await expect(
    page
      .getByTestId("message-row")
      .filter({ hasText: "Another admin speaking" })
      .getByTestId("ban-author-button"),
  ).toHaveCount(0);
});

test("a member is offered no Ban on anyone's message", async ({ page }) => {
  const relay = chatRelay(undefined, [
    [ALICE, "owner"],
    [ME, "member"],
  ]);
  // Someone an owner or admin could ban, so that a Ban offered by mistake would show.
  relay.seed({
    id: "8".repeat(64),
    pubkey: "3".repeat(64),
    kind: 9,
    created_at: now() - 30,
    tags: [["h", CHANNEL_ID]],
    content: "A visitor speaking",
    sig: "sig",
  });
  await openChat(page, relay);
  await expect(page.getByText("A visitor speaking")).toBeVisible();
  // Nothing to see until the list of people has been read; wait for that, then for the page to act on it.
  await expect.poll(() => relay.requestsFor(13534)).toBeGreaterThan(0);
  await page.waitForTimeout(500);
  await expect(page.getByTestId("ban-author-button")).toHaveCount(0);
});

test("when the server will not ban someone, its words are shown in the dialog", async ({
  page,
}) => {
  const relay = createMockRelay({
    refuse: (event) =>
      event.kind === 9040
        ? "actor not authorized: moderator access required"
        : undefined,
  });
  relay.seed({
    id: "meta",
    pubkey: "9".repeat(64),
    kind: 39000,
    created_at: 100,
    tags: [
      ["d", CHANNEL_ID],
      ["name", "general"],
    ],
    content: "",
    sig: "sig",
  });
  relay.seed({
    id: "member-list",
    pubkey: "d".repeat(64),
    created_at: 200,
    kind: 13534,
    tags: [["member", ME, "owner"]],
    content: "",
    sig: "sig",
  });
  relay.seed({
    id: THEIR_MESSAGE,
    pubkey: ALICE,
    kind: 9,
    created_at: now() - 60,
    tags: [["h", CHANNEL_ID]],
    content: "Buy my coin at example dot com",
    sig: "sig",
  });
  await openChat(page, relay);
  await theirRow(page).getByTestId("ban-author-button").click();
  await page.getByTestId("ban-length").selectOption({ label: "For good" });
  await page.getByTestId("ban-yes").click();
  // Plain words in main copy; the server's own words only under Technical details.
  await expect(page.getByTestId("ban-error")).toHaveText(
    "The server did not ban them. Try again, or ask the community's owner.",
  );
  const details = page.getByTestId("ban-error-details");
  await expect(details).toHaveJSProperty("open", false);
  await details.locator("summary").click();
  await expect(details).toContainText(
    "actor not authorized: moderator access required",
  );
  await expect(page.getByTestId("ban-form")).toBeVisible();
});

test("a post by someone else on Home can be banned for, by the owner, and the dialog is accessible", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed({
    id: "member-list",
    pubkey: "d".repeat(64),
    created_at: 200,
    kind: 13534,
    tags: [["member", ME, "owner"]],
    content: "",
    sig: "sig",
  });
  relay.seed({
    id: THEIR_POST,
    pubkey: ALICE,
    kind: 1,
    created_at: now() - 60,
    tags: [],
    content: "Send me your seed phrase",
    sig: "sig",
  });
  await relay.install(page);
  await signIn(page);
  await page.goto("/");
  const theirs = page
    .getByTestId("social-post")
    .filter({ hasText: "Send me your seed phrase" });
  await theirs.getByTestId("social-ban").click();
  await expect(page.getByTestId("ban-form")).toBeVisible();
  await expectAccessible(page, "the ban dialog on a post");
  await page.getByTestId("ban-length").selectOption({ label: "For good" });
  await page.getByTestId("ban-yes").click();
  await expect(page.getByTestId("ban-form")).toHaveCount(0);
  const sent = relay.events.filter((event) => event.kind === 9040);
  expect(sent).toHaveLength(1);
  expect(sent[0].tags).toContainEqual(["p", ALICE]);
  expect(sent[0].tags.some((tag) => tag[0] === "expiration")).toBe(false);
});

test("a member's sidebar is rooms, boards and messages; whoever runs the community also sees the setup, wiki, helpers, work and org pages", async ({
  page,
}) => {
  const relay = chatRelay();
  let moderator = false;
  await page.route("**/moderation/reports*", async (route) => {
    if (moderator) await route.fulfill({ json: { reports: [] } });
    else await route.fulfill({ status: 403, body: "" });
  });
  await relay.install(page);
  await signIn(page);
  const runOnly = [
    "start-project-toggle",
    "wiki-toggle",
    "fleet-toggle",
    "work-toggle",
    "org-toggle",
  ];

  // A member: the server refuses the moderator check, and none of them is offered.
  const refused = page.waitForResponse("**/moderation/reports*");
  await page.goto(`/c/${COMMUNITY_HOST}`);
  await refused;
  await expect(page.getByTestId("dms-toggle")).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(500);
  for (const testId of [...runOnly, "moderation-toggle"]) {
    await expect(page.getByTestId(testId)).toHaveCount(0);
  }
  // People is theirs too (D110): who is in, with nothing to change.
  await page.getByTestId("people-toggle").click();
  await expect(page.getByTestId("people-section")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("invite-maker")).toHaveCount(0);
  await expect(page.getByTestId("access-control")).toHaveCount(0);
  await expect(page.getByTestId("org-budgets-section")).toHaveCount(0);
  await expectAccessible(page, "people, member");
  // A link still opens one of those pages for them.
  await page.goto(`/c/${COMMUNITY_HOST}?view=wiki`);
  await expect(page.getByTestId("wiki-page-list")).toBeVisible({
    timeout: 20_000,
  });

  // Someone who moderates here sees the pages that run it; setting it up stays with an owner or admin, which the member
  // list does not say this moderator is.
  moderator = true;
  await page.goto(`/c/${COMMUNITY_HOST}`);
  for (const testId of [
    ...runOnly.filter((id) => id !== "start-project-toggle"),
    "moderation-toggle",
    "people-toggle",
  ]) {
    await expect(page.getByTestId(testId)).toBeVisible({ timeout: 20_000 });
  }
  await expect(page.getByTestId("start-project-toggle")).toHaveCount(0);
});

const ADMIN = "https://admin.test";

/** A community queue read answered with one report about Alice's message, in the status given. */
async function serveQueue(page: Page, status: string) {
  await page.route("**/moderation/reports*", async (route) => {
    await route.fulfill({
      json: [
        {
          id: "q1",
          report_event_id: "f".repeat(64),
          reporter_pubkey: ALICE,
          target_kind: "event",
          target: THEIR_MESSAGE,
          channel_id: CHANNEL_ID,
          report_type: "spam",
          status,
          created_at: "2026-10-13T10:00:00Z",
        },
      ],
    });
  });
}

/**
 * The server's admin API, which the real server answers only for the people who run it: the info document says where
 * it is, and `operator` says whether the probe accepts this person. Every request is kept, with its parsed body.
 */
async function serveAdmin(
  page: Page,
  operator: boolean,
  { dealtWith = false }: { dealtWith?: boolean } = {},
) {
  const asked: { method: string; path: string; body: unknown; auth: string }[] =
    [];
  let escalated = true;
  await page.route("**/info", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/nostr+json",
      body: JSON.stringify({ name: "Mock server", admin_api: ADMIN }),
    });
  });
  await page.route(`${ADMIN}/**`, async (route) => {
    const request = route.request();
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "GET, POST",
    };
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    const path = new URL(request.url()).pathname.replace("/api/admin/v1", "");
    if (path === "/reports/r1/resolve") escalated = false;
    asked.push({
      method: request.method(),
      path,
      body: request.postData() ? JSON.parse(request.postData() ?? "") : null,
      auth: request.headers().authorization ?? "",
    });
    if (dealtWith && path === "/reports/r1/reopen") {
      // Someone else dealt with it after the list was read: no longer escalated, so the fenced reopen is refused.
      escalated = false;
      await route.fulfill({
        status: 409,
        headers: cors,
        json: {
          error: {
            code: "conflict",
            message:
              "report is not reopenable (current status: dismissed, expected: escalated)",
          },
        },
      });
      return;
    }
    if (!operator) {
      await route.fulfill({
        status: 403,
        headers: cors,
        json: {
          error: { code: "forbidden", message: "request is not authorized" },
        },
      });
      return;
    }
    const json =
      path === "/probe"
        ? {
            status: "ok",
            authMode: "nip98",
            role: "operator",
            source: "config",
            canAct: true,
            canStaff: true,
          }
        : path === "/reports"
          ? escalated
            ? [
                {
                  id: "r1",
                  communityId: "c1",
                  communityHost: "alpha.example.com",
                  reportEventId: "f".repeat(64),
                  reporterPubkey: ALICE,
                  targetKind: "event",
                  target: THEIR_MESSAGE,
                  targetAuthorPubkey: ALICE,
                  channelId: CHANNEL_ID,
                  reportType: "spam",
                  note: "a scam link",
                  status: "escalated",
                  resolvedBy: ME,
                  resolvedAt: "2026-10-30T09:00:00Z",
                  actionId: null,
                  createdAt: "2026-10-29T09:00:00Z",
                },
              ]
            : []
          : path === "/reports/r1"
            ? { message: { content: "Buy my coin at example dot com" } }
            : path === "/reports/r1/resolve"
              ? { status: "resolved", activeAction: null }
              : { status: "open" };
    await route.fulfill({ headers: cors, json });
  });
  return asked;
}

test("a report sent on to the server's owner says so, and that they have not acted yet", async ({
  page,
}) => {
  const relay = chatRelay();
  await serveQueue(page, "escalated");
  await relay.install(page);
  await signIn(page);
  await page.goto(`/c/${COMMUNITY_HOST}`);
  await page.getByTestId("moderation-toggle").click({ timeout: 20_000 });
  const row = page.getByTestId("moderation-report-row");
  await expect(row.getByTestId("moderation-report-escalated")).toHaveText(
    "Sent to the server’s owner. They haven’t acted on it yet.",
  );
});

test("an open report offers to send it to the server's owner, in those words", async ({
  page,
}) => {
  const relay = chatRelay();
  await serveQueue(page, "open");
  await relay.install(page);
  await signIn(page);
  await page.goto(`/c/${COMMUNITY_HOST}`);
  await page.getByTestId("moderation-toggle").click({ timeout: 20_000 });
  await expect(page.getByTestId("moderation-escalate")).toHaveText(
    "Send to the server’s owner",
  );
});

test("the server's owner sees each escalated report, who sent it, the community and the post, and removes it", async ({
  page,
}) => {
  const relay = chatRelay();
  relay.seed({
    id: "alice-profile",
    pubkey: ALICE,
    kind: 0,
    created_at: now() - 3600,
    tags: [],
    content: JSON.stringify({ name: "Alice Reyes" }),
    sig: "sig",
  });
  await serveQueue(page, "open");
  await relay.install(page);
  const asked = await serveAdmin(page, true);
  await signIn(page);
  await page.goto(`/c/${COMMUNITY_HOST}`);
  await page.getByTestId("moderation-toggle").click({ timeout: 20_000 });

  const list = page.getByTestId("escalated-reports");
  const row = list.getByTestId("escalated-report-row");
  await expect(row).toContainText("Spam · about a message or board post");
  await expect(row.getByTestId("escalated-report-community")).toContainText(
    "In alpha.example.com · sent on",
  );
  await expect(row.getByTestId("escalated-report-words")).toContainText(
    "Buy my coin at example dot com",
  );
  await expect(row.getByTestId("escalated-report-reporter")).toHaveText(
    "Reported by Alice Reyes",
  );
  await expect(row).toContainText("Why: “a scam link”");
  // Only escalated reports are read, and every read is signed by this person.
  const read = asked.find((r) => r.path === "/reports");
  expect(read?.auth.startsWith("Nostr ")).toBe(true);
  await expectAccessible(page, "the escalated reports list");

  await row.getByTestId("escalated-delete").click();
  const dialog = page.getByTestId("escalated-delete-dialog");
  await dialog.getByRole("textbox").fill("Scam link");
  await dialog.getByRole("button", { name: "Remove" }).click();
  await expect(row.getByTestId("escalated-report-done")).toHaveText(
    "Removed, and the report closed.",
  );
  // The admin API resolves open reports only: reopen, then remove with a retry key and the reason.
  const writes = asked.filter((r) => r.method === "POST");
  expect(writes.map((r) => r.path)).toEqual([
    "/reports/r1/reopen",
    "/reports/r1/resolve",
  ]);
  // Reopened only while it is still escalated, so a report someone else has dealt with is never reopened.
  expect(writes[0].body).toMatchObject({ expectStatus: "escalated" });
  expect(writes[1].body).toMatchObject({
    action: "delete",
    reason: "Scam link",
  });
  expect(typeof (writes[1].body as { requestId?: unknown }).requestId).toBe(
    "string",
  );
});

test("an escalated report someone else has dealt with since the list was read is not acted on again", async ({
  page,
}) => {
  const relay = chatRelay();
  await serveQueue(page, "open");
  await relay.install(page);
  const asked = await serveAdmin(page, true, { dealtWith: true });
  await signIn(page);
  await page.goto(`/c/${COMMUNITY_HOST}`);
  await page.getByTestId("moderation-toggle").click({ timeout: 20_000 });

  const row = page
    .getByTestId("escalated-reports")
    .getByTestId("escalated-report-row");
  await row.getByTestId("escalated-delete").click();
  const dialog = page.getByTestId("escalated-delete-dialog");
  await expect(page.getByRole("dialog")).toContainText(
    "Your reason is kept in the server’s records.",
  );
  await expect(dialog).toContainText("Reason (optional)");
  await dialog.getByRole("button", { name: "Remove" }).click();
  await expect(row.getByTestId("escalated-report-done")).toHaveText(
    "Someone has already dealt with this report.",
  );
  await expect(row.getByTestId("escalated-delete")).toHaveCount(0);
  // The refused reopen is the only write: nothing is resolved, and the list is read again.
  await expect
    .poll(() => asked.filter((r) => r.path === "/reports").length)
    .toBeGreaterThan(1);
  const writes = asked.filter((r) => r.method === "POST");
  expect(writes.map((r) => r.path)).toEqual(["/reports/r1/reopen"]);
});

test("someone the server does not accept as one of the people who run it never sees escalated reports", async ({
  page,
}) => {
  const relay = chatRelay();
  await serveQueue(page, "open");
  await relay.install(page);
  const asked = await serveAdmin(page, false);
  await signIn(page);
  await page.goto(`/c/${COMMUNITY_HOST}`);
  await page.getByTestId("moderation-toggle").click({ timeout: 20_000 });
  await expect(page.getByTestId("moderation-report-row")).toBeVisible();
  await expect.poll(() => asked.map((r) => r.path)).toContain("/probe");
  await page.waitForTimeout(500);
  await expect(page.getByTestId("escalated-reports")).toHaveCount(0);
  // Refused at the probe: no report list is ever asked for.
  expect(asked.map((r) => r.path)).toEqual(["/probe"]);
});

import { expect, test, type Page } from "@playwright/test";
import { getPublicKey, verifyEvent } from "nostr-tools/pure";

import { expectAccessible } from "../helpers/a11y";
import { expectNoSidewaysScroll, PHONE } from "../helpers/layout";
import { createMockRelay } from "./mock-relay";

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

function chatRelay(refuse?: string) {
  const relay = createMockRelay({
    refuse: (event) => (refuse && event.kind === 1984 ? refuse : undefined),
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
  await page.goto("/c/alpha.example.com");
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
    "Only this community's moderators will see this",
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
  await expect(page.getByTestId("report-error")).toHaveText(
    "invalid: report target event not found",
  );
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
  await page.getByTestId("composer-input").fill("A note of my own");
  await page.getByTestId("composer-submit").click();
  const mine = page
    .getByTestId("note-card")
    .filter({ hasText: "A note of my own" });
  await expect(mine).toBeVisible();
  await expect(mine.getByTestId("note-report")).toHaveCount(0);

  const theirs = page
    .getByTestId("note-card")
    .filter({ hasText: "Send me your seed phrase" });
  await theirs.getByTestId("note-report").click();
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
  await page.goto("/c/alpha.example.com");
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
  await page.goto("/c/alpha.example.com");
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

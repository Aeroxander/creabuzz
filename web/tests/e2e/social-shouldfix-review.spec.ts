import { expect, type Page, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { COMMUNITY_HOST, createMockRelay } from "./mock-relay";

/**
 * The outside review of the social audit's fixes (D143): failures said in plain words, never the socket's or the
 * server's own codes, and nothing left greyed out without a word.
 *
 * - Someone removed from a private board who opens it again is told they were removed.
 * - "Couldn't load older messages" says the server didn't answer, its own words folded under Technical details.
 * - A picture upload the server refuses says why and what to do (not "Try again" for a ban or a limit).
 * - A wiki rename that saved the new page but could not delete the old one says so; a refused delete says why.
 * - A passkey account whose profile read failed while the passkey prompt was open can edit its profile once unlocked.
 */

const PORT = process.env.E2E_PORT ?? "4173";
/** Passkeys need a host name, not an IP address, so the passkey case opens the same preview on localhost. */
const LOCALHOST = `http://localhost:${PORT}`;
const NSEC = "66".repeat(32);
const ME = getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);
const BOARD = "b0a4d000-1111-2222-3333-777777777777";
const ROOM = "0f0f0f0f-1111-2222-3333-777777777777";
const now = () => Math.floor(Date.now() / 1000);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function quietChain(page: Page) {
  await page.route("http://127.0.0.1:8545/**", (route) =>
    route.fulfill({
      json: { jsonrpc: "2.0", id: 1, result: "0x10" },
    }),
  );
}

async function signIn(page: Page) {
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
    window.localStorage.setItem("buzz.identity.backedUp", "1");
  }, NSEC);
}

function meta(id: string, name: string, type: "forum" | "stream") {
  return {
    id: `meta-${id}`,
    pubkey: "b".repeat(64),
    created_at: 100,
    kind: 39000,
    tags: [["d", id], ["name", name], ["private"], ["t", type]],
    content: "",
    sig: "sig",
  };
}

test("someone removed from a private board who opens it again is told they were removed", async ({
  page,
}) => {
  // Signed in from the start, as the real server always asks: a refusal is then retried once after logging in, refused
  // again, and final.
  const relay = createMockRelay({ requireAuth: true, challengeDelayMs: 50 });
  relay.seed(meta(BOARD, "ideas", "forum"));
  relay.revoke(BOARD);
  await quietChain(page);
  await relay.install(page);
  await signIn(page);
  await page.goto(`/c/${COMMUNITY_HOST}?channel=${BOARD}`);

  const error = page.getByTestId("board-error");
  await expect(error).toHaveAttribute("data-outcome", "answered", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("board-error-description")).toHaveText(
    "You don't have access to this room or board. Its owner can add you.",
  );
  // The server's own words stay under Technical details.
  await expect(page.getByTestId("board-error-message")).toHaveText(
    "restricted: not a channel member",
  );
});

test("older messages that could not load say the server didn't answer, with its words folded away", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(meta(ROOM, "general", "stream"));
  for (let index = 1; index <= 70; index += 1)
    relay.seed({
      id: `review-history-${index}`,
      pubkey: "b".repeat(64),
      created_at: 1_000 + index,
      kind: 9,
      tags: [["h", ROOM]],
      content: `history message ${index}`,
      sig: "sig",
    });
  // Only the walk back through older messages loses its connection.
  relay.setClosingSockets((filter) => typeof filter?.until === "number");
  await quietChain(page);
  await relay.install(page);
  await signIn(page);
  await page.goto(`/c/${COMMUNITY_HOST}?channel=${ROOM}`);
  await expect(page.getByText("history message 70")).toBeVisible({
    timeout: 20_000,
  });

  await page.getByTestId("load-older-messages").click();
  const line = page.getByTestId("older-messages-error");
  await expect(line).toContainText(
    "Couldn't load older messages. The server didn't answer.",
    { timeout: 20_000 },
  );
  await expect(line).not.toContainText("Server closed the connection");
  await expect(line.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.getByTestId("older-messages-error-details")).toContainText(
    "Server closed the connection before finishing the query.",
  );
});

test("a picture upload the server refuses says why and what to do, in the account menu's Edit profile", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed({
    id: "review-profile",
    pubkey: ME,
    created_at: 100,
    kind: 0,
    tags: [],
    content: JSON.stringify({ name: "Ana Reyes" }),
    sig: "sig",
  });
  await quietChain(page);
  await relay.install(page);
  await signIn(page);
  // The server's own words (`buzz-media` `MediaError`), in the order the uploads are refused.
  const refusals = [
    { status: 403, error: "relay membership required" },
    { status: 429, error: "upload rate limit exceeded" },
  ];
  await page.route("**/upload", async (route) => {
    const next = refusals.shift() ?? { status: 500, error: "internal error" };
    await route.fulfill({ status: next.status, json: { error: next.error } });
  });
  await page.goto("/");
  await page.getByTestId("user-chip").first().click();
  await page.getByRole("button", { name: "Edit profile" }).click();
  const field = page.getByTestId("profile-menu-picture");
  const file = field.getByTestId("profile-menu-picture-file");
  const problem = field.getByTestId("profile-menu-picture-problem");

  await file.setInputFiles({
    name: "me.png",
    mimeType: "image/png",
    buffer: PNG,
  });
  await expect(problem).toContainText(
    "You can't upload to this community. If it's invite-only, open the invite link you were sent.",
  );
  await expect(problem).not.toContainText("Try again");

  await file.setInputFiles({
    name: "me.png",
    mimeType: "image/png",
    buffer: PNG,
  });
  await expect(problem).toContainText(
    "You're uploading a bit fast. Wait a minute, then try again.",
  );
  // The server's words are kept for whoever helps.
  await expect(problem.locator("details")).toContainText(
    "upload rate limit exceeded",
  );
});

test("a wiki rename that saved the new page but could not delete the old one says so, and a refused delete says why", async ({
  page,
}) => {
  const until = now() + 3600;
  const relay = createMockRelay({
    refuse: (event) =>
      event.kind === 5 ? `restricted: you are timed out until ${until}` : null,
  });
  relay.seed({
    id: "ab".repeat(32),
    pubkey: ME,
    created_at: now() - 600,
    kind: 44001,
    tags: [["d", "release-notes"]],
    content: "# Release notes",
    sig: "sig",
  });
  await quietChain(page);
  await relay.install(page);
  await signIn(page);
  relay.seed(meta(ROOM, "general", "stream"));
  await page.goto(`/c/${COMMUNITY_HOST}?channel=${ROOM}`);
  await page.getByTestId("wiki-toggle").click();
  await page.getByTestId("knowledge-page-release-notes").click();

  await page.getByTestId("wiki-rename").click();
  await page.getByTestId("page-name-input").fill("changelog");
  await page.getByTestId("page-name-confirm").click();
  // Saved under the new name: the page is live there, and the old one still is.
  await expect
    .poll(() =>
      relay.events
        .filter((e) => e.kind === 44001 && e.pubkey === ME)
        .map((e) => e.tags.find((t) => t[0] === "d")?.[1]),
    )
    .toContain("changelog");
  const toast = (title: string) =>
    page.locator("[data-sonner-toast]").filter({ hasText: title });
  const rename = toast("Couldn't rename page");
  await expect(rename).toContainText(
    "Saved under the new name, but the old name is still there. You are muted everywhere in this community until",
  );
  await expect(rename).not.toContainText("nothing was renamed");
  await expect(rename).not.toContainText("did not answer");

  await page.getByTestId("knowledge-page-changelog").click();
  await page.getByTestId("wiki-delete").click();
  await page.getByTestId("confirm-accept").click();
  const removal = toast("Couldn't delete page");
  await expect(removal).toContainText(
    "You are muted everywhere in this community until",
  );
  await expect(removal).toContainText(
    "You can still read; you can post again then.",
  );
  await expect(removal).not.toContainText("was not deleted");
  await expect(removal).not.toContainText(String(until));
});

async function addVirtualAuthenticator(page: Page) {
  const client = await page.context().newCDPSession(page);
  await client.send("WebAuthn.enable");
  await client.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf: true,
    },
  });
}

test("a passkey account whose profile could not be read while the passkey was locked can edit it once unlocked", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await addVirtualAuthenticator(page);
  // The real server answers only signed-in reads: a locked passkey cannot sign in, so the first profile read fails.
  const relay = createMockRelay({ requireAuth: true });
  await relay.install(page);
  await page.addInitScript(
    (url) => window.localStorage.setItem("buzz.relayUrl", url),
    `ws://127.0.0.1:${PORT}`,
  );
  // A person who has not touched the sensor yet: once armed, the passkey answers only when the test says so.
  await page.addInitScript(() => {
    if (window.localStorage.getItem("e2e.holdPasskey") !== "1") return;
    let release: () => void = () => {};
    const touched = new Promise<void>((resolve) => {
      release = resolve;
    });
    (window as unknown as { touchPasskey: () => void }).touchPasskey = () =>
      release();
    const get = navigator.credentials.get.bind(navigator.credentials);
    navigator.credentials.get = async (options) => {
      await touched;
      return get(options);
    };
  });
  await page.goto(`${LOCALHOST}/`);
  await page.getByTestId("create-identity-cta").first().click();
  await page.getByTestId("onboarding-name").fill("Mira Okafor");
  await page.getByTestId("onboarding-passkey").click();
  await expect(page.getByTestId("backup-dialog")).toContainText(
    "Your account is ready.",
    { timeout: 20_000 },
  );
  await expect.poll(() => relay.events.some((e) => e.kind === 0)).toBe(true);

  await page.evaluate(() =>
    window.localStorage.setItem("e2e.holdPasskey", "1"),
  );
  await page.reload();
  await page.getByTestId("user-chip").first().click();
  const edit = page.getByRole("button", { name: "Edit profile" });
  // The read failed while the passkey was locked: said in words, with a way to try again.
  await expect(page.getByTestId("profile-read-failed")).toContainText(
    "Couldn't read your profile, so it can't be edited yet.",
    { timeout: 20_000 },
  );
  await expect(page.getByTestId("profile-read-retry")).toBeVisible();
  await expect(edit).toBeDisabled();

  await page.evaluate(() =>
    (window as unknown as { touchPasskey: () => void }).touchPasskey(),
  );
  await expect(edit).toBeEnabled({ timeout: 20_000 });
  await expect(page.getByTestId("profile-read-failed")).toHaveCount(0);
  await edit.click();
  await expect(page.getByTestId("profile-name-input")).toHaveValue(
    "Mira Okafor",
  );
});

test("a queue action the server could not apply says so plainly, never its internal error", async ({
  page,
}) => {
  const CAROL = "c3".repeat(32);
  // The server's own words for a failure inside it (`handlers/ingest.rs`).
  const relay = createMockRelay({
    refuse: (event) =>
      event.kind === 9040 ? "error: database error: down" : null,
  });
  relay.seed(meta(ROOM, "general", "stream"));
  relay.seed({
    id: "review-carol",
    pubkey: CAROL,
    kind: 0,
    created_at: 100,
    tags: [],
    content: JSON.stringify({ name: "Carol Ng" }),
    sig: "sig",
  });
  await page.route("**/moderation/reports*", (route) =>
    route.fulfill({
      json: [
        {
          id: "r1",
          report_event_id: "f1".repeat(32),
          reporter_pubkey: "b2".repeat(32),
          target_kind: "pubkey",
          target: CAROL,
          channel_id: null,
          report_type: "spam",
          status: "open",
          created_at: "2026-10-29T10:00:00Z",
        },
      ],
    }),
  );
  await quietChain(page);
  await relay.install(page);
  await signIn(page);
  await page.goto(`/c/${COMMUNITY_HOST}?channel=${ROOM}`);
  await page.getByTestId("moderation-toggle").click({ timeout: 20_000 });

  const row = page
    .getByTestId("moderation-report-row")
    .filter({ hasText: "Carol Ng" });
  await row.getByTestId("moderation-ban").click();
  await page
    .getByTestId("confirm-dialog")
    .getByTestId("confirm-accept")
    .click();
  const error = page.getByTestId("moderation-action-error");
  await expect(error).toContainText("Couldn’t apply the action. Try again.");
  await expect(error).not.toContainText(/database|error:/i);
});

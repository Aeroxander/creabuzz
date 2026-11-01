import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, type Page, test } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { expectAccessible } from "../helpers/a11y";
import { createMockRelay, matches } from "./mock-relay";

/**
 * What someone sees when the server says no, on the hosted, invite-only server: plain words first and the server's own
 * words and address under a collapsed "Technical details"; a non-member told to open their invite link, on Home and
 * before they make an account; and pictures from other sites loading under the embedder policy the server sends with
 * the app.
 *
 * The contributor-only build's sale steps are pinned in `src/features/launchpad/ui/ideaSaleStepsContract.test.mjs`:
 * this suite runs one ordinary build and cannot switch `VITE_CONTRIBUTOR_ONLY` per test.
 */

const NSEC = "77".repeat(32);
const ME = getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);
const INVITE_ONLY =
  "This server is invite-only. Open the invite link you were sent.";
const now = () => Math.floor(Date.now() / 1000);

/** The embedder policy the server sends with the app's pages (`crates/buzz-relay/src/router.rs`, `SPA_COEP`). */
const SPA_COEP = (() => {
  const router = readFileSync(
    new URL("../../../crates/buzz-relay/src/router.rs", import.meta.url),
    "utf8",
  );
  const match = /const SPA_COEP: &str = "([^"]+)";/.exec(router);
  if (!match) throw new Error("router.rs no longer names SPA_COEP");
  return match[1];
})();

/** A one-pixel picture. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function quietChain(page: Page) {
  await page.route("http://127.0.0.1:8545/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x10" }),
    }),
  );
}

async function signIn(page: Page) {
  await page.addInitScript((nsec) => {
    window.localStorage.setItem("buzz.identity.nsec", nsec);
    window.localStorage.setItem("buzz.identity.backedUp", "1");
  }, NSEC);
}

/** The server's public information, saying who may join. */
async function answerAccess(page: Page, access: "open" | "invite_only") {
  await page.route("**/info", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/nostr+json",
      body: JSON.stringify({ name: "Mock server", access }),
    }),
  );
}

test("Home on an invite-only server tells a non-member to open their invite link, with the server's words tucked away", async ({
  page,
}) => {
  // The real server's answer to someone not on its list: every login refused with these words (`handlers/auth.rs`).
  const relay = createMockRelay();
  relay.ban("restricted: not a relay member");
  await quietChain(page);
  await relay.install(page);
  await signIn(page);
  await page.goto("/");

  const error = page.getByTestId("social-feed-error");
  await expect(error).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("social-feed-error-description")).toHaveText(
    INVITE_ONLY,
  );
  // No server wording or address in the main copy.
  await expect(error).not.toContainText("Relay:");
  const details = page.getByTestId("social-feed-error-details");
  await expect(details).toHaveJSProperty("open", false);
  await expect(page.getByTestId("social-feed-error-message")).toBeHidden();
  await expect(page.getByTestId("social-feed-error-relay")).toBeHidden();
  await expectAccessible(page, "Home, refused by an invite-only server");

  // Opened, by keyboard as by pointer, the evidence is there for whoever helps.
  await details.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(details).toHaveJSProperty("open", true);
  await expect(page.getByTestId("social-feed-error-message")).toHaveText(
    "restricted: not a relay member",
  );
  await expect(page.getByTestId("social-feed-error-relay")).toContainText(
    "Server: ws",
  );
});

test("a refused read says the request limit in plain words, not the server's", async ({
  page,
}) => {
  const relay = createMockRelay();
  await quietChain(page);
  await relay.install(page);
  // Every read is refused by the general request limit, in the server's words (`rejection.rs`).
  await page.routeWebSocket(/127\.0\.0\.1:\d+/, (ws) => {
    ws.onMessage((message) => {
      const frame = JSON.parse(String(message)) as unknown[];
      if (frame[0] === "REQ" && typeof frame[1] === "string") {
        ws.send(
          JSON.stringify([
            "CLOSED",
            frame[1],
            "rate-limited: quota exceeded; retry in 4s",
          ]),
        );
      }
    });
  });
  await signIn(page);
  await page.goto("/");

  await expect(page.getByTestId("social-feed-error-description")).toHaveText(
    "You're doing that a bit fast. Try again in 4 seconds.",
    { timeout: 20_000 },
  );
  await expect(page.getByTestId("social-feed-error")).not.toContainText(
    "Quota exceeded",
  );
  await expect(page.getByTestId("social-feed-error-message")).toBeHidden();
});

test("older chat messages refused by the request limit say so in plain words", async ({
  page,
}) => {
  const CHANNEL = "0f0f0f0f-1111-2222-3333-555555555555";
  type Filter = Parameters<typeof matches>[0];
  type Stored = Parameters<typeof matches>[1];
  const events: Stored[] = [
    {
      id: "chan-limit-1",
      pubkey: "b".repeat(64),
      created_at: 100,
      kind: 39000,
      tags: [
        ["d", CHANNEL],
        ["name", "general"],
      ],
      content: "",
      sig: "sig",
    },
  ];
  // More than one page, so the room offers older messages.
  for (let index = 1; index <= 70; index += 1)
    events.push({
      id: `limit-history-${index}`,
      pubkey: "b".repeat(64),
      created_at: 1_000 + index,
      kind: 9,
      tags: [["h", CHANNEL]],
      content: `history message ${index}`,
      sig: "sig",
    });
  const relay = createMockRelay();
  await quietChain(page);
  await relay.install(page);
  // A server that answers every read, except the walk back through older messages, which hits the request limit in
  // the server's words (`rejection.rs`).
  await page.routeWebSocket(/127\.0\.0\.1:\d+/, (ws) => {
    ws.onMessage((message) => {
      const frame = JSON.parse(String(message)) as unknown[];
      if (frame[0] === "EVENT") {
        const event = frame[1] as { id: string };
        ws.send(JSON.stringify(["OK", event.id, true, ""]));
        return;
      }
      if (frame[0] !== "REQ" || typeof frame[1] !== "string") return;
      const filters = frame.slice(2) as Filter[];
      if (filters.some((filter) => typeof filter.until === "number")) {
        ws.send(
          JSON.stringify([
            "CLOSED",
            frame[1],
            "rate-limited: quota exceeded; retry in 4s",
          ]),
        );
        return;
      }
      for (const filter of filters)
        for (const event of events
          .filter((candidate) => matches(filter, candidate))
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, filter.limit ?? events.length))
          ws.send(JSON.stringify(["EVENT", frame[1], event]));
      ws.send(JSON.stringify(["EOSE", frame[1]]));
    });
  });
  await page.goto(`/c/alpha.example.com?channel=${CHANNEL}`);
  await expect(page.getByText("history message 70")).toBeVisible({
    timeout: 20_000,
  });

  await page.getByTestId("load-older-messages").click();
  const error = page.getByTestId("older-messages-error");
  await expect(error).toContainText(
    "Couldn't load older messages. You're doing that a bit fast. Try again in 4 seconds.",
    { timeout: 15_000 },
  );
  await expect(error).not.toContainText("quota exceeded");
  await expect(error).not.toContainText("..");
  await expect(error.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("Sign up on an invite-only server says so before an account is made", async ({
  page,
}) => {
  const relay = createMockRelay();
  await quietChain(page);
  await relay.install(page);
  await answerAccess(page, "invite_only");
  await page.goto("/");

  await page.getByTestId("create-identity-cta").click();
  const dialog = page.getByTestId("onboarding-dialog");
  await expect(dialog).toBeVisible();
  const notice = page.getByTestId("onboarding-invite-only");
  await expect(notice).toContainText("This server is invite-only.");
  await expect(notice).toContainText("Open the invite link you were sent");
  // Said before the buttons that make the account.
  const noticeBox = await notice.boundingBox();
  const createBox = await page.getByTestId("onboarding-passkey").boundingBox();
  expect(noticeBox && createBox && noticeBox.y < createBox.y).toBe(true);
  await expectAccessible(page, "sign-up on an invite-only server");
});

test("Sign up on an open server says nothing about invites", async ({
  page,
}) => {
  const relay = createMockRelay();
  await quietChain(page);
  await relay.install(page);
  await answerAccess(page, "open");
  await page.goto("/");

  await page.getByTestId("create-identity-cta").click();
  await expect(page.getByTestId("onboarding-dialog")).toBeVisible();
  await expect(page.getByTestId("onboarding-name")).toBeVisible();
  await expect(page.getByTestId("onboarding-invite-only")).toHaveCount(0);
});

test("a picture from another site loads under the embedder policy the server sends", async ({
  page,
}) => {
  const PICTURE = "https://avatars.outside.example/u/7.png";
  const relay = createMockRelay();
  relay.seed({
    id: "e7".repeat(32),
    pubkey: ME,
    kind: 0,
    created_at: now() - 60,
    tags: [],
    content: JSON.stringify({ name: "Outside Olive", picture: PICTURE }),
    sig: "sig",
  });
  await quietChain(page);
  await relay.install(page);
  // The app's pages with the headers the server adds to them (`with_spa_coi`); the preview server sends none.
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (
      request.resourceType() !== "document" ||
      !/^http:\/\/127\.0\.0\.1:\d+\//.test(request.url())
    ) {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: {
        ...response.headers(),
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-embedder-policy": SPA_COEP,
      },
    });
  });
  // Another site's picture with no Cross-Origin-Resource-Policy. Answered by routing, which the browser's embedder
  // check does not see: this test is that the app shows the picture under the server's headers; the next one is that
  // those headers let such a picture through.
  await page.route("https://avatars.outside.example/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PNG }),
  );
  await signIn(page);
  await page.goto("/");

  expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(
    SPA_COEP !== "unsafe-none",
  );
  const avatar = page.getByRole("img", { name: "Outside Olive avatar" });
  await expect(avatar.first()).toBeVisible({ timeout: 20_000 });
  await expect(avatar.first()).toHaveAttribute("src", PICTURE);
  expect(
    await avatar
      .first()
      .evaluate((img) => (img as HTMLImageElement).naturalWidth),
  ).toBeGreaterThan(0);
});

test("the server's embedder policy lets a picture from another site load", async ({
  page,
}) => {
  // Two real sites on this machine (another port is another origin): a page with the headers the server sends with
  // the app, and a picture with no Cross-Origin-Resource-Policy, as GitHub and Gravatar send none. Real servers,
  // because a picture answered by the test's own routing skips the browser's check.
  const listen = async (server: ReturnType<typeof createServer>) => {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    return (server.address() as AddressInfo).port;
  };
  const picture = createServer((_, response) => {
    response.writeHead(200, { "content-type": "image/png" });
    response.end(PNG);
  });
  const pictureAt = await listen(picture);
  const app = createServer((_, response) => {
    response.writeHead(200, {
      "content-type": "text/html",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": SPA_COEP,
    });
    response.end(
      `<!doctype html><title>probe</title><img alt="outside" src="http://127.0.0.1:${pictureAt}/p.png">`,
    );
  });
  const appAt = await listen(app);
  try {
    await page.goto(`http://127.0.0.1:${appAt}/`);
    const width = await page.getByRole("img", { name: "outside" }).evaluate(
      (img: HTMLImageElement) =>
        new Promise<number>((resolve) => {
          if (img.complete) resolve(img.naturalWidth);
          img.onload = () => resolve(img.naturalWidth);
          img.onerror = () => resolve(0);
        }),
    );
    expect(width, `a picture from another site under ${SPA_COEP}`).toBe(1);
    // Still isolated where the browser supports the policy, so the wiki's local cache keeps working.
    expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true);
  } finally {
    picture.close();
    app.close();
  }
});

test("a channel the server could not create says so plainly, with the server's words under Technical details", async ({
  page,
}) => {
  const GENERAL = "0b0b0b0b-1111-2222-3333-555555555555";
  // The server's internal failure, in its own words: nothing a person can act on.
  const relay = createMockRelay({
    refuse: (event) =>
      event.kind === 9007 ? "error: database error: down" : null,
  });
  relay.seed({
    id: "chan-create-1",
    pubkey: "b".repeat(64),
    created_at: 100,
    kind: 39000,
    tags: [
      ["d", GENERAL],
      ["name", "general"],
    ],
    content: "",
    sig: "sig",
  });
  await quietChain(page);
  await relay.install(page);
  await signIn(page);
  await page.goto("/c/alpha.example.com");
  await page.getByTestId("content-pane").waitFor();
  const opener = page.getByTestId("open-channel-list");
  if (await opener.isVisible()) await opener.click();
  await page.getByTestId("new-channel").click();
  const dialog = page.getByTestId("create-channel-dialog");
  await dialog.getByLabel("Name").fill("design");
  await dialog.getByRole("button", { name: /^Create/ }).click();

  await expect(page.getByTestId("create-channel-error")).toHaveText(
    "Couldn't create the room. Try again.",
    { timeout: 15_000 },
  );
  // Not in the main copy: only inside the closed disclosure.
  await expect(dialog.getByText("error: database error: down")).toBeHidden();
  const details = page.getByTestId("create-channel-error-details");
  await expect(details).toHaveJSProperty("open", false);
  await details.locator("summary").click();
  await expect(details).toContainText("error: database error: down");
});

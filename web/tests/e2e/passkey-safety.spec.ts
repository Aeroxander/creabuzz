import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { COMMUNITY_HOST, createMockRelay } from "./mock-relay";

/**
 * Account safety around passkey sign-in (suite review 2026-11-01, quick wins 2 and 3).
 *
 * The unlock overlay used to start ceremony after ceremony (a cancelled prompt came straight back) and had no way out;
 * "Remove passkey sign-in" used to delete a passkey-only account in one click. Here the overlay prompts once, offers the
 * recovery key and Sign out, and Remove asks first, putting "Save recovery key" first when the account would be lost.
 */

const NSEC = "77".repeat(32);
const ME = getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);
const OTHER_NSEC = "78".repeat(32);

// WebAuthn needs the `localhost` origin (Chrome refuses IP-literal ones); the mock server answers on 127.0.0.1.
const PORT = process.env.E2E_PORT ?? "4173";
const LOCALHOST = `http://localhost:${PORT}`;

/** Chrome's virtual authenticator with PRF: a real passkey ceremony in a production build. */
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

test("the unlock overlay prompts once, and the recovery key gets the person in", async ({
  page,
}) => {
  const relay = createMockRelay();
  // One room, so the community opens its workspace, where the unlock overlay lives.
  relay.seed({
    id: "c".repeat(64),
    pubkey: "0".repeat(64),
    created_at: 1_700_000_000,
    kind: 39000,
    tags: [
      ["d", "a1".repeat(16)],
      ["name", "general"],
    ],
    content: "",
    sig: "0".repeat(128),
  });
  await relay.install(page);
  await page.addInitScript(
    ({ nsec, me }) => {
      // An account with an unlock-mode passkey (iCloud Keychain), locked for this session.
      localStorage.setItem("buzz.identity.nsec", nsec);
      localStorage.setItem("buzz.passkey.credentialId", "AAAA");
      localStorage.setItem("buzz.passkey.salt", "AAAA");
      localStorage.setItem("buzz.passkey.pubkey", me);
      localStorage.setItem("buzz.passkey.mode", "unlock");
      // The person cancels every system prompt; count how many the app starts.
      const w = window as unknown as { __passkeyPrompts: number };
      w.__passkeyPrompts = 0;
      navigator.credentials.get = () => {
        w.__passkeyPrompts += 1;
        return Promise.reject(
          new DOMException("The operation was cancelled.", "NotAllowedError"),
        );
      };
    },
    { nsec: NSEC, me: ME },
  );
  await page.goto(`/c/${COMMUNITY_HOST}`);

  await expect(page.getByTestId("passkey-unlock-error")).toBeVisible({
    timeout: 20_000,
  });
  // Give a re-firing effect time to show itself, then count.
  await page.waitForTimeout(1_000);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __passkeyPrompts: number }).__passkeyPrompts,
    ),
  ).toBe(1);

  // A way out: Sign out asks first, and Cancel keeps the account.
  await page.getByTestId("passkey-unlock-signout").click();
  await expect(page.getByTestId("confirm-dialog")).toContainText(
    "Without it this account is gone for good.",
  );
  await page.getByRole("button", { name: "Cancel" }).click();
  expect(
    await page.evaluate(() => localStorage.getItem("buzz.passkey.pubkey")),
  ).toBe(ME);

  // Another account's key is refused in plain words.
  await page.getByTestId("passkey-unlock-use-key").click();
  await page.getByTestId("passkey-unlock-key").fill(OTHER_NSEC);
  await page.getByTestId("passkey-unlock-key-submit").click();
  await expect(page.getByTestId("passkey-unlock-key-error")).toHaveText(
    "That recovery key is for a different account. Paste the key you saved for this one.",
  );

  // This account's key opens the session, with no further prompt.
  await page.getByTestId("passkey-unlock-key").fill(NSEC);
  await page.getByTestId("passkey-unlock-key-submit").click();
  await expect(page.getByTestId("passkey-unlock")).toHaveCount(0);
  await expect(page.getByTestId("content-pane")).toBeVisible();
  expect(
    await page.evaluate(() => ({
      prompts: (window as unknown as { __passkeyPrompts: number })
        .__passkeyPrompts,
      backedUp: localStorage.getItem("buzz.identity.backedUp"),
      mode: localStorage.getItem("buzz.passkey.mode"),
    })),
  ).toEqual({ prompts: 1, backedUp: ME, mode: "unlock" });
});

test("removing passkey sign-in asks first, and offers the recovery key when the account would be lost", async ({
  page,
}) => {
  // A passkey with PRF output: a passkey-only account, whose key exists only through the passkey.
  await addVirtualAuthenticator(page);
  const relay = createMockRelay();
  await relay.install(page);
  await page.addInitScript(
    (url) => localStorage.setItem("buzz.relayUrl", url),
    `ws://127.0.0.1:${PORT}`,
  );
  await page.goto(`${LOCALHOST}/`);
  await page.getByTestId("create-identity-cta").first().click();
  await page.getByTestId("onboarding-name").fill("Prf Person");
  await page.getByTestId("onboarding-passkey").click();
  await page.getByTestId("backup-close").click({ timeout: 20_000 });
  expect(
    await page.evaluate(() => localStorage.getItem("buzz.passkey.mode")),
  ).toBe("prf");

  await page.getByTestId("user-chip").click();
  await page.getByRole("button", { name: "Remove passkey sign-in" }).click();
  const dialog = page.getByTestId("remove-passkey-dialog");
  await expect(dialog).toContainText(
    "You haven't saved your recovery key. Without it this account is gone for good.",
  );
  await expect(page.getByTestId("remove-passkey-confirm")).toHaveText(
    "Remove anyway",
  );
  // The main button saves the key; nothing was removed.
  await page.getByTestId("remove-passkey-save-key").click();
  await expect(page.getByTestId("backup-dialog")).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.getItem("buzz.passkey.mode")),
  ).toBe("prf");
  await page.getByTestId("backup-close").click();

  // Removing anyway does what it says.
  await page.getByTestId("user-chip").click();
  await page.getByRole("button", { name: "Remove passkey sign-in" }).click();
  await page.getByTestId("remove-passkey-confirm").click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("buzz.passkey.mode")))
    .toBeNull();
});

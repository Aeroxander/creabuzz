import { expect, type Page, test } from "@playwright/test";
import { COMMUNITY_HOST, createMockRelay, PREVIEW_PORT } from "./mock-relay";

/**
 * The passkey account end to end in the new app, against Chrome's virtual authenticator (CDP WebAuthn with PRF): the
 * real `navigator.credentials` path that `web/tests/e2e/passkey.spec.ts` drives, here through the app's own sign-up.
 * Sign up with a passkey, reload, unlock to the same account, and keep only public material in the browser.
 *
 * Passkeys need a host name, not an IP address, so the page is opened on `localhost` while it still talks to the mock
 * server on the loopback address.
 */

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

test("sign up with a passkey, reload, unlock to the same account; only public material is stored", async ({
  page,
}) => {
  await addVirtualAuthenticator(page);
  const relay = createMockRelay();
  await relay.install(page);
  await page.route("**/api/join-policy", (route) =>
    route.fulfill({ status: 200, json: {} }),
  );
  await page.addInitScript(
    (url) => window.localStorage.setItem("buzz.relayUrl", url),
    `ws://${COMMUNITY_HOST}`,
  );

  await page.goto(`http://localhost:${PREVIEW_PORT}/welcome`);
  await page.getByTestId("onboarding-name").fill("Mira Okafor", {
    timeout: 20_000,
  });
  // This device can make a passkey, so that way is the green one.
  await expect(page.getByTestId("onboarding-passkey")).toHaveClass(
    /btn-primary/,
  );
  await page.getByTestId("onboarding-passkey").click();

  // The recovery key is offered once, while the account is unlocked.
  await expect(page.getByTestId("backup-sheet")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("backup-key")).toBeVisible();
  await page.keyboard.press("Escape");

  const before = await page.evaluate(() => ({
    keys: Object.keys(localStorage)
      .filter((k) => k.startsWith("buzz.passkey") || k === "buzz.identity.nsec")
      .sort(),
    account: localStorage.getItem("buzz.passkey.pubkey"),
    mode: localStorage.getItem("buzz.passkey.mode"),
  }));
  expect(before.account).toMatch(/^[0-9a-f]{64}$/);
  expect(before.mode).toBe("prf");
  // Public material only: no secret key is kept in the browser for a passkey account.
  expect(before.keys).toEqual([
    "buzz.passkey.credentialId",
    "buzz.passkey.mode",
    "buzz.passkey.pubkey",
    "buzz.passkey.r1",
    "buzz.passkey.salt",
  ]);
  // The name typed is the account's public name.
  await expect
    .poll(() =>
      relay.events
        .filter((e) => e.kind === 0 && e.pubkey === before.account)
        .map((e) => JSON.parse(e.content).name),
    )
    .toContain("Mira Okafor");

  // A reload forgets the key in memory; reading still works, posting needs one tap.
  await page.reload();
  const bar = page.getByTestId("unlock-bar");
  await expect(bar).toBeVisible({ timeout: 20_000 });
  await bar.getByRole("button", { name: "Unlock" }).click();
  // Unlocking succeeds only when the passkey derives the same account (anything else is refused).
  await expect(bar).toHaveCount(0, { timeout: 20_000 });
  expect(
    await page.evaluate(() => localStorage.getItem("buzz.passkey.pubkey")),
  ).toBe(before.account);
  expect(
    await page.evaluate(() => localStorage.getItem("buzz.identity.nsec")),
  ).toBeNull();
});

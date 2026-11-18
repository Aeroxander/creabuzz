import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { COMMUNITY_HOST, createMockRelay } from "./mock-relay";

/**
 * The passkey screens in the build people get (outside review 2026-11-01, Review A 1.1 and Review B 8 and 10).
 *
 * - The passkey module's ceremony stand-in (`sessionStorage["buzz.passkey.mock"]`) belongs to the dev server only. This
 *   suite runs on a production build: the bundle must not carry the flag, and setting it must still run real WebAuthn
 *   (Chrome's virtual authenticator holds the credential the account was made with).
 * - Sign-up, sign-in and the passkey unlock screen are modal dialogs: named by their heading, focus starts inside and
 *   Tab never walks into the page behind them; Escape closes the ones that have a close button.
 */

// WebAuthn needs the `localhost` origin (Chrome refuses IP-literal ones); the mock server answers on 127.0.0.1.
const PORT = process.env.E2E_PORT ?? "4173";
const LOCALHOST = `http://localhost:${PORT}`;
const MOCK_FLAG = "buzz.passkey.mock";

async function addVirtualAuthenticator(page: Page) {
  const client = await page.context().newCDPSession(page);
  await client.send("WebAuthn.enable");
  const { authenticatorId } = await client.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
        hasPrf: true,
      },
    },
  );
  return { client, authenticatorId };
}

async function useMockServerFromLocalhost(page: Page) {
  const relay = createMockRelay();
  await relay.install(page);
  await page.addInitScript(
    (url) => localStorage.setItem("buzz.relayUrl", url),
    `ws://127.0.0.1:${PORT}`,
  );
  return relay;
}

/** Whether keyboard focus is inside the open dialog (or on it). */
async function focusInsideDialog(page: Page, name: string) {
  return page
    .getByRole("dialog", { name })
    .evaluate((dialog) => dialog.contains(document.activeElement));
}

test("the production bundle carries no passkey stand-in", async ({
  request,
}) => {
  const html = await (await request.get("/")).text();
  const scripts = [
    ...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.js)"/g),
  ].map((m) => m[1]);
  expect(scripts.length).toBeGreaterThan(0);
  for (const path of scripts) {
    const body = await (await request.get(path)).text();
    expect(body, `${path} names the dev-only flag`).not.toContain(MOCK_FLAG);
    expect(body, `${path} carries the fake ceremony`).not.toContain(
      '"challenge":"mock"',
    );
  }
});

test("with the stand-in flag set, a production build still makes the account with real WebAuthn", async ({
  page,
}) => {
  const { client, authenticatorId } = await addVirtualAuthenticator(page);
  await useMockServerFromLocalhost(page);
  // Both values the stand-in understood: neither may skip the real ceremony.
  await page.addInitScript(
    (flag) => sessionStorage.setItem(flag, "1"),
    MOCK_FLAG,
  );
  await page.goto(`${LOCALHOST}/`);
  await page.getByTestId("create-identity-cta").first().click();
  await page.getByTestId("onboarding-name").fill("Real Ceremony");
  await page.getByTestId("onboarding-passkey").click();
  await page.getByTestId("backup-close").click({ timeout: 20_000 });

  const { credentials } = await client.send("WebAuthn.getCredentials", {
    authenticatorId,
  });
  expect(credentials).toHaveLength(1);
  const stored = await page.evaluate(() => ({
    credentialId: localStorage.getItem("buzz.passkey.credentialId"),
    mode: localStorage.getItem("buzz.passkey.mode"),
  }));
  // The browser's credential, base64url, not the stand-in's `mock-…` id.
  expect(stored.credentialId).not.toMatch(/^mock-/);
  expect(
    Buffer.from(stored.credentialId ?? "", "base64url").toString("base64"),
  ).toBe(credentials[0].credentialId);
  expect(stored.mode).toBe("prf");
});

test("with the 'noprf' flag and no passkey on this device, sign-up fails instead of faking one", async ({
  page,
}) => {
  await useMockServerFromLocalhost(page);
  await page.addInitScript(
    (flag) => sessionStorage.setItem(flag, "noprf"),
    MOCK_FLAG,
  );
  // No authenticator at all: the real ceremony is refused, as on a device without passkeys.
  await page.addInitScript(() => {
    navigator.credentials.create = () =>
      Promise.reject(new DOMException("no authenticator", "NotAllowedError"));
  });
  await page.goto(`${LOCALHOST}/`);
  await page.getByTestId("create-identity-cta").first().click();
  await page.getByTestId("onboarding-name").fill("No Passkey");
  await page.getByTestId("onboarding-passkey").click();
  await expect(page.getByTestId("onboarding-error")).toBeVisible();
  expect(
    await page.evaluate(() =>
      localStorage.getItem("buzz.passkey.credentialId"),
    ),
  ).toBeNull();
});

test("sign-up and sign-in keep keyboard focus inside the dialog, and Escape closes them", async ({
  page,
}) => {
  const relay = createMockRelay();
  await relay.install(page);
  await page.goto("/");
  const cta = page.getByTestId("create-identity-cta").first();
  await cta.click();

  const signUp = page.getByRole("dialog", { name: "Create your account" });
  await expect(signUp).toBeVisible();
  await expect(signUp).toHaveAttribute("aria-modal", "true");
  // Focus starts on the name, the first thing to fill in.
  await expect(page.getByTestId("onboarding-name")).toBeFocused();
  for (let i = 0; i < 15; i += 1) {
    await page.keyboard.press("Tab");
    expect(await focusInsideDialog(page, "Create your account")).toBe(true);
  }
  for (let i = 0; i < 15; i += 1) {
    await page.keyboard.press("Shift+Tab");
    expect(await focusInsideDialog(page, "Create your account")).toBe(true);
  }

  // The sign-in view is its own dialog, focused on the key field.
  await page.getByTestId("onboarding-signin").click();
  const signIn = page.getByRole("dialog", { name: "Sign in" });
  await expect(signIn).toBeVisible();
  await expect(page.getByTestId("onboarding-signin-key")).toBeFocused();
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press("Tab");
    expect(await focusInsideDialog(page, "Sign in")).toBe(true);
  }
  // Escape there goes back, as its Back button does; Escape on sign-up is "Not now".
  await page.keyboard.press("Escape");
  await expect(signUp).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("onboarding-dialog")).toHaveCount(0);
});

/** Press Tab until the control with this test id has focus; fails if a bounded number of presses never reaches it. */
async function tabTo(page: Page, testId: string) {
  for (let i = 0; i < 12; i += 1) {
    const here = await page.evaluate(
      (id) => document.activeElement?.getAttribute("data-testid") === id,
      testId,
    );
    if (here) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`Tab never reached ${testId}`);
}

const NSEC = "79".repeat(32);
const ME = getPublicKey(
  Uint8Array.from(NSEC.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16)),
);

test("the passkey unlock screen keeps focus inside it, and a keyboard alone reaches the recovery key", async ({
  page,
}) => {
  const relay = createMockRelay();
  // One room, so the community opens its workspace, where the unlock screen lives.
  relay.seed({
    id: "d".repeat(64),
    pubkey: "0".repeat(64),
    created_at: 1_700_000_000,
    kind: 39000,
    tags: [
      ["d", "b1".repeat(16)],
      ["name", "general"],
    ],
    content: "",
    sig: "0".repeat(128),
  });
  await relay.install(page);
  await page.addInitScript(
    ({ nsec, me }) => {
      // An unlock-mode passkey account, locked for this session, whose passkey does not answer.
      localStorage.setItem("buzz.identity.nsec", nsec);
      localStorage.setItem("buzz.passkey.credentialId", "AAAA");
      localStorage.setItem("buzz.passkey.salt", "AAAA");
      localStorage.setItem("buzz.passkey.pubkey", me);
      localStorage.setItem("buzz.passkey.mode", "unlock");
      navigator.credentials.get = () =>
        Promise.reject(new DOMException("cancelled", "NotAllowedError"));
    },
    { nsec: NSEC, me: ME },
  );
  await page.goto(`/c/${COMMUNITY_HOST}`);

  const gate = page.getByRole("dialog", { name: "Sign in with passkey" });
  await expect(page.getByTestId("passkey-unlock-error")).toBeVisible({
    timeout: 20_000,
  });
  await expect(gate).toHaveAttribute("aria-modal", "true");
  expect(await focusInsideDialog(page, "Sign in with passkey")).toBe(true);
  // Shift+Tab straight from the first focus wraps inside too (it used to reach the header behind the gate).
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press("Shift+Tab");
    expect(await focusInsideDialog(page, "Sign in with passkey")).toBe(true);
  }
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press("Tab");
    expect(await focusInsideDialog(page, "Sign in with passkey")).toBe(true);
  }
  // Escape does not dismiss it: there is nothing behind it to use until the account is unlocked.
  await page.keyboard.press("Escape");
  await expect(gate).toBeVisible();

  // Pressing Unlock removes that button while the passkey is asked: focus stays in the dialog, not on the page.
  await tabTo(page, "passkey-unlock");
  await page.keyboard.press("Enter");
  // The refused passkey brings the button back; by then focus must not have fallen to the page.
  await expect(page.getByTestId("passkey-unlock")).toBeVisible();
  await expect(gate).toBeVisible();
  expect(await focusInsideDialog(page, "Sign in with passkey")).toBe(true);

  // Keyboard only: Tab to the recovery-key link, open it, and land in its field.
  await tabTo(page, "passkey-unlock-use-key");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("passkey-unlock-key")).toBeFocused();
  await page.keyboard.type(NSEC);
  await page.keyboard.press("Enter");
  await expect(gate).toHaveCount(0);
  await expect(page.getByTestId("content-pane")).toBeVisible();
});

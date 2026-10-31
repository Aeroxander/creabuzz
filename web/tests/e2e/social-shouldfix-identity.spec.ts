import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";
import { hexToBytes } from "@noble/hashes/utils.js";

import { createMockRelay } from "./mock-relay";

/**
 * Getting in, the profile and the page frame (the screen audit's identity findings, 2026-10-30).
 *
 * - Signed out, the top bar offers Sign in beside Sign up, and it opens straight on the recovery-key sign-in.
 * - An invite link that cannot be an invite says so when it opens, before any account is made for it.
 * - `/u/<anything that is not a person>` says the profile can't be found; `/u/me` is the signed-in account.
 * - Edit profile shows one name, closes from its own button and from the backdrop; Home's name step opens it.
 * - An account with no passkey is told why its payment wallet can't be a passkey account, and can set one up there.
 * - Pages scroll inside the frame, so the phone's tab bar stays put.
 */

const SECRET = "44".repeat(32);
const ME = getPublicKey(hexToBytes(SECRET));

async function signIn(page: Page) {
  await page.addInitScript((secret) => {
    localStorage.setItem("buzz.identity.nsec", secret);
    localStorage.setItem("buzz.identity.backedUp", secret);
  }, SECRET);
}

async function start(page: Page) {
  const relay = createMockRelay();
  await relay.install(page);
  return relay;
}

test("signed out, Sign in sits beside Sign up and opens the recovery-key sign-in", async ({
  page,
}) => {
  await start(page);
  await page.goto("/");
  const signInButton = page.getByTestId("sign-in-cta");
  await expect(signInButton).toBeVisible();
  await expect(page.getByTestId("create-identity-cta")).toBeVisible();
  await signInButton.click();
  const form = page.getByTestId("onboarding-signin-form");
  await expect(form).toBeVisible();
  await page.getByTestId("onboarding-signin-key").fill("not a key");
  await page.getByTestId("onboarding-signin-submit").click();
  await expect(page.getByTestId("onboarding-signin-problem")).toHaveText(
    "That doesn't look like a recovery key. Paste the whole key you saved.",
  );
  // It can switch to making an account, or close without one.
  await form.getByRole("button", { name: "Create an account" }).click();
  await expect(page.getByTestId("onboarding-name")).toBeVisible();
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(page.getByTestId("onboarding-dialog")).toHaveCount(0);
});

test("signing up says which box is holding the buttons back", async ({
  page,
}) => {
  await start(page);
  await page.route("**/api/join-policy", (route) =>
    route.fulfill({
      json: {
        policy: {
          version: "1",
          terms_markdown: "Be kind.",
          age_attestation_required: false,
        },
      },
    }),
  );
  await page.goto("/");
  await page.getByTestId("create-identity-cta").click();
  await expect(page.getByTestId("onboarding-policy")).toBeVisible();
  await expect(page.getByTestId("onboarding-tick-hint")).toHaveCount(0);
  await page.getByTestId("onboarding-name").fill("Nia Patel");
  await expect(page.getByTestId("onboarding-tick-hint")).toHaveText(
    "Tick the box to agree to the Terms of use.",
  );
  await expect(page.getByTestId("onboarding-passkey")).toBeDisabled();
  await page.getByTestId("onboarding-policy-agree").check();
  await expect(page.getByTestId("onboarding-tick-hint")).toHaveCount(0);
  await expect(page.getByTestId("onboarding-passkey")).toBeEnabled();
});

test("an invite link that cannot be an invite says so before an account is made", async ({
  page,
}) => {
  await start(page);
  let claimed = false;
  await page.route("**/api/invites/claim", (route) => {
    claimed = true;
    return route.fulfill({ status: 400, json: { error: "invite_invalid" } });
  });
  await page.goto("/invite/not-a-real-code");
  const broken = page.getByTestId("invite-broken");
  await expect(broken).toContainText("This invite link doesn't work");
  await expect(broken).toContainText(
    "Ask the person who sent it for a new one.",
  );
  await expect(page.getByTestId("invite-name")).toHaveCount(0);
  await broken.getByRole("link", { name: "Home" }).click();
  await expect(page).toHaveURL(/\/$/);
  expect(claimed).toBe(false);
  expect(
    await page.evaluate(() => localStorage.getItem("buzz.identity.nsec")),
  ).toBeNull();

  // A code with the server's shape is the server's to judge: the invite shows.
  await page.goto(`/invite/v2.${"A".repeat(43)}`);
  await expect(page.getByTestId("invite-broken")).toHaveCount(0);
  await expect(page.getByTestId("invite-host")).toBeVisible();
});

test("a profile address that names nobody says so, and /u/me is your own", async ({
  page,
}) => {
  await start(page);
  await page.goto("/u/not-a-key");
  await expect(page.getByTestId("profile-not-found")).toContainText(
    "This profile can't be found",
  );
  await expect(page.getByTestId("profile-follow")).toHaveCount(0);
  await expect(page.getByTestId("profile-report")).toHaveCount(0);

  await page.goto("/u/me");
  await expect(page.getByTestId("profile-signed-out")).toBeVisible();
});

test("signed in, /u/me is your own profile, and Edit profile shows one name and closes", async ({
  page,
}) => {
  await signIn(page);
  await start(page);
  await page.goto("/u/me");
  await expect(page).toHaveURL(new RegExp(`/u/${ME}$`));
  await page.getByTestId("profile-edit").click();
  const dialog = page.getByTestId("social-edit-profile");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Name", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Username")).toHaveCount(0);
  await expect(dialog.getByLabel("Display name")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();

  // A press on the backdrop closes it too.
  await page.getByTestId("profile-edit").click();
  await expect(dialog).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(dialog).toBeHidden();
});

test("Home's first step opens the profile editor in place", async ({
  page,
}) => {
  await signIn(page);
  await start(page);
  await page.goto("/");
  const step = page.getByTestId("home-step-name");
  await expect(step).toContainText("The picture is optional.");
  await expect(step).not.toContainText("account menu");
  await page.getByTestId("home-step-name-go").click();
  await expect(page.getByTestId("social-edit-profile")).toBeVisible();
});

test("an account with no passkey is told why, and can set up passkey sign-in from the wallet dialog", async ({
  page,
}) => {
  await signIn(page);
  await start(page);
  await page.goto(`/u/${ME}`);
  await page
    .getByRole("button", { name: "Connect payment wallet", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Connect payment wallet" });
  await expect(dialog.getByTestId("payment-wallet-how")).toContainText(
    "Set up passkey sign-in to be paid at your passkey account",
  );
  await expect(dialog.getByTestId("payment-wallet-how")).not.toHaveText(
    "Use a wallet in this browser.",
  );
  await expect(
    dialog.getByTestId("payment-wallet-setup-passkey"),
  ).toBeVisible();
  // The box is the condition, and the dialog says so while it is unticked.
  await expect(dialog.getByTestId("payment-wallet-consent-hint")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Connect wallet" }),
  ).toBeDisabled();
  await dialog.getByRole("checkbox", { name: "I understand" }).check();
  await expect(dialog.getByTestId("payment-wallet-consent-hint")).toHaveCount(
    0,
  );
});

test("on a phone the page scrolls inside the frame and the tab bar stays on screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await start(page);
  await page.goto("/start");
  const nav = page.getByTestId("app-nav");
  await expect(nav).toBeVisible();
  const main = page.locator("#app-main");
  // The document itself never scrolls: <main> is the scroller.
  expect(
    await page.evaluate(
      () => document.documentElement.scrollHeight <= window.innerHeight + 1,
    ),
  ).toBe(true);
  await main.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  // Start is longer than a phone screen, and it is <main> that moved.
  expect(await main.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  const box = await nav.boundingBox();
  expect(box).not.toBeNull();
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(844 + 1);
  // A new page starts at its top.
  await page.getByTestId("app-nav-home").click();
  await expect.poll(() => main.evaluate((el) => el.scrollTop)).toBe(0);
});

test("setting up passkey sign-in from the wallet dialog keeps the account it was set up for", async ({
  page,
}) => {
  await signIn(page);
  // The module's deterministic passkey stand-in, with PRF output: the case that used to derive a new person.
  await page.addInitScript(() => {
    sessionStorage.setItem("buzz.passkey.mock", "1");
  });
  await start(page);
  await page.goto(`/u/${ME}`);
  await page
    .getByRole("button", { name: "Connect payment wallet", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Connect payment wallet" });
  await dialog.getByTestId("payment-wallet-setup-passkey").click();
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("buzz.passkey.pubkey")),
    )
    .toBe(ME);
  expect(
    await page.evaluate(() => ({
      mode: localStorage.getItem("buzz.passkey.mode"),
      owner: localStorage.getItem("buzz.passkey.r1"),
    })),
  ).toEqual({ mode: "unlock", owner: expect.stringMatching(/^04/) });
  // Still the same person after a reload: their own profile, with Edit profile.
  await page.reload();
  await expect(page.getByTestId("profile-edit")).toBeVisible();
});

test("Back returns to where the page was scrolled; a new visit starts at the top", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await start(page);
  await page.goto("/start");
  const main = page.locator("#app-main");
  await expect(page.getByTestId("app-nav")).toBeVisible();
  // Wait for the page to be long enough, then leave it part way down.
  await expect
    .poll(() => main.evaluate((el) => el.scrollHeight - el.clientHeight))
    .toBeGreaterThan(300);
  const scrolled = await main.evaluate((el) => {
    el.scrollTop = 300;
    return el.scrollTop;
  });
  expect(scrolled).toBe(300);
  await page.getByTestId("app-nav-home").click();
  await expect(page).toHaveURL(/\/$/);
  // Home has rendered: the frame was put back at the top for it.
  await expect.poll(() => main.evaluate((el) => el.scrollTop)).toBe(0);
  await page.goBack();
  await expect(page).toHaveURL(/\/start$/);
  await expect
    .poll(() => main.evaluate((el) => el.scrollTop))
    .toBeGreaterThanOrEqual(299);
  // Going there by a link again is a new visit: it starts at the top.
  await page.getByTestId("app-nav-home").click();
  await expect(page).toHaveURL(/\/$/);
  await page.getByTestId("app-nav-start").click();
  await expect(page).toHaveURL(/\/start$/);
  await expect.poll(() => main.evaluate((el) => el.scrollTop)).toBe(0);
});

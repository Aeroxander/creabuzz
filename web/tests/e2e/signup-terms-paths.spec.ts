import { expect, test, type Page } from "@playwright/test";

import { createMockRelay } from "./mock-relay";

/**
 * The terms boxes on every way into an account (the lawyer's "unconditional on every path").
 *
 * - Signing back in with a recovery key waits for the same boxes as making an account, and records what was agreed to.
 * - When the server's terms cannot be loaded, both screens say that no terms were agreed to and what happens next, offer
 *   Try again, and still let the person in (no server answers before a first community).
 * - An account made that way is asked to agree at the first chance: a first agreement, not a change.
 */

const ACCEPTED_KEY = "creaton.joinPolicy.accepted";
const RECOVERY_KEY = "66".repeat(32);

const TERMS = {
  policy: {
    version: "v1",
    terms_markdown: "# Terms\n\nBe kind.",
    privacy_markdown: "# Privacy",
    age_attestation_required: false,
  },
};

async function start(
  page: Page,
  answer: () => { status: number; json: unknown },
) {
  const relay = createMockRelay();
  await relay.install(page);
  await page.route("**/api/join-policy", (route) => {
    const { status, json } = answer();
    return route.fulfill({ status, json });
  });
  return relay;
}

async function openSignIn(page: Page) {
  await page.goto("/");
  await page.getByTestId("sign-in-cta").click();
  await expect(page.getByTestId("onboarding-signin-form")).toBeVisible();
  await page.getByTestId("onboarding-signin-key").fill(RECOVERY_KEY);
}

test("recovery-key sign-in waits for the terms box, then records the version agreed to", async ({
  page,
}) => {
  await start(page, () => ({ status: 200, json: TERMS }));
  await openSignIn(page);

  const submit = page.getByTestId("onboarding-signin-submit");
  await expect(page.getByTestId("onboarding-policy")).toBeVisible();
  await expect(submit).toBeDisabled();
  await expect(page.getByTestId("onboarding-signin-tick-hint")).toHaveText(
    "Tick the box to agree to the Terms of use, then sign in.",
  );
  // Enter in the key field does not get round the box either.
  await page.getByTestId("onboarding-signin-key").press("Enter");
  expect(
    await page.evaluate(() => localStorage.getItem("buzz.identity.nsec")),
  ).toBeNull();

  await page.getByTestId("onboarding-policy-agree").check();
  await expect(submit).toBeEnabled();
  await Promise.all([page.waitForNavigation(), submit.click()]);

  const stored = await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return {
      account: localStorage.getItem("buzz.identity.backedUp"),
      record: raw ? JSON.parse(raw) : null,
    };
  }, ACCEPTED_KEY);
  expect(stored.account).not.toBeNull();
  expect(stored.record.version).toBe("v1");
});

test("terms that cannot be loaded are said so on sign-up and sign-in, with Try again, and nothing is recorded as agreed", async ({
  page,
}) => {
  let up = false;
  await start(page, () =>
    up
      ? { status: 200, json: TERMS }
      : { status: 503, json: { error: "down" } },
  );
  await openSignIn(page);

  const note = page.getByTestId("onboarding-policy-unavailable");
  await expect(note).toContainText("not agreeing to any terms yet");
  await expect(note).toContainText("you will be asked to agree");
  await expect(note).toContainText("cannot post or act");
  // Try again asks the server again; once it answers, the box is asked for.
  up = true;
  await page.getByTestId("onboarding-policy-retry").click();
  await expect(page.getByTestId("onboarding-policy-agree")).toBeVisible();
  await expect(page.getByTestId("onboarding-signin-submit")).toBeDisabled();
});

test("an account made while the terms could not be loaded is asked to agree as soon as the server answers", async ({
  page,
}) => {
  let up = false;
  await start(page, () =>
    up
      ? { status: 200, json: TERMS }
      : { status: 503, json: { error: "down" } },
  );
  // An agreement from an earlier account in this browser must not stand in for the new one.
  await page.addInitScript((key) => {
    if (!window.sessionStorage.getItem("seeded")) {
      window.sessionStorage.setItem("seeded", "1");
      localStorage.setItem(
        key,
        JSON.stringify({ version: "v1", at: 1, host: location.host }),
      );
    }
  }, ACCEPTED_KEY);
  await openSignIn(page);
  await expect(page.getByTestId("onboarding-policy-unavailable")).toBeVisible();
  await expect(page.getByTestId("onboarding-signin-submit")).toBeEnabled();
  await Promise.all([
    page.waitForNavigation(),
    page.getByTestId("onboarding-signin-submit").click(),
  ]);

  const record = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? "null"),
    ACCEPTED_KEY,
  );
  expect(record.agreed).toBe(false);
  expect(record.version).toBeNull();

  // The server answers at the next visit: a first agreement, not "the terms have changed".
  up = true;
  await page.reload();
  const dialog = page.getByTestId("terms-again-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Please agree to the terms");
  await expect(page.getByTestId("terms-again-agree")).toBeDisabled();
});

test("making an account waits for the box and says so when the terms could not be loaded", async ({
  page,
}) => {
  await start(page, () => ({ status: 503, json: { error: "down" } }));
  await page.goto("/");
  await page.getByTestId("create-identity-cta").click();
  await expect(page.getByTestId("onboarding-policy-unavailable")).toContainText(
    "not agreeing to any terms yet",
  );
  await page.getByTestId("onboarding-name").fill("Nia Patel");
  await Promise.all([
    page.waitForNavigation(),
    page.getByTestId("onboarding-create").click(),
  ]);
  const record = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? "null"),
    ACCEPTED_KEY,
  );
  expect(record.agreed).toBe(false);
});

test("making an account with the box ticked records the version agreed to", async ({
  page,
}) => {
  await start(page, () => ({ status: 200, json: TERMS }));
  await page.goto("/");
  await page.getByTestId("create-identity-cta").click();
  await page.getByTestId("onboarding-name").fill("Nia Patel");
  const create = page.getByTestId("onboarding-create");
  await expect(create).toBeDisabled();
  await page.getByTestId("onboarding-policy-agree").check();
  await Promise.all([page.waitForNavigation(), create.click()]);

  const record = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? "null"),
    ACCEPTED_KEY,
  );
  expect(record.version).toBe("v1");
  expect(record.agreed).not.toBe(false);
});

test("Try again keeps keyboard focus inside the sign-up dialog, on both screens", async ({
  page,
}) => {
  let up = false;
  await start(page, () =>
    up
      ? { status: 200, json: TERMS }
      : { status: 503, json: { error: "down" } },
  );
  const insideDialog = () =>
    page.evaluate(() =>
      Boolean(
        document
          .querySelector('[role="dialog"]')
          ?.contains(document.activeElement),
      ),
    );

  // The recovery-key screen.
  await openSignIn(page);
  await page.getByTestId("onboarding-policy-retry").focus();
  up = true;
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("onboarding-policy-agree")).toBeVisible();
  expect(await insideDialog()).toBe(true);

  // The create screen.
  up = false;
  await page.reload();
  await page.getByTestId("create-identity-cta").click();
  await page.getByTestId("onboarding-policy-retry").focus();
  up = true;
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("onboarding-policy-agree")).toBeVisible();
  expect(await insideDialog()).toBe(true);
});

/** The sign-up dialog's buttons: the green one is the way this device supports, and both wait for both boxes. */
const FILLED = /(^|\s)bg-primary(\s|$)/;
const AGE_TERMS = {
  policy: { ...TERMS.policy, age_attestation_required: true },
};

async function withPlatformPasskey(page: Page) {
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
    },
  });
}

test("the sign-up dialog's legal text is exactly as it was", async ({
  page,
}) => {
  await start(page, () => ({ status: 200, json: AGE_TERMS }));
  await page.goto("/");
  await page.getByTestId("create-identity-cta").click();
  const boxes = page.getByTestId("onboarding-policy");
  await expect(boxes).toBeVisible();
  const [age, terms] = await boxes.locator("label").all();
  await expect(age).toHaveText("I am 18 years of age or older.");
  await expect(terms).toHaveText(
    "I agree to the Terms of use and have read the Privacy note. Posts and votes are public.",
  );
  await expect(terms.getByRole("link", { name: "Terms of use" })).toBeVisible();
  await expect(terms.getByRole("link", { name: "Privacy note" })).toBeVisible();
});

test("on a device that can make a passkey, the passkey button is the green one", async ({
  page,
}) => {
  await start(page, () => ({ status: 200, json: AGE_TERMS }));
  await withPlatformPasskey(page);
  await page.goto("/");
  await page.getByTestId("create-identity-cta").click();
  const passkey = page.getByTestId("onboarding-passkey");
  const plain = page.getByTestId("onboarding-create");
  await expect(passkey).toHaveClass(FILLED);
  await expect(plain).not.toHaveClass(FILLED);
  await expect(
    page.getByTestId("onboarding-dialog").locator("button.bg-primary"),
  ).toHaveCount(1);
  // Both ways keep their own note.
  await expect(page.getByTestId("onboarding-passkey-note")).toContainText(
    "On another device you need your recovery key",
  );
});

test("on a device with no passkey, 'Create without a passkey' is the green one", async ({
  page,
}) => {
  await start(page, () => ({ status: 200, json: AGE_TERMS }));
  // A browser that says it cannot make one (as headless Chromium does with no authenticator).
  await page.addInitScript(() => {
    if (window.PublicKeyCredential)
      window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable =
        () => Promise.resolve(false);
  });
  await page.goto("/");
  await page.getByTestId("create-identity-cta").click();
  await expect(page.getByTestId("onboarding-create")).toHaveClass(FILLED);
  await expect(page.getByTestId("onboarding-passkey")).not.toHaveClass(FILLED);
  await expect(
    page.getByTestId("onboarding-dialog").locator("button.bg-primary"),
  ).toHaveCount(1);
});

test("both buttons wait for both boxes, say so, and keep a 44 px reach on a phone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await start(page, () => ({ status: 200, json: AGE_TERMS }));
  await page.goto("/");
  // On a phone the way in is the tab bar's Sign in, whose dialog switches to making an account.
  await page.getByTestId("sign-in-cta").click();
  await page.getByTestId("onboarding-signin-key").waitFor();
  await page.getByRole("button", { name: "Create an account" }).click();

  await page.getByTestId("onboarding-name").fill("Nia Patel");
  const passkey = page.getByTestId("onboarding-passkey");
  const plain = page.getByTestId("onboarding-create");
  await expect(passkey).toBeDisabled();
  await expect(plain).toBeDisabled();
  await expect(page.getByTestId("onboarding-tick-hint")).toHaveText(
    "Tick both boxes to continue.",
  );
  // One box is not enough.
  await page.getByTestId("onboarding-policy-age").check();
  await expect(plain).toBeDisabled();
  await page.getByTestId("onboarding-policy-agree").check();
  await expect(passkey).toBeEnabled();
  await expect(plain).toBeEnabled();
  await expect(page.getByTestId("onboarding-tick-hint")).toHaveCount(0);

  // The age and terms rows are 44 px tall, and the buttons are on screen without scrolling.
  for (const row of await page
    .getByTestId("onboarding-policy")
    .locator("label")
    .all()) {
    expect((await row.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  await expect(passkey).toBeInViewport({ ratio: 1 });
  await expect(plain).toBeInViewport({ ratio: 1 });
  expect((await plain.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
});

test("when the passkey does not work, the line says what to do and the other way becomes the green one", async ({
  page,
}) => {
  await start(page, () => ({ status: 200, json: AGE_TERMS }));
  await withPlatformPasskey(page);
  await page.addInitScript(() => {
    navigator.credentials.create = () =>
      Promise.reject(new DOMException("cancelled", "NotAllowedError"));
  });
  await page.goto("/");
  await page.getByTestId("create-identity-cta").click();
  await page.getByTestId("onboarding-name").fill("Nia Patel");
  await page.getByTestId("onboarding-policy-age").check();
  await page.getByTestId("onboarding-policy-agree").check();
  const passkey = page.getByTestId("onboarding-passkey");
  const plain = page.getByTestId("onboarding-create");
  await expect(passkey).toHaveClass(FILLED);
  await passkey.click();

  const error = page.getByTestId("onboarding-error");
  await expect(error).toContainText("The passkey was cancelled.");
  await expect(error).toContainText("create without a passkey");
  await expect(plain).toHaveClass(FILLED);
  await expect(passkey).not.toHaveClass(FILLED);
  // The other way works from there.
  await Promise.all([page.waitForNavigation(), plain.click()]);
  expect(
    await page.evaluate(() => localStorage.getItem("buzz.identity.nsec")),
  ).not.toBeNull();
});

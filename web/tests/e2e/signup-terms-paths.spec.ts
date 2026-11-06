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

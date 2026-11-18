import { type Browser, expect, type Page } from "@playwright/test";
import type { PressCounter } from "../helpers/press-counter";

/** A short tag for this run, so names and project ids never meet those of an earlier run on the same database. */
export const RUN = Date.now().toString(36).slice(-5);

/** A person with a phone-sized browser of their own (their own storage), on the server under test. */
export async function phone(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    baseURL: process.env.BUZZ_REAL_RELAY_URL ?? "http://localhost:3199",
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  context.setDefaultTimeout(30_000);
  return context.newPage();
}

/**
 * The hosted sign-up on the dialog that is open now: the name, the age tick, the terms tick and Create, counted on
 * `path` when one is given. The legal text is checked word for word before anything is ticked.
 */
export async function signUp(page: Page, name: string, path?: PressCounter) {
  await expect(page.getByTestId("onboarding-dialog")).toBeVisible();
  const policy = page.getByTestId("onboarding-policy");
  await expect(policy).toContainText("I am 18 years of age or older.");
  await expect(policy).toContainText(
    "I agree to the Terms of use and have read the Privacy note. Posts and votes are public.",
  );
  const name_ = page.getByTestId("onboarding-name");
  const age = page.getByTestId("onboarding-policy-age");
  const agree = page.getByTestId("onboarding-policy-agree");
  const create = page.getByTestId("onboarding-create");
  if (path) {
    await path.type(name_, name, "Name");
    await path.tick(age, "age");
    await path.tick(agree, "terms");
    await path.press(create, "Create");
  } else {
    await name_.fill(name);
    await age.check();
    await agree.check();
    await create.click();
  }
}

/** Make an account from the sign-up screen, as a person who opens the app and signs up first. */
export async function newPerson(page: Page, name: string) {
  await page.goto("/welcome");
  await signUp(page, name);
  await expect(page.getByTestId("onboarding-dialog")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("buzz.identity.nsec")))
    .not.toBeNull();
}

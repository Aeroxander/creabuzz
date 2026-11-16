import { expect, test, type Page } from "@playwright/test";

import { createMockRelay } from "./mock-relay";
import { install, now, projectRecord, pubkeyOf } from "./helpers/project-world";

/**
 * The sign-up and sign-in dialogs survive a change of width.
 *
 * The app swaps its top bar for a tab bar at 768 px (a phone turned sideways, a window dragged narrower). The dialogs
 * used to live inside whichever bar was showing, so the swap closed one someone was part way through. They now live
 * once, beside both bars. What was typed and ticked stays in the dialog's own state: it survives the swap and is gone
 * when the dialog is dismissed. Whatever opens the dialog (the top bar's Sign up, Start, Follow) is checked the same.
 */

const WIDE = { width: 1280, height: 800 };
const NARROW = { width: 700, height: 800 };

const TERMS = {
  policy: {
    version: "v1",
    terms_markdown: "# Terms\n\nBe kind.",
    privacy_markdown: "# Privacy",
    age_attestation_required: true,
  },
};

const FOUNDER = pubkeyOf("e1".repeat(32));
const CARD = `/p/rhythm-${FOUNDER.slice(0, 16)}`;

async function signedOut(page: Page, path: string) {
  const relay = createMockRelay({ applyDeletions: true });
  relay.seed(projectRecord(FOUNDER, "rhythm", "Rhythm", now() - 86_400));
  await install(page, relay, null);
  await page.route("**/api/join-policy", (route) =>
    route.fulfill({ status: 200, json: TERMS }),
  );
  await page.setViewportSize(WIDE);
  await page.goto(path);
  return relay;
}

async function layout(page: Page, size: { width: number; height: number }) {
  await page.setViewportSize(size);
  await expect(page.getByTestId("app-nav")).toHaveAttribute(
    "data-layout",
    size.width >= 768 ? "wide" : "phone",
  );
}

/** What was typed and ticked is still in the one dialog, after the bars swapped twice. */
async function expectCreateDialogKept(page: Page) {
  const dialog = page.getByTestId("onboarding-dialog");
  await expect(dialog).toHaveCount(1);
  await expect(page.getByTestId("onboarding-name")).toHaveValue("Sol");
  await expect(page.getByTestId("onboarding-policy-age")).toBeChecked();
  await expect(page.getByTestId("onboarding-policy-agree")).toBeChecked();
}

async function fillCreateDialog(page: Page) {
  await page.getByTestId("onboarding-name").fill("Sol");
  await page.getByTestId("onboarding-policy-age").check();
  await page.getByTestId("onboarding-policy-agree").check();
}

test("the top bar's Sign up dialog stays open, filled in, when the width crosses 768 px both ways", async ({
  page,
}) => {
  await signedOut(page, "/");
  await page.getByTestId("create-identity-cta").click();
  await fillCreateDialog(page);

  await layout(page, NARROW);
  await expectCreateDialogKept(page);
  await layout(page, WIDE);
  await expectCreateDialogKept(page);

  // Dismissed, nothing was kept anywhere: the next one opens empty and unticked.
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(page.getByTestId("onboarding-dialog")).toHaveCount(0);
  await page.getByTestId("create-identity-cta").click();
  await expect(page.getByTestId("onboarding-name")).toHaveValue("");
  await expect(page.getByTestId("onboarding-policy-age")).not.toBeChecked();
  await expect(page.getByTestId("onboarding-policy-agree")).not.toBeChecked();
  expect(
    await page.evaluate(() =>
      JSON.stringify([
        ...Object.entries(localStorage),
        ...Object.entries(sessionStorage),
      ]).includes("Sol"),
    ),
  ).toBe(false);
});

test("the sign-in dialog opened from the phone's tab bar stays open when the width grows", async ({
  page,
}) => {
  await signedOut(page, "/");
  await layout(page, NARROW);
  await page.getByTestId("sign-in-cta").click();
  await expect(page.getByTestId("onboarding-signin-form")).toBeVisible();
  await page.getByTestId("onboarding-signin-key").fill("ab".repeat(32));
  await page.getByTestId("onboarding-policy-agree").check();

  await layout(page, WIDE);
  await expect(page.getByTestId("onboarding-signin-form")).toBeVisible();
  await expect(page.getByTestId("onboarding-signin-key")).toHaveValue(
    "ab".repeat(32),
  );
  await expect(page.getByTestId("onboarding-policy-agree")).toBeChecked();
});

test("Start opens the same dialog, and it keeps its answers across a width change; nothing is made", async ({
  page,
}) => {
  const relay = await signedOut(page, "/start");
  const form = page.getByTestId("quick-start");
  await form.getByLabel("Project name").fill("Lantern");
  await form
    .getByLabel("What is the goal?")
    .fill("A first page three people read");
  await form.getByTestId("quick-how-number").click();
  await form.getByTestId("quick-start-go").click();
  await expect(page.getByTestId("onboarding-dialog")).toBeVisible();
  await fillCreateDialog(page);

  await layout(page, NARROW);
  await expectCreateDialogKept(page);
  await layout(page, WIDE);
  await expectCreateDialogKept(page);
  expect(
    relay.events.filter((e) => e.kind === 37001 && e.pubkey !== FOUNDER),
  ).toHaveLength(0);
});

test("the Follow dialog behaves the same", async ({ page }) => {
  await signedOut(page, CARD);
  await page.getByTestId("scorecard-follow").click();
  await expect(page.getByTestId("onboarding-dialog")).toBeVisible();
  await fillCreateDialog(page);

  await layout(page, NARROW);
  await expectCreateDialogKept(page);
  await layout(page, WIDE);
  await expectCreateDialogKept(page);
  // Escape is "Not now": the dialog goes, and the scorecard is as it was.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("onboarding-dialog")).toHaveCount(0);
  await expect(page.getByTestId("scorecard-follow")).toBeVisible();
});

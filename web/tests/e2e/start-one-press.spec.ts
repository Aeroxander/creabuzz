import { expect, test, type Page } from "@playwright/test";
import { getPublicKey } from "nostr-tools/pure";

import { expectAccessible } from "../helpers/a11y";
import { createMockRelay } from "./mock-relay";

/**
 * Start in one press, from a stranger to a live project.
 *
 * A person with no account fills in the three answers and presses Start once. The account dialog opens; when the
 * account exists the project and its goal are made with no second press, and the page opens with `?started=1` so it
 * can welcome them. The server here is slow to load the terms, so the sign-up takes a while: the project must still be
 * made exactly once. Around that: a press that was abandoned does not start a project later, the invite-only
 * requirement is read before anything is typed, and the button says why it waits while the person's earlier projects
 * are being read.
 */

const KEY = "5".repeat(64);
const ME = getPublicKey(Uint8Array.from(Buffer.from(KEY, "hex")));

type Relay = ReturnType<typeof createMockRelay>;

async function quietChain(page: Page) {
  await page.route("http://127.0.0.1:8545/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x10" }),
    }),
  );
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

/** Terms that take their time to load, so the sign-up dialog is slow to be ready. */
async function termsAfter(page: Page, ms: number) {
  await page.route("**/api/join-policy", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    await route.fulfill({
      status: 200,
      json: {
        policy: {
          version: "v1",
          terms_markdown: "# Terms\n\nBe kind.",
          privacy_markdown: "# Privacy",
          age_attestation_required: false,
        },
      },
    });
  });
}

async function open(
  page: Page,
  relay: Relay,
  {
    signedIn = false,
    access,
  }: { signedIn?: boolean; access?: "open" | "invite_only" } = {},
) {
  await quietChain(page);
  await relay.install(page);
  // After the mock server's own routes, so what it says about who may join is this.
  if (access) await answerAccess(page, access);
  if (signedIn) {
    await page.addInitScript((key) => {
      localStorage.setItem("buzz.identity.nsec", key);
      localStorage.setItem("buzz.identity.backedUp", "1");
    }, KEY);
  }
  await page.goto("/start");
}

const projects = (relay: Relay) => relay.events.filter((e) => e.kind === 37001);
const goals = (relay: Relay) =>
  relay.events.filter((e) => e.tags.some((t) => t[0] === "goal"));

test("a stranger presses Start once, signs up, and lands on the live project, made exactly once", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const relay = createMockRelay({ applyDeletions: true });
  await termsAfter(page, 1_500);
  await open(page, relay);

  const form = page.getByTestId("quick-start");
  // The form says what happens after the press, and says nothing about money or tokens.
  await expect(form.getByTestId("quick-next")).toHaveText(
    "Next you make a name for yourself. What you typed stays here.",
  );
  await expect(form).not.toContainText("Free to start");

  await form.getByLabel("Project name").fill("Nebula");
  await form
    .getByLabel("What is the goal?")
    .fill("A first version ten people use");
  // The example chip fills how we will know, and it can be edited.
  await form.getByTestId("quick-how-number").click();
  await expect(form.getByLabel("How will people know it worked?")).toHaveValue(
    "At least 10 people use it by the end of next month.",
  );
  await form.getByTestId("quick-category-software").click();
  await expect(form.getByTestId("quick-category-software")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // One press, pressed twice in a hurry: the account dialog opens and nothing is made yet.
  await form.getByTestId("quick-start-go").dblclick();
  await expect(page.getByTestId("onboarding-dialog")).toBeVisible();
  expect(projects(relay)).toHaveLength(0);
  await page.getByTestId("onboarding-name").fill("Mira Okafor");
  await page.getByTestId("onboarding-policy-agree").check();
  await page.getByTestId("onboarding-create").click();

  // No second press: the page reloads signed in, the project is made, and its page opens with the contract's flag.
  await expect(page).toHaveURL(/\/launchpad\/nebula\?.*started=1/, {
    timeout: 30_000,
  });
  expect(new URL(page.url()).searchParams.get("started")).toBe("1");
  await expect(
    page.getByTestId("project-goal").getByTestId("goal-text"),
  ).toHaveText("A first version ten people use");

  // Still one project and one goal after the sign-up has had time to announce itself more than once.
  await page.waitForTimeout(2_000);
  expect(projects(relay)).toHaveLength(1);
  expect(goals(relay)).toHaveLength(1);
  const [project] = projects(relay);
  expect(JSON.parse(project.content).pitch).toBe(
    "A first version ten people use",
  );
  // The kind is the project's topic; the sale-free record carries nothing else new.
  expect(project.tags).toContainEqual(["t", "software"]);
  // Nothing was left waiting: another visit to Start does not make a project.
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("creaton.start.quick.after-sign-up"),
    ),
  ).toBeNull();
});

test("a press abandoned at the account dialog and then changed does not start a project later", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const relay = createMockRelay();
  await termsAfter(page, 100);
  await open(page, relay);

  const form = page.getByTestId("quick-start");
  await form.getByLabel("Project name").fill("Comet");
  await form
    .getByLabel("What is the goal?")
    .fill("Ten built telescopes in a year");
  await form
    .getByLabel("How will people know it worked?")
    .fill("Ten people post a photo");
  await form.getByTestId("quick-start-go").click();
  await expect(page.getByTestId("onboarding-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("onboarding-dialog")).toBeHidden();

  // They change their mind about the goal, then sign up from the header instead.
  await form
    .getByLabel("What is the goal?")
    .fill("Twenty built telescopes in a year");
  await page.getByTestId("create-identity-cta").click();
  await page.getByTestId("onboarding-name").fill("Mira Okafor");
  await page.getByTestId("onboarding-policy-agree").check();
  await page.getByTestId("onboarding-create").click();

  // Signed in, the form is as they left it, and nothing was made behind their back.
  await expect(page.getByTestId("user-chip")).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByTestId("quick-start").getByLabel("What is the goal?"),
  ).toHaveValue("Twenty built telescopes in a year");
  await page.waitForTimeout(1_500);
  expect(projects(relay)).toHaveLength(0);
  expect(goals(relay)).toHaveLength(0);
});

test("invite-only: the requirement is at the top of Start for someone with no account, and nowhere else", async ({
  page,
}) => {
  const relay = createMockRelay();
  await open(page, relay, { access: "invite_only" });

  const notice = page.getByTestId("start-invite-only");
  await expect(notice).toContainText("This server is invite-only.");
  await expect(notice).toContainText("open the invite link you were sent");
  // First in the form, before the heading and every box.
  const noticeBox = await notice.boundingBox();
  const nameBox = await page.getByTestId("quick-name").boundingBox();
  expect(noticeBox && nameBox && noticeBox.y < nameBox.y).toBe(true);
});

test("an open server, or someone already signed in, sees no invite notice on Start", async ({
  page,
}) => {
  const relay = createMockRelay();
  await open(page, relay, { access: "open" });
  await expect(page.getByTestId("quick-start")).toBeVisible();
  await expect(page.getByTestId("start-invite-only")).toHaveCount(0);

  await page.evaluate((key) => {
    localStorage.setItem("buzz.identity.nsec", key);
  }, KEY);
  await page.route("**/info", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/nostr+json",
      body: JSON.stringify({ name: "Mock server", access: "invite_only" }),
    }),
  );
  await page.reload();
  await expect(page.getByTestId("quick-start")).toBeVisible();
  await expect(page.getByTestId("start-invite-only")).toHaveCount(0);
});

test("while the earlier projects are read, the button waits and says why, then starts", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const relay = createMockRelay();
  relay.holdReads((filter) => {
    const f = filter as { kinds?: number[]; authors?: string[] };
    return (f.kinds ?? []).includes(37001) && (f.authors ?? []).includes(ME);
  });
  await open(page, relay, { signedIn: true });

  const form = page.getByTestId("quick-start");
  await expect(form.getByTestId("quick-start-go")).toBeDisabled();
  await expect(form.getByTestId("quick-lists-loading")).toContainText(
    "Checking your earlier projects",
  );
  relay.releaseReads();
  await expect(form.getByTestId("quick-start-go")).toBeEnabled();
  await expect(form.getByTestId("quick-lists-loading")).toHaveCount(0);
});

test("an AI project says who answers for agent work and offers starter wording that fills editable boxes", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const relay = createMockRelay();
  await open(page, relay, { signedIn: true });

  const form = page.getByTestId("quick-start");
  // Nothing about agents until the kind is chosen.
  await expect(form.getByTestId("quick-ai")).toHaveCount(0);
  await form.getByTestId("quick-category-ai-agent-or-tool").click();
  await expect(form.getByTestId("quick-ai-accountability")).toHaveText(
    "An agent can do work for your project, but a named person answers for it. Goals and promises are signed by a person.",
  );
  await form.getByTestId("quick-ai-kind-dataset-benchmark").click();
  await form.getByTestId("quick-ai-goal-0").click();
  await form.getByTestId("quick-ai-how-0").click();
  await expect(form.getByLabel("What is the goal?")).toHaveValue(
    "A public collection of 1,000 checked examples that anyone can download.",
  );
  await expect(form.getByLabel("How will people know it worked?")).toHaveValue(
    /1,000 examples published/,
  );
  await expectAccessible(page, "Start with the AI starter wording open");
  // At phone width the chips wrap and nothing scrolls sideways.
  await page.setViewportSize({ width: 390, height: 800 });
  // Read once the width has taken effect: the layout settles a moment after the viewport changes.
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });
  // First promises and tasks wait under a closed disclosure for after the start.
  await expect(form.getByTestId("quick-ai-later")).toHaveJSProperty(
    "open",
    false,
  );

  await form.getByLabel("Project name").fill("Open Skies Data");
  await form.getByTestId("quick-start-go").click();
  await expect(page).toHaveURL(/\/launchpad\/open-skies-data\?.*started=1/, {
    timeout: 30_000,
  });
  const [project] = projects(relay);
  // The kind is a plain topic; the starter wording is text the founder owns, so nothing new is stored for it.
  expect(project.tags).toContainEqual(["t", "ai agent or tool"]);
  expect(JSON.stringify(project)).not.toContain("dataset-benchmark");
});

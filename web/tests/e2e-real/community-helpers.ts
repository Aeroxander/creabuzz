import { expect, type Browser, type Page } from "@playwright/test";
import { generateSecretKey } from "nostr-tools/pure";

/**
 * Shared steps for the real-server journeys that start from a community of their own (`scripts/web-invite-only-e2e.sh`):
 * a person with a fresh account, a community they own, an invite link, and a second person who joins with it.
 */

export const PORT = process.env.E2E_INVITE_PORT ?? "3199";

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** A name no earlier run used, short enough for a community name. */
export const unique = () =>
  `e2e-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

export async function signInAsNewAccount(page: Page) {
  const nsec = hex(generateSecretKey());
  await page.addInitScript((key) => {
    // Only the first load of this tab: a later reload must keep whatever relay the app was pointed at.
    if (!window.localStorage.getItem("buzz.identity.nsec")) {
      window.localStorage.setItem("buzz.identity.nsec", key);
    }
  }, nsec);
}

/** A person in a browser of their own, with an account no one else has. */
export async function newPerson(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  await signInAsNewAccount(page);
  return page;
}

/** Open People and access from the sidebar, where everyone has it (D110). */
export async function openPeople(page: Page) {
  await page.getByTestId("content-pane").waitFor({ timeout: 30_000 });
  await page.getByTestId("people-toggle").click();
  await expect(page.getByTestId("people-section")).toBeVisible({
    timeout: 30_000,
  });
}

export async function setAccess(owner: Page, access: "open" | "invite_only") {
  await owner.getByTestId(`access-${access}`).check();
  await owner.getByTestId("access-confirm-yes").click();
  await expect(owner.getByTestId("access-confirm")).toHaveCount(0, {
    timeout: 30_000,
  });
}

/**
 * `owner` (a signed-in page) makes a community called `name` and lands in it. It is open unless `access` says
 * `"invite_only"`, which is one press on the second of the two choices.
 */
export async function createCommunity(
  owner: Page,
  name: string,
  access: "open" | "invite_only" = "open",
) {
  await owner.goto("/c");
  await owner.getByTestId("create-community").click();
  await owner.getByTestId("community-name").fill(name);
  if (access === "invite_only") {
    await owner.getByText("Only people I invite").click();
    await expect(
      owner.getByTestId("community-access-invite_only"),
    ).toBeChecked();
  }
  await owner.getByTestId("community-create-submit").click();
  await owner.waitForURL(new RegExp(`/c/${name}\\.localhost`), {
    timeout: 30_000,
  });
}

/** With the Org page open, make a one-person invite link and return it. */
export async function makeInviteLink(owner: Page): Promise<string> {
  await owner.getByTestId("invite-make").click();
  return owner.getByTestId("invite-link").inputValue({ timeout: 30_000 });
}

/** A new person opens `inviteUrl`, joins in the browser, and ends up inside the community at `host`. */
export async function joinWithInvite(
  browser: Browser,
  inviteUrl: string,
  host: string,
): Promise<Page> {
  const person = await newPerson(browser);
  await person.goto(inviteUrl);
  await person.getByRole("button", { name: "Join this community" }).click();
  await person.waitForURL((url) => url.pathname === "/", { timeout: 30_000 });
  return person;
}

/**
 * A person with NO account opens `inviteUrl`, picks `name`, and lets the page make an account and join. Returns their page,
 * inside the community at `host`.
 */
export async function joinAsNewcomer(
  browser: Browser,
  inviteUrl: string,
  host: string,
  name: string,
): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  await page.goto(inviteUrl);
  await page.getByTestId("invite-name").fill(name);
  await page.getByTestId("invite-create-and-join").click();
  await page.waitForURL((url) => url.pathname === "/", { timeout: 30_000 });
  return page;
}

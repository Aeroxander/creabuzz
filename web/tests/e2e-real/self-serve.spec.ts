import { expect, test, type Page } from "@playwright/test";
import { generateSecretKey } from "nostr-tools/pure";

/**
 * Starting a community of your own, against a REAL server (`scripts/web-self-serve-e2e.sh` boots it with self-serve on).
 *
 * Nothing is mocked: the browser signs the create request with a fresh account, the server makes the community and its
 * owner row, the page connects to the new address and signs in over a real WebSocket, and the team setup runs every step
 * through the real server, including the ones only an owner may take.
 */

test.use({ viewport: { width: 1280, height: 900 } });

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** A name no earlier run used, short enough for a community name. */
const unique = () =>
  `e2e-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

async function signInAsNewAccount(page: Page) {
  const nsec = hex(generateSecretKey());
  await page.addInitScript((key) => {
    // Only the first load of this tab: a later reload must keep whatever relay the app was pointed at.
    if (!window.localStorage.getItem("buzz.identity.nsec")) {
      window.localStorage.setItem("buzz.identity.nsec", key);
    }
  }, nsec);
}

async function createCommunity(page: Page, name: string) {
  await page.goto("/c");
  await page.getByTestId("create-community").click();
  await page.getByTestId("community-name").fill(name);
  await page.getByTestId("community-create-submit").click();
}

test("a person starts a community, owns it, and sets up a team in it", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const name = unique();
  await signInAsNewAccount(page);
  await createCommunity(page, name);

  // They land in the community they made.
  await page.waitForURL(new RegExp(`/c/${name}\\.localhost`), {
    timeout: 30_000,
  });
  // The empty community opens on a prompt; the setup form is one press away.
  await page.getByRole("button", { name: "Set up community" }).last().click();
  await expect(page.getByTestId("start-project")).toBeVisible({
    timeout: 30_000,
  });

  // They are recognised as the owner, so the setup is not refused for want of a role.
  await expect(page.getByTestId("start-project-access")).toHaveCount(0, {
    timeout: 30_000,
  });
  await page.getByTestId("start-project-confirm").click();

  // Every step went through, including the owner-only ones (team, helper seats, limits, automations, pages).
  await expect(page.getByText("Your community is set up")).toBeVisible({
    timeout: 120_000,
  });
  await page.getByText("What was set up").click();
  await expect(page.getByText("33 of 33 done")).toBeVisible();

  // It survives a reload: the channels the setup made are there.
  await page.reload();
  await expect(page.getByText("writers-room").first()).toBeVisible({
    timeout: 30_000,
  });

  // A second person cannot take the same name, and is told so in words.
  const other = await browser.newPage();
  await signInAsNewAccount(other);
  await createCommunity(other, name);
  await expect(other.getByTestId("community-create-error")).toHaveText(
    "That name is taken. Pick another.",
  );
  await other.close();
});

test("a name the server keeps for itself is refused with a reason", async ({
  page,
}) => {
  await signInAsNewAccount(page);
  await createCommunity(page, "login");
  await expect(page.getByTestId("community-create-error")).toContainText(
    "kept for the service",
  );
});

import { expect, type Page, test } from "@playwright/test";
import { BACKER_EVM } from "../helpers/numbers-fixture";
import { expectAccessible } from "../helpers/a11y";
import { installWallet } from "./helpers/money-world";
import { COMMUNITY_HOST, createMockRelay, PREVIEW_PORT } from "./mock-relay";
import { pubkeyOf } from "./helpers/world";

/**
 * A browser with a wallet and a passkey account can say where it backs from, on You, by keyboard and by touch. The
 * choice is a labelled group of two radios; the arrow keys move between them and a tap picks one; the choice is
 * remembered. Run with the phone settings by `scripts/pot-app-phone-e2e.sh`; skipped without them.
 */

const run = process.env.PHONE_E2E_BUNDLER_PORT ? test : test.skip;
const RELAY = pubkeyOf("c7".repeat(32));
const ORIGIN = `http://localhost:${PREVIEW_PORT}`;

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

run(
  "the choice between the wallet and the passkey account works by keyboard and by touch",
  async ({ page }) => {
    await addVirtualAuthenticator(page);
    await installWallet(page, { account: BACKER_EVM });
    const relay = createMockRelay();
    await relay.install(page);
    await page.route("**/api/join-policy", (route) =>
      route.fulfill({ status: 200, json: {} }),
    );
    await page.route("**/info", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/nostr+json",
        body: JSON.stringify({
          name: "Mock server",
          investing: true,
          self: RELAY,
        }),
      }),
    );
    await page.addInitScript(
      (url) => window.localStorage.setItem("buzz.relayUrl", url),
      `ws://${COMMUNITY_HOST}`,
    );

    await page.goto(`${ORIGIN}/welcome`);
    await page.getByTestId("onboarding-name").fill("Mira Okafor", {
      timeout: 20_000,
    });
    await page.getByTestId("onboarding-passkey").click();
    await page.waitForURL(`${ORIGIN}/`, { timeout: 20_000 });

    await page.goto(`${ORIGIN}/you`);
    const group = page.getByRole("group", { name: "Back from" });
    await expect(group).toBeVisible({ timeout: 20_000 });
    const wallet = page.getByRole("radio", {
      name: /The wallet in this browser/,
    });
    const passkey = page.getByRole("radio", { name: /My passkey account/ });
    // The wallet stays the default, as it was.
    await expect(wallet).toBeChecked();
    await expect(passkey).not.toBeChecked();
    const choice = () =>
      page.evaluate(() => localStorage.getItem("creaton.money.sender"));
    expect(await choice()).toBeNull();

    await expectAccessible(page, "You, with the choice of where to back from");

    // Keyboard: focus the group, arrow to the next radio.
    await wallet.focus();
    await page.keyboard.press("ArrowDown");
    await expect(passkey).toBeChecked();
    await expect(passkey).toBeFocused();
    expect(await choice()).toBe("passkey");
    await expect(page.getByTestId("sender-passkey-words")).toContainText(
      "The server pays the network fee",
    );
    await page.keyboard.press("ArrowUp");
    await expect(wallet).toBeChecked();
    expect(await choice()).toBe("wallet");
    await expect(page.getByTestId("sender-passkey-words")).toHaveCount(0);

    // Touch: tap the label's words, not the dot.
    await page.getByText("My passkey account", { exact: true }).tap();
    await expect(passkey).toBeChecked();
    expect(await choice()).toBe("passkey");

    // Remembered over a reload.
    await page.reload();
    await expect(
      page.getByRole("radio", { name: /My passkey account/ }),
    ).toBeChecked({
      timeout: 20_000,
    });
  },
);

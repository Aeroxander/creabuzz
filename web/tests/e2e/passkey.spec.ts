import { expect, test, type Page } from "@playwright/test";

import { createMockRelay } from "./mock-relay";

/**
 * Passkey ceremony prototype against a real WebAuthn stack.
 *
 * Chrome's CDP virtual authenticator stands in for Touch ID and exercises the
 * production navigator.credentials path end to end: one registration deriving
 * both identity roots (PRF → secp256k1 Nostr key + attested secp256r1 owner
 * key), the storage posture (public material only), and reload → unlock
 * re-deriving the registered identity.
 */

async function addVirtualAuthenticator(page: Page, hasPrf = true) {
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
        hasPrf,
      },
    },
  );
  return { client, authenticatorId };
}

/**
 * Navigate to the ceremony on the `localhost` origin.
 *
 * Chrome refuses WebAuthn ceremonies on IP-literal origins (both an IP RP id
 * and the `localhost` mapping come back SecurityError on `127.0.0.1`), so the
 * spec drives the same preview server through `http://localhost:4173`, the
 * sanctioned loopback origin where rpId `localhost` is valid.
 */
async function openCeremony(page: Page) {
  await page.goto("http://localhost:4173/identity-demo");
}

test("one registration derives both identity roots and stores only public material", async ({
  page,
}) => {
  await addVirtualAuthenticator(page);
  await openCeremony(page);

  await page.getByTestId("passkey-create").click();

  const nostr = page.getByTestId("passkey-nostr-pubkey");
  const r1 = page.getByTestId("passkey-r1-key");
  await expect(nostr).toBeVisible();
  await expect(nostr).toHaveText(/^[0-9a-f]{64}$/);
  // 65-byte uncompressed secp256r1 point: 0x04 ‖ x ‖ y.
  await expect(r1).toHaveText(/^04[0-9a-f]{128}$/);
  await expect(page.getByTestId("passkey-r1-address")).toHaveText(
    /^0x[0-9a-f]{40}$/,
  );

  // PRF evaluation at create, through the real extension plumbing — the
  // wave-4 unknown this prototype exists to retire.
  await expect(page.getByTestId("passkey-mode")).toHaveText("prf");

  // Storage posture: exactly the public record, and a PRF-derived identity
  // must not mint a browser nsec on the side.
  const stored = await page.evaluate(() =>
    Object.keys(window.localStorage)
      .filter((key) => key.startsWith("buzz."))
      .sort(),
  );
  expect(stored).toEqual([
    "buzz.passkey.credentialId",
    "buzz.passkey.mode",
    "buzz.passkey.pubkey",
    "buzz.passkey.r1",
    "buzz.passkey.salt",
  ]);
  expect(
    await page.evaluate(() =>
      window.localStorage.getItem("buzz.identity.nsec"),
    ),
  ).toBeNull();
});

test("reload → Continue with Touch ID re-derives the registered identity", async ({
  page,
}) => {
  await addVirtualAuthenticator(page);
  await openCeremony(page);

  await page.getByTestId("passkey-create").click();
  await expect(page.getByTestId("passkey-r1-key")).toBeVisible();
  const nostrBefore = await page
    .getByTestId("passkey-nostr-pubkey")
    .textContent();
  const r1Before = await page.getByTestId("passkey-r1-key").textContent();

  // A reload drops the page-memory key; only the public record survives.
  await page.reload();
  await expect(page.getByTestId("passkey-signin")).toBeVisible();

  await page.getByTestId("passkey-signin").click();

  // Unlock succeeds only if the assertion's PRF output re-derives the
  // registered key (ensureSamePubkey refuses anything else), and the public
  // roots must be byte-identical across the reload.
  await expect(page.getByText("in page memory now")).toBeVisible();
  await expect(page.getByTestId("passkey-nostr-pubkey")).toHaveText(
    nostrBefore ?? "",
  );
  await expect(page.getByTestId("passkey-r1-key")).toHaveText(r1Before ?? "");
});

test("removing the passkey clears the stored record", async ({ page }) => {
  await addVirtualAuthenticator(page);
  await openCeremony(page);

  await page.getByTestId("passkey-create").click();
  await expect(page.getByTestId("passkey-r1-key")).toBeVisible();

  await page.getByTestId("passkey-remove").click();

  await expect(page.getByTestId("passkey-create")).toBeVisible();
  const stored = await page.evaluate(() =>
    Object.keys(window.localStorage).filter((key) =>
      key.startsWith("buzz.passkey"),
    ),
  );
  expect(stored).toEqual([]);
});

test("signing up with a passkey publishes the name that was typed", async ({
  page,
}) => {
  await addVirtualAuthenticator(page);
  const relay = createMockRelay();
  await relay.install(page);
  // Passkeys need the page on `localhost`, but the mock server answers on the
  // loopback address, so this browser is told to use that one.
  await page.addInitScript(() =>
    window.localStorage.setItem("buzz.relayUrl", "ws://127.0.0.1:4173"),
  );
  await page.route("http://127.0.0.1:8545/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x10" }),
    }),
  );

  await page.goto("http://localhost:4173/");
  await page.getByTestId("create-identity-cta").first().click();
  await page.getByTestId("onboarding-name").fill("Mira Okafor");
  await page.getByTestId("onboarding-passkey").click();

  // The passkey only carries the name as its own label. The profile that every
  // screen reads people's names from has to say it too, or this person shows up
  // as a bare key everywhere.
  await expect
    .poll(() =>
      relay.events
        .filter((event) => event.kind === 0)
        .map((event) => JSON.parse(event.content).name),
    )
    .toContain("Mira Okafor");
});

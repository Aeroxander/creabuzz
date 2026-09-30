import { expect, test, type Page } from "@playwright/test";

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

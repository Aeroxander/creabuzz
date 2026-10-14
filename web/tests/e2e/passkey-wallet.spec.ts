import { expect, test, type Page } from "@playwright/test";

import { installFakeKernelChain } from "../helpers/fake-kernel-chain";
import { createMockRelay } from "./mock-relay";

/**
 * Linking a PASSKEY account as a payment wallet, in a real browser with a virtual passkey (Chrome's CDP authenticator
 * standing in for Touch ID) and a stand-in chain node that judges the account's signature the way the deployed Kernel
 * 0.3.3 and its passkey validator do (`tests/helpers/fake-kernel-chain.ts`).
 *
 * It needs a build with a chain configured, so it is not part of the default smoke run:
 *   scripts/web-passkey-wallet-e2e.sh
 *
 * What it proves: one passkey prompt signs the link; the app asks the account whether the signature is valid before it
 * publishes anything; the record carries the account's own signature, not an `ecrecover`-able one; a reader shows the
 * address as verified only after the chain says so; and an account that refuses, or a network that cannot be reached,
 * never produces a verified address.
 */

const ENABLED = process.env.E2E_PASSKEY_WALLET === "1";
test.skip(
  !ENABLED,
  "needs a build with VITE_ZERODEV_CHAIN_ID=31337 and VITE_CHAIN_RPC_URL=http://127.0.0.1:8545: scripts/web-passkey-wallet-e2e.sh",
);

const CHAIN_ID = 31337;
const ACCOUNT = "0x9a2bc3d4e5f60718293a4b5c6d7e8f9012345678";

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

/** A fresh person with a passkey account, on their own profile, with the chain stood in for. */
async function start(page: Page) {
  const relay = createMockRelay();
  await relay.install(page);
  // Passkeys need the page on `localhost`; the mock server answers on the loopback address.
  await page.addInitScript(() =>
    window.localStorage.setItem("buzz.relayUrl", "ws://127.0.0.1:4173"),
  );
  await addVirtualAuthenticator(page);
  const chain = await installFakeKernelChain(page, {
    account: ACCOUNT,
    chainId: CHAIN_ID,
    publicKey: () =>
      page.evaluate(() => window.localStorage.getItem("buzz.passkey.r1") ?? ""),
  });

  await page.goto("http://localhost:4173/");
  await page.getByTestId("create-identity-cta").first().click();
  await page.getByTestId("onboarding-name").fill("Mira Okafor");
  await page.getByTestId("onboarding-passkey").click();
  await expect
    .poll(() =>
      page.evaluate(() => window.localStorage.getItem("buzz.passkey.pubkey")),
    )
    .toMatch(/^[0-9a-f]{64}$/);
  const pubkey = (await page.evaluate(() =>
    window.localStorage.getItem("buzz.passkey.pubkey"),
  )) as string;
  await page.goto(`http://localhost:4173/u/${pubkey}`);
  return { relay, chain, pubkey };
}

async function openLinkDialog(page: Page) {
  await page
    .getByRole("button", { name: "Link payment wallet", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Link payment wallet" });
  await dialog.getByRole("checkbox").check();
  return dialog;
}

test("a passkey account links with one prompt, is checked by the account, and is shown only once the chain agrees", async ({
  page,
}) => {
  const { relay, chain, pubkey } = await start(page);
  const dialog = await openLinkDialog(page);
  await dialog.getByTestId("link-passkey-account").click();

  const card = page.getByTestId("payment-wallet");
  await expect(card.getByTestId("payment-wallet-address")).toHaveText(
    new RegExp(ACCOUNT, "i"),
    { timeout: 30_000 },
  );
  await expect(card).toContainText("Both signatures verified");

  // What was published: the account's own signature, behind a zero SIWE hash, authored by the Nostr key.
  const records = relay.events.filter((event) => event.kind === 37017);
  expect(records).toHaveLength(1);
  expect(records[0].pubkey).toBe(pubkey);
  const body = JSON.parse(records[0].content);
  expect(body.address).toBe(ACCOUNT);
  expect(body.siweMessageHash).toBe(`0x${"00".repeat(32)}`);
  expect(body.attestation.signature.startsWith("0x00")).toBe(true);
  expect(body.attestation.signature.length).toBeGreaterThan(300);
  expect(body.attestation.domain.chain_id).toBe(CHAIN_ID);
  expect(body.attestation.attestation.account).toBe(ACCOUNT);

  // The account was asked before publishing and again by the reader, and said yes each time.
  expect(chain.asked.length).toBeGreaterThanOrEqual(2);
  expect(chain.asked.every((answer) => answer.verdict)).toBe(true);
  expect(chain.asked.every((answer) => answer.account === ACCOUNT)).toBe(true);
});

test("an account that refuses the signature publishes nothing", async ({
  page,
}) => {
  const { relay, chain } = await start(page);
  chain.setMode("refuse");
  const dialog = await openLinkDialog(page);
  await dialog.getByTestId("link-passkey-account").click();
  await expect(dialog.getByTestId("wallet-sign-recovery")).toContainText(
    "did not accept the signature",
    { timeout: 30_000 },
  );
  expect(relay.events.filter((event) => event.kind === 37017)).toHaveLength(0);
  await expect(page.getByTestId("payment-wallet-address")).toHaveCount(0);
});

test("when the network cannot be reached, a smart account's address is not shown as verified", async ({
  page,
}) => {
  const { chain, pubkey } = await start(page);
  const dialog = await openLinkDialog(page);
  await dialog.getByTestId("link-passkey-account").click();
  await expect(page.getByTestId("payment-wallet-address")).toBeVisible({
    timeout: 30_000,
  });

  chain.setMode("down");
  await page.goto(`http://localhost:4173/u/${pubkey}`);
  const card = page.getByTestId("payment-wallet");
  await expect(card).toContainText("could not be made just now", {
    timeout: 30_000,
  });
  await expect(card.getByTestId("payment-wallet-address")).toHaveCount(0);
  await expect(
    card.getByRole("button", { name: "Copy payment address" }),
  ).toHaveCount(0);

  // And once it is reachable again, the proof checks out as before.
  chain.setMode("honest");
  await page.reload();
  await expect(page.getByTestId("payment-wallet-address")).toBeVisible({
    timeout: 30_000,
  });
});

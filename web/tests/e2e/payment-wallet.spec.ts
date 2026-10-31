import { expect, test, type Page } from "@playwright/test";
import { hexToBytes } from "@noble/hashes/utils.js";
import { finalizeEvent, verifyEvent } from "nostr-tools/pure";

import {
  newWalletAttestation,
  recoverWallet,
  siweMessageHash,
  walletAttestationDigest,
} from "../../src/features/identity/lib/wallet-proof";
import { waitForAnimations } from "../../../desktop/tests/helpers/animations";
import {
  ADDRESS,
  ME,
  NSEC,
  paymentRecord,
  signDigest,
} from "../helpers/payment-wallet";
import { createMockRelay } from "./mock-relay";

async function signIn(page: Page) {
  await page.addInitScript((nsec) => {
    localStorage.setItem("buzz.identity.nsec", nsec);
    localStorage.setItem("buzz.identity.backedUp", "1");
  }, NSEC);
}

async function walletAndServer(
  page: Page,
  options: {
    wrongChain?: boolean;
    reject?: boolean;
    failRegistration?: boolean;
  } = {},
) {
  const calls: string[] = [];
  let registrations = 0;
  await page.exposeFunction(
    "testPaymentWallet",
    (args: { method: string; params?: unknown[] }) => {
      calls.push(args.method);
      if (
        args.method === "eth_requestAccounts" ||
        args.method === "eth_accounts"
      )
        return [ADDRESS];
      if (args.method === "eth_chainId")
        return options.wrongChain ? "0x1" : "0x2105";
      if (options.reject) throw new Error("User declined the wallet signature");
      if (args.method === "personal_sign")
        return signDigest(
          hexToBytes(siweMessageHash(String(args.params?.[0])).slice(2)),
        );
      if (args.method === "eth_signTypedData_v4") {
        const typed = JSON.parse(String(args.params?.[1]));
        const proof = newWalletAttestation(
          typed.message.account,
          typed.message.npub.slice(2),
          typed.domain.chainId,
          0,
          typed.message.nonce,
        );
        proof.attestation.expires = typed.message.expires;
        proof.domain.name = typed.domain.name;
        proof.domain.version = typed.domain.version;
        proof.domain.verifying_contract = typed.domain.verifyingContract;
        return signDigest(walletAttestationDigest(proof));
      }
      throw new Error(`Unexpected wallet action: ${args.method}`);
    },
  );
  await page.addInitScript(() => {
    Object.defineProperty(window, "ethereum", {
      configurable: true,
      value: {
        request: (args: unknown) =>
          (
            window as unknown as {
              testPaymentWallet: (args: unknown) => Promise<unknown>;
            }
          ).testPaymentWallet(args),
      },
    });
  });
  await page.route("**/auth/siwe/nonce", (route) =>
    route.fulfill({
      json: { nonce: "testnonce123456", domain: "localhost", chain_id: 8453 },
    }),
  );
  await page.route("**/auth/siwe/register", (route) => {
    const body = route.request().postDataJSON();
    registrations++;
    expect(verifyEvent(body.nostr_proof)).toBe(true);
    expect(body.nostr_proof.pubkey).toBe(ME);
    expect(body.message).toContain(`nostr:${ME}`);
    expect(
      recoverWallet(
        hexToBytes(siweMessageHash(body.message).slice(2)),
        body.signature,
      ),
    ).toBe(ADDRESS);
    expect(
      recoverWallet(
        walletAttestationDigest(body.attestation),
        body.attestation.signature,
      ),
    ).toBe(ADDRESS);
    if (options.failRegistration)
      return route.fulfill({
        status: 503,
        json: { error: "Wallet registration is temporarily unavailable" },
      });
    return route.fulfill({
      json: { status: "already_member", npub: ME, evm_address: ADDRESS },
    });
  });
  return { calls, registrations: () => registrations };
}

async function publishFromProfile(page: Page) {
  await page
    .getByRole("button", { name: "Connect payment wallet", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Connect payment wallet" });
  await expect(
    dialog.getByRole("button", { name: "Connect wallet" }),
  ).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Connect wallet" }).click();
}

test("a public profile offers the full address and network only after verifying both signatures", async ({
  page,
  context,
}, testInfo) => {
  const relay = createMockRelay();
  relay.seed(paymentRecord());
  await relay.install(page);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 390, height: 750 });
  await page.goto(`/u/${ME}`);
  const card = page.getByTestId("payment-wallet");
  await expect(card).toContainText("Verified");
  await expect(card).toContainText("Base");
  await expect(card).not.toContainText("Chain 8453");
  await expect(card.getByTestId("payment-wallet-address")).toHaveText(
    "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  );
  await card.getByRole("button", { name: "Copy payment address" }).click();
  await expect(card).toContainText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  );
  await expect(
    card.getByRole("button", { name: "Change payment wallet" }),
  ).toHaveCount(0);
  expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  await waitForAnimations(page);
  await card.screenshot({
    path: testInfo.outputPath("payment-wallet-mobile.png"),
  });
});

test("a logged-in person can explicitly publish their wallet proof without changing Nostr account", async ({
  page,
}) => {
  const relay = createMockRelay();
  await relay.install(page);
  await signIn(page);
  const wallet = await walletAndServer(page);
  await page.goto(`/u/${ME}`);
  await publishFromProfile(page);
  await expect(page.getByTestId("payment-wallet")).toContainText("Verified");
  const record = relay.events.find((e) => e.kind === 37017);
  expect(record?.pubkey).toBe(ME);
  expect(record && verifyEvent(record)).toBe(true);
  expect(wallet.registrations()).toBe(1);
  expect(wallet.calls.filter((m) => m === "eth_signTypedData_v4")).toHaveLength(
    1,
  );
  // The way to your own profile is in the account menu (the timeline's side nav no longer repeats it).
  await page.getByTestId("user-chip").click();
  await expect(page.getByTestId("profile-menu-profile")).toHaveAttribute(
    "href",
    `/u/${ME}`,
  );
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.getByTestId("payment-wallet")).toContainText("Verified");
});

test("a refused public proof remains retryable after reload without another wallet signature", async ({
  page,
}) => {
  let refuse = true;
  const relay = createMockRelay({
    refuse: (e) => (e.kind === 37017 && refuse ? "Try again later" : null),
  });
  await relay.install(page);
  await signIn(page);
  const wallet = await walletAndServer(page);
  await page.goto(`/u/${ME}`);
  await publishFromProfile(page);
  await expect(page.getByRole("alert")).toContainText("Try again later");
  const signedCalls = wallet.calls.filter(
    (m) => m === "personal_sign" || m === "eth_signTypedData_v4",
  ).length;
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Retry wallet update" }),
  ).toBeVisible();
  refuse = false;
  await page.getByRole("button", { name: "Retry wallet update" }).click();
  await expect(page.getByTestId("payment-wallet")).toContainText("Verified");
  expect(
    wallet.calls.filter(
      (m) => m === "personal_sign" || m === "eth_signTypedData_v4",
    ),
  ).toHaveLength(signedCalls);
  expect(wallet.registrations()).toBe(1);
  await expect(
    page.getByRole("button", { name: "Retry wallet update" }),
  ).toHaveCount(0);
});

test("a failed wallet registration can be linked again without stranding the saved proof", async ({
  page,
}) => {
  const relay = createMockRelay();
  await relay.install(page);
  await signIn(page);
  const options = { failRegistration: true };
  const wallet = await walletAndServer(page, options);
  await page.goto(`/u/${ME}`);
  await publishFromProfile(page);
  await expect(page.getByRole("alert")).toContainText(
    "Wallet registration is temporarily unavailable",
  );
  const pending = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((key) =>
      key.startsWith("buzz.wallet-proof.pending:"),
    );
    const saved = key ? localStorage.getItem(key) : null;
    return saved ? JSON.parse(saved) : null;
  });
  expect(pending?.pubkey).toBe(ME);
  expect(relay.events.filter((event) => event.kind === 37017)).toHaveLength(0);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel" })
    .click();
  options.failRegistration = false;
  await page.getByRole("button", { name: "Link again", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Connect payment wallet" });
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Connect wallet" }).click();
  await expect(page.getByTestId("payment-wallet")).toContainText("Verified");
  const published = relay.events.find((event) => event.kind === 37017);
  expect(published?.created_at).toBeGreaterThan(pending.created_at);
  expect(wallet.registrations()).toBe(2);
  await expect(
    page.getByRole("button", { name: "Retry wallet update" }),
  ).toHaveCount(0);
});

for (const problem of ["wrong chain", "rejected signature"] as const) {
  test(`${problem} leaves no public payment address`, async ({ page }) => {
    const relay = createMockRelay();
    await relay.install(page);
    await signIn(page);
    const wallet = await walletAndServer(page, {
      wrongChain: problem === "wrong chain",
      reject: problem === "rejected signature",
    });
    await page.goto(`/u/${ME}`);
    await publishFromProfile(page);
    await expect(page.getByRole("alert")).toContainText(
      problem === "wrong chain" ? "Switch your wallet" : "declined",
    );
    expect(relay.events.filter((e) => e.kind === 37017)).toHaveLength(0);
    expect(wallet.registrations()).toBe(0);
    await expect(
      page.getByRole("button", { name: "Copy payment address" }),
    ).toHaveCount(0);
  });
}

test("removing the public wallet supersedes the old proof and survives reload", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(paymentRecord());
  await relay.install(page);
  await signIn(page);
  await page.goto(`/u/${ME}`);
  await page
    .getByTestId("payment-wallet")
    .getByRole("button", { name: "Disconnect", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Disconnect payment wallet" })
    .getByRole("button", { name: "Disconnect", exact: true })
    .click();
  await expect(page.getByTestId("payment-wallet")).toContainText(
    "removed its public payment wallet",
  );
  expect(relay.events.filter((e) => e.kind === 37017)).toHaveLength(2);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Copy payment address" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Connect payment wallet", exact: true }),
  ).toBeVisible();
});

test("copying checks for a revocation that arrived after the profile loaded", async ({
  page,
  context,
}) => {
  const relay = createMockRelay();
  const old = paymentRecord();
  relay.seed(old);
  await relay.install(page);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/u/${ME}`);
  await expect(page.getByTestId("payment-wallet")).toContainText("Verified");
  await page.evaluate(() => navigator.clipboard.writeText("unchanged"));
  relay.seed(
    finalizeEvent(
      {
        kind: 37017,
        tags: old.tags,
        created_at: old.created_at + 1,
        content: JSON.stringify({ ...JSON.parse(old.content), revoked: true }),
      },
      hexToBytes(NSEC),
    ),
  );
  await page.getByRole("button", { name: "Copy payment address" }).click();
  await expect(page.getByRole("alert")).toContainText("no longer confirmed");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "unchanged",
  );
  await expect(
    page.getByRole("button", { name: "Copy payment address" }),
  ).toHaveCount(0);
});

test("a locked passkey has a recovery action inside wallet linking", async ({
  page,
}) => {
  const relay = createMockRelay();
  await relay.install(page);
  await walletAndServer(page);
  await page.addInitScript(() => {
    localStorage.setItem("buzz.passkey.credentialId", "cred-1");
    localStorage.setItem("buzz.passkey.salt", "c2FsdA");
    localStorage.setItem("buzz.passkey.pubkey", "e".repeat(64));
    localStorage.setItem("buzz.passkey.mode", "prf");
    localStorage.removeItem("buzz.identity.nsec");
  });
  await page.goto(`/u/${"e".repeat(64)}`);
  await publishFromProfile(page);
  const dialog = page.getByRole("dialog", { name: "Connect payment wallet" });
  await expect(dialog.getByTestId("wallet-sign-recovery-action")).toHaveText(
    "Sign in with passkey",
  );
  expect(
    await page.evaluate(() => localStorage.getItem("buzz.identity.nsec")),
  ).toBeNull();
  expect(relay.events.filter((e) => e.kind === 37017)).toHaveLength(0);
});

for (const state of ["forged", "expired", "revoked"] as const) {
  test(`${state} latest proof offers no copyable payment recipient`, async ({
    page,
  }) => {
    const relay = createMockRelay();
    const old = paymentRecord();
    const latest = paymentRecord({
      expired: state === "expired",
      revoked: state === "revoked",
    });
    const body = JSON.parse(latest.content);
    if (state === "forged") body.attestation.signature = `0x${"00".repeat(65)}`;
    const event = finalizeEvent(
      {
        kind: 37017,
        tags: latest.tags,
        created_at: old.created_at + 1,
        content: JSON.stringify(body),
      },
      hexToBytes(NSEC),
    );
    relay.seed(old);
    relay.seed(event);
    await relay.install(page);
    await page.goto(`/u/${ME}`);
    await expect(page.getByTestId("payment-wallet")).toContainText(
      state === "forged"
        ? "could not be confirmed"
        : state === "expired"
          ? "needs to be connected again"
          : "removed",
    );
    await expect(
      page.getByRole("button", { name: "Copy payment address" }),
    ).toHaveCount(0);
  });
}

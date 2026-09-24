import { expect, test, type Page } from "@playwright/test";

/**
 * OPT-IN sponsored UserOperation proof — the REAL passkey path (Chrome CDP
 * virtual authenticator standing in for Touch ID) against REAL Sepolia.
 *
 * HARD GATE (skip cleanly otherwise): `E2E_SPONSORED_OPS === "1"` AND
 * `process.env.ZERODEV_API_KEY` set. Never part of the default smoke project —
 * this sends a REAL sponsored UserOperation and spends project sponsorship.
 *
 * Runbook (from `web/`):
 *
 *     set -a; . ../.env; set +a
 *     export VITE_ZERODEV_PROJECT_ID="$ZERODEV_PROJECT_ID" \
 *            VITE_ZERODEV_API_KEY="$ZERODEV_API_KEY" \
 *            VITE_ZERODEV_CHAIN_ID=11155111
 *     pnpm build
 *     E2E_SPONSORED_OPS=1 ZERODEV_API_KEY="$ZERODEV_API_KEY" \
 *       pnpm exec playwright test --project=sponsored-op
 *
 * The `VITE_*` values must be embedded at BUILD time (Vite bakes `import.meta
 * .env` into the bundle; `zerodev.ts` ledger header explains the transport) —
 * values are never committed and are masked in all output (secrets
 * discipline).
 *
 * What it proves (the wave goal): a FRESH passkey (registered on the virtual
 * authenticator, no fixture keys anywhere) owns a counterfactual Kernel 0.3.3
 * account; `sendKernel033UserOp` deploys it via initCode and lands a
 * sponsored self-call on Sepolia — sponsor-first, live EntryPoint hash-guard,
 * real WebAuthn assertion over the op hash (canonical clientDataJSON keeps
 * `"challenge":"` at the validator's fixed byte 23), bounded receipt poll.
 *
 * WebAuthn origin note (from `passkey.spec.ts`): Chrome refuses ceremonies on
 * IP-literal origins, so the spec drives the preview server through
 * `http://localhost:4173` where rpId `localhost` is valid.
 */

const ENABLED =
  process.env.E2E_SPONSORED_OPS === "1" && Boolean(process.env.ZERODEV_API_KEY);

async function addVirtualAuthenticator(page: Page) {
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
        hasPrf: true,
      },
    },
  );
  return { client, authenticatorId };
}

test.describe("sponsored UserOp (opt-in — spends real sponsorship)", () => {
  test.skip(
    !ENABLED,
    "set E2E_SPONSORED_OPS=1 and ZERODEV_API_KEY to run — this sends a real sponsored UserOperation on Sepolia",
  );

  test("a fresh virtual passkey deploys its Kernel 0.3.3 account and lands a sponsored UserOp", async ({
    page,
  }) => {
    // Sponsor simulation + deploy + inclusion can take minutes on Sepolia.
    test.setTimeout(300_000);
    await addVirtualAuthenticator(page);
    await page.goto("http://localhost:4173/identity-demo");

    // 1. Register a FRESH passkey (real navigator.credentials.create on the
    //    virtual authenticator — Touch ID stand-in; PRF + r1 owner key).
    await page.getByTestId("passkey-create").click();
    await expect(page.getByTestId("passkey-r1-key")).toHaveText(
      /^04[0-9a-f]{128}$/,
    );

    // 2. One click → the full production flow (the real WebAuthn assertion
    //    prompt auto-satisfies on the virtual authenticator).
    await page.getByTestId("sponsored-send").click();

    // 3. The typed result renders sender/tx/block. If sponsorship is denied
    //    or the build lacks VITE_ZERODEV_* config, the card shows the honest
    //    error instead — the failure screenshot carries it.
    const result = page.getByTestId("sponsored-result");
    await expect(result).toBeVisible({ timeout: 240_000 });
    await expect(result).toContainText("landed on Sepolia");
    // Fresh credential ⇒ fresh counterfactual ⇒ the initCode deploy path.
    await expect(result).toContainText("deployed this run");
    await expect(result).toContainText(/sender\s+0x[0-9a-f]{40}/);
    await expect(result).toContainText(/tx\s+0x[0-9a-f]{64}/);
    await expect(result).toContainText(/block\s+\d+\s+\(/);
  });
});

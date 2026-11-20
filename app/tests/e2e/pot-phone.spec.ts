import { expect, type Page, test } from "@playwright/test";
import { decodeExecuteCallData } from "../../../packages/creaton-core/src/aa/sponsoredSender.ts";
import { decodeCall } from "../../../packages/creaton-core/src/pot/abi-codec.ts";
import { PLAY_DOLLAR_ABI } from "../../../packages/creaton-core/src/pot/abis.generated.ts";
import * as reads from "../../../packages/creaton-core/src/pot/pot-reads.ts";
import { startFront } from "../anvil/fronts";
import { setUpPhoneChain } from "../anvil/phone-chain";
import { call, RPC } from "../anvil/rpc";
import { startStandInBundler } from "../anvil/stand-in-bundler";
import { PressCounter } from "../helpers/press-counter";
import {
  attachWorld,
  backFor,
  checkIn,
  launchProject,
} from "./helpers/live-chain";
import { FOUNDER_NOSTR, pageOf, seedServer } from "./helpers/live-browser";
import { RELAY } from "./helpers/money-world";
import { COMMUNITY_HOST, createMockRelay, PREVIEW_PORT } from "./mock-relay";

/** The legal line, word for word. */
const LEGAL_LINE =
  "Buyers acquire ownership only: governance and exit. No dividends or revenue share, ever, unless they contribute and earn one.";

/**
 * A phone with no wallet app signs up with a passkey and, from its passkey account, gets play dollars, Backs a project and
 * Takes out, in a real browser (Chrome's virtual authenticator) against the pot contracts on a real local chain, EntryPoint
 * v0.7, the deployed Kernel stack, and a stand-in bundler and sponsor at two addresses (the bundler refuses a request for the
 * fee, so the run only passes when the page asks the sponsor's own address). Run by `scripts/pot-app-phone-e2e.sh`, which builds
 * the app with the phone settings and starts anvil and the preview; skipped without them. Counts the presses and the passkey
 * prompts of each step.
 */

const run =
  RPC &&
  process.env.PHONE_E2E_BUNDLER_PORT &&
  process.env.PHONE_E2E_SPONSOR_PORT
    ? test
    : test.skip;
const ORIGIN = `http://localhost:${PREVIEW_PORT}`;
const NOTICE =
  "This is a test network. The dollars are play money, not real money.";

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
  "a phone with no wallet signs up with a passkey, gets play dollars, Backs and Takes out from its passkey account",
  async ({ page }) => {
    test.setTimeout(240_000);
    const world = await attachWorld(RPC);
    const chain = await setUpPhoneChain(world.who.admin);
    const bundler = await startStandInBundler({
      rpcUrl: RPC,
      paymaster: chain.paymaster,
      submitter: chain.submitter,
    });
    const bundlerFront = await startFront(
      bundler.url,
      (m) => !m.startsWith("zd_"),
      Number(process.env.PHONE_E2E_BUNDLER_PORT),
    );
    const sponsorFront = await startFront(
      bundler.url,
      (m) => m === "zd_sponsorUserOperation",
      Number(process.env.PHONE_E2E_SPONSOR_PORT),
    );
    const read = (to: string, data: string) => call(to, data);
    try {
      const project = await launchProject(world, "phone", FOUNDER_NOSTR);
      await backFor(world, project, world.who.second, 100n);
      await checkIn(world, project);
      const relay = createMockRelay();
      await seedServer(relay, world, project);
      await addVirtualAuthenticator(page);
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
      await page.addInitScript((url) => {
        window.localStorage.setItem("buzz.relayUrl", url);
        // Every time the page asks the passkey to sign.
        const w = window as unknown as { __prompts: number };
        w.__prompts = 0;
        const get = navigator.credentials.get.bind(navigator.credentials);
        navigator.credentials.get = (options) => {
          w.__prompts += 1;
          return get(options);
        };
      }, `ws://${COMMUNITY_HOST}`);
      const prompts = () =>
        page.evaluate(
          () => (window as unknown as { __prompts: number }).__prompts,
        );

      // Sign up with a passkey (no wallet in this browser).
      await page.goto(`${ORIGIN}/welcome`);
      await page
        .getByTestId("onboarding-name")
        .fill("Mira Okafor", { timeout: 20_000 });
      await page.getByTestId("onboarding-passkey").click();
      await expect(page.getByTestId("backup-sheet")).toBeVisible({
        timeout: 20_000,
      });
      await page.keyboard.press("Escape");
      await page.goto(`${ORIGIN}/you`);
      await expect(page.getByTestId("sender-passkey-words")).toContainText(
        "only key to the money in this account",
        { timeout: 20_000 },
      );
      const account = (
        (await page.getByTestId("sender-address").textContent()) ?? ""
      ).toLowerCase();
      expect(account).toMatch(/^0x[0-9a-f]{40}$/);

      await page.goto(`${ORIGIN}${pageOf(project.label)}`);
      await page.getByTestId("tab-money").click({ timeout: 20_000 });
      await expect(page.getByTestId("project-money")).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByTestId("play-money")).toContainText(NOTICE);

      // Play dollars from the faucet: one passkey prompt, no network coin in the account.
      const faucet = new PressCounter();
      let before = await prompts();
      await faucet.press(page.getByTestId("faucet-open"), "Get play dollars");
      await faucet.press(
        page.getByTestId("sheet-confirm"),
        "Get 1,000 play dollars",
      );
      await expect(page.getByTestId("faucet-sheet")).toBeHidden({
        timeout: 90_000,
      });
      const faucetPrompts = (await prompts()) - before;
      expect(await reads.balanceOf(read, project.dollar, account)).toBe(
        1_000_000_000n,
      );

      // Back: the same sheet as with a wallet, one signature, the passkey asked once.
      const quote = await reads.quoteBack(read, project.treasury, 25_000_000n);
      const back = new PressCounter();
      before = await prompts();
      await back.type(
        page.getByTestId("backing-amount"),
        "25",
        "How many dollars?",
      );
      await back.press(page.getByTestId("backing-review"), "Back");
      const sheet = page.getByTestId("back-sheet");
      await expect(page.getByTestId("back-shares")).toContainText("Shares", {
        timeout: 30_000,
      });
      await expect(sheet).toContainText("This is one signature.");
      await expect(sheet.getByTestId("ownership")).toHaveText(LEGAL_LINE);
      await back.press(
        page.getByTestId("sheet-confirm"),
        "Back with 25 dollars",
      );
      await expect(sheet).toBeHidden({ timeout: 90_000 });
      const backPrompts = (await prompts()) - before;
      const landed = await reads.balanceOf(read, project.shares, account);
      expect(landed).toBeGreaterThanOrEqual((quote.shares * 995n) / 1000n);
      expect(landed).toBeLessThanOrEqual((quote.shares * 1005n) / 1000n);
      // One operation for the whole Back, and it is the app's own call to the play dollar.
      const ops = bundler.sent.filter(
        (o) => o.sender.toLowerCase() === account,
      );
      const lastOp = ops[ops.length - 1].op;
      const inner = decodeExecuteCallData(lastOp.callData);
      expect(inner).toHaveLength(1);
      expect(decodeCall(PLAY_DOLLAR_ABI, inner[0].data)?.name).toBe(
        "transferAndCall",
      );

      // Take out all of it: one passkey prompt.
      const take = new PressCounter();
      before = await prompts();
      await expect(page.getByTestId("holding-take-out")).toBeVisible({
        timeout: 30_000,
      });
      const cashBefore = await reads.balanceOf(read, project.dollar, account);
      await take.press(page.getByTestId("holding-take-out"), "Take out");
      await expect(page.getByTestId("takeout-cash")).toBeVisible({
        timeout: 30_000,
      });
      await take.press(page.getByTestId("sheet-confirm"), "Take out");
      await expect(page.getByTestId("takeout-sheet")).toBeHidden({
        timeout: 90_000,
      });
      const takePrompts = (await prompts()) - before;
      expect(await reads.balanceOf(read, project.shares, account)).toBe(0n);
      expect(
        await reads.balanceOf(read, project.dollar, account),
      ).toBeGreaterThan(cashBefore);

      // The account paid no network fee, and every request went to the address meant for it.
      expect(
        BigInt(
          await (
            await fetch(RPC, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "eth_getBalance",
                params: [account, "latest"],
              }),
            })
          )
            .json()
            .then((j) => j.result),
        ),
      ).toBe(0n);
      expect(bundlerFront.refused.filter((m) => m.startsWith("zd_"))).toEqual(
        [],
      );
      expect(faucetPrompts).toBe(1);
      expect(backPrompts).toBe(1);
      expect(takePrompts).toBe(1);
      console.log(
        `MEASURED passkey, faucet: ${faucet.presses} presses, ${faucetPrompts} passkey prompt`,
      );
      console.log(
        `MEASURED passkey, Back: ${back.presses} presses, ${back.fields} field, ${backPrompts} passkey prompt, ${inner.length} call in one operation`,
      );
      console.log(
        `MEASURED passkey, Take out: ${take.presses} presses, ${takePrompts} passkey prompt`,
      );
    } finally {
      await bundlerFront.close();
      await sponsorFront.close();
      await bundler.close();
    }
  },
);

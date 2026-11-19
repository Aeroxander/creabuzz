import { expect, type Page, test } from "@playwright/test";
import { decodeExecuteCallData } from "../../../packages/creaton-core/src/aa/sponsoredSender.ts";
import { encodeFunctionData } from "../../../packages/creaton-core/src/launchpad/evmAbi.ts";
import {
  chainKeyOf,
  projectIdOf,
} from "../../../packages/creaton-core/src/launchpad/project-chain.ts";
import {
  backCalls,
  openBackingCall,
  positionCallData,
} from "../../src/features/money/calls";
import { deployPlatform, mintDollars } from "../anvil/deploy";
import { setUpPhoneChain } from "../anvil/phone-chain";
import { accounts, call, RPC, word } from "../anvil/rpc";
import { startStandInBundler } from "../anvil/stand-in-bundler";
import { DOLLAR, launched, openedRound, walletOf } from "../anvil/steps";
import { numbersContent } from "../helpers/numbers-fixture";
import { PLAN_V2_BUDGETS, PressCounter } from "../helpers/press-counter";
import { COMMUNITY_HOST, createMockRelay, PREVIEW_PORT } from "./mock-relay";
import { event, now, profile, projectRecord, pubkeyOf } from "./helpers/world";

/**
 * A phone with no wallet app backs a project from its passkey account, in a real browser (Chrome's virtual authenticator)
 * against a real local chain: the platform's contracts on anvil, EntryPoint v0.7 and the deployed Kernel stack, and a
 * stand-in bundler and sponsor. Run by `scripts/phone-e2e.sh`, which builds the app with the phone settings and starts
 * anvil and the preview; skipped without them. Counts the presses and the passkey prompts of a Back.
 */

const run = RPC && process.env.PHONE_E2E_BUNDLER_PORT ? test : test.skip;

const RELAY_KEY = "c7".repeat(32);
const RELAY = pubkeyOf(RELAY_KEY);
const FOUNDER_KEY = "a1".repeat(32);
const FOUNDER_NOSTR = pubkeyOf(FOUNDER_KEY);
const OWNERSHIP =
  "Buyers acquire ownership only: governance and exit. No dividends or revenue share, ever, unless they contribute and earn one.";
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
  "a phone with no wallet signs up with a passkey and backs a project from its passkey account",
  async ({ page }) => {
    test.setTimeout(180_000);
    const [admin, founder, , , , , , , stranger, stake] = await accounts();

    // The chain: the platform, a launched project with a round open, and the phone path's own contracts.
    const platform = await deployPlatform(admin, stake);
    const coordinate = `37001:${FOUNDER_NOSTR}:phone`;
    const p = await launched(platform, founder, coordinate);
    const opened = await walletOf(founder).sendCalls(
      [openBackingCall(platform.launcher, p.key)],
      31337,
    );
    const round = Number(await openedRound(opened.txHash, platform.launcher));
    const chain = await setUpPhoneChain(admin);
    const bundler = await startStandInBundler({
      rpcUrl: RPC,
      paymaster: chain.paymaster,
      submitter: chain.submitter,
      port: Number(process.env.PHONE_E2E_BUNDLER_PORT),
    });

    try {
      // The server's reading of that project, naming the real contracts.
      const at = now();
      const projectId = projectIdOf(coordinate);
      const key = chainKeyOf(founder, projectId);
      expect(key).toBe(p.key);
      const content = numbersContent({
        coordinate,
        now: at,
        backed: false,
        openRound: { openedAgo: 600 },
      });
      const numbers = {
        ...content,
        launcher: platform.launcher,
        key,
        projectId,
        founder,
        contracts: {
          shares: p.shares,
          treasury: p.treasury,
          vester: p.vester,
          finisher: p.finisher,
          rounds: p.rounds,
          pair: null,
        },
        treasury: {
          ...(content.treasury as object),
          runner: founder,
        },
        holders: [{ account: founder, held: "0", free: "0" }],
      };
      const relay = createMockRelay();
      relay.seed(profile(FOUNDER_NOSTR, "Fay Founder"));
      relay.seed(
        projectRecord(
          FOUNDER_NOSTR,
          "phone",
          "Lantern",
          "Solar lamps for night markets.",
          at - 50 * 86_400,
          [["chain-key", key]],
        ),
      );
      relay.seed(
        event(
          39009,
          RELAY,
          numbers,
          [
            ["d", key],
            ["chain", "31337"],
            ["launcher", platform.launcher],
          ],
          at,
        ),
      );
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
      await page.getByTestId("onboarding-name").fill("Mira Okafor", {
        timeout: 20_000,
      });
      await page.getByTestId("onboarding-passkey").click();
      await expect(page.getByTestId("backup-sheet")).toBeVisible({
        timeout: 20_000,
      });
      await page.keyboard.press("Escape");

      // The account the passkey makes is shown on You, with the one honest sentence about the passkey being its only key.
      await page.goto(`${ORIGIN}/you`);
      const words = page.getByTestId("sender-passkey-words");
      await expect(words).toContainText(
        "only key to the money in this account",
        {
          timeout: 20_000,
        },
      );
      const account = (
        await page.getByTestId("sender-address").textContent()
      )?.toLowerCase() as string;
      expect(account).toMatch(/^0x[0-9a-f]{40}$/);
      await mintDollars(stranger, platform.quote, account, 60n * DOLLAR);

      // Back: the same sheet as with a wallet, with the passkey asked once.
      await page.goto(`${ORIGIN}/p/phone-${FOUNDER_NOSTR.slice(0, 16)}`);
      await expect(page.getByTestId("back-box")).toBeVisible({
        timeout: 30_000,
      });
      const before = await prompts();
      const path = new PressCounter();
      await path.type(
        page.getByTestId("back-amount"),
        "25",
        "How many dollars?",
      );
      await path.press(page.getByTestId("back-review"), "Back");
      const sheet = page.getByTestId("back-sheet");
      await expect(sheet).toContainText("You get about 75,000 Shares");
      await expect(sheet.getByTestId("ownership")).toHaveText(OWNERSHIP);
      await path.read(page, "the Back sheet");
      await path.press(
        page.getByTestId("back-confirm"),
        "Back with 25 dollars",
      );
      await expect(page.getByTestId("toast")).toContainText("Backed", {
        timeout: 60_000,
      });
      console.log(path.summary("Back from a passkey account"));
      console.log(
        `passkey prompts for the Back: ${(await prompts()) - before}`,
      );

      // What changed on the chain: the round's record of the ask, one operation, the app's own calls.
      const position = await call(p.rounds, positionCallData(round, account));
      expect(BigInt(`0x${position.slice(2, 66)}`)).toBe(25n * DOLLAR);
      expect(
        await word(
          platform.quote,
          encodeFunctionData("balanceOf(address)", ["address"], [account]),
        ),
      ).toBe(35n * DOLLAR);
      const backs = bundler.sent.filter((s) => s.sender === account);
      expect(backs).toHaveLength(1);
      expect(decodeExecuteCallData(backs[0].op.callData)).toEqual(
        backCalls({
          quote: platform.quote,
          rounds: p.rounds,
          round,
          amount: 25n * DOLLAR,
        }),
      );
      expect((await prompts()) - before).toBe(1);
      expect(path.presses).toBeLessThanOrEqual(PLAN_V2_BUDGETS.back.presses);
      expect(path.fields).toBeLessThanOrEqual(PLAN_V2_BUDGETS.back.fields);
    } finally {
      await bundler.close();
    }
  },
);

/**
 * Regression journeys from the milestone 6 part 2 review: Back from a wallet on another network (F1), and a record that
 * copies another project's chain-key (F2). Each failed on 3c2f6ab37.
 */
import { expect, test } from "@playwright/test";
import { backCalls } from "../../src/features/money/calls";
import { BACKER_EVM, CONTRACTS } from "../helpers/numbers-fixture";
import { createMockRelay } from "./mock-relay";
import {
  chainKeyTag,
  RELAY,
  seedNumbers,
  sentCalls,
} from "./helpers/money-world";
import {
  coordOf,
  DAY,
  install,
  now,
  profile,
  projectLink,
  projectRecord,
  pubkeyOf,
} from "./helpers/world";

const FOUNDER = pubkeyOf("a1".repeat(32));
const SQUATTER = pubkeyOf("a3".repeat(32));
const READER_KEY = "a2".repeat(32);
const COORD = coordOf(FOUNDER, "lantern");

test("F1: Back works when the wallet starts on another network", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(profile(FOUNDER, "Fay Founder"));
  relay.seed(
    projectRecord(FOUNDER, "lantern", "Lantern", "Lamps.", now() - 50 * DAY, [
      chainKeyTag(COORD),
    ]),
  );
  seedNumbers(relay, { coordinate: COORD, openRound: { openedAgo: 3600 } });
  await install(page, relay, READER_KEY, { investing: true, relaySelf: RELAY });
  // A wallet on Ethereum mainnet (chain 1), where the project's Rounds has no code: eth_call answers "0x" until the
  // wallet is switched to the project's chain (31337), as a real wallet does.
  await page.addInitScript(
    ([account, quote]) => {
      const w = window as unknown as {
        ethereum: unknown;
        __sent: unknown[];
        __chain: string;
      };
      w.__sent = [];
      w.__chain = "0x1";
      w.ethereum = {
        async request({
          method,
          params,
        }: {
          method: string;
          params?: unknown[];
        }) {
          if (method === "eth_accounts" || method === "eth_requestAccounts")
            return [account];
          if (method === "eth_chainId") return w.__chain;
          if (method === "wallet_switchEthereumChain") {
            w.__chain = (params?.[0] as { chainId: string }).chainId;
            return null;
          }
          if (method === "eth_call")
            return w.__chain === "0x7a69"
              ? `0x${"0".repeat(24)}${quote.slice(2)}`
              : "0x";
          if (method === "eth_getTransactionReceipt") return { status: "0x1" };
          if (method === "eth_sendTransaction") {
            w.__sent.push(params?.[0]);
            return `0x${w.__sent.length.toString(16).padStart(64, "0")}`;
          }
          throw { code: 4200, message: `unsupported ${method}` };
        },
      };
    },
    [BACKER_EVM, CONTRACTS.quote] as const,
  );
  await page.goto(projectLink(FOUNDER, "lantern"));
  await page.getByTestId("back-amount").fill("25", { timeout: 20_000 });
  await page.getByTestId("back-review").click();
  await page.getByTestId("back-confirm").click();
  await expect(page.getByTestId("toast")).toContainText("Backed", {
    timeout: 10_000,
  });
  const sent = await sentCalls(page);
  expect(sent.map(({ to, data, value }) => ({ to, data, value }))).toEqual(
    backCalls({
      quote: CONTRACTS.quote,
      rounds: CONTRACTS.rounds,
      round: 2,
      amount: 25_000_000n,
    }),
  );
});

test("F2: a record copying another project's chain-key never shows that project's numbers", async ({
  page,
}) => {
  const relay = createMockRelay();
  relay.seed(profile(FOUNDER, "Fay Founder"));
  relay.seed(profile(SQUATTER, "Sam Squatter"));
  relay.seed(
    projectRecord(FOUNDER, "lantern", "Lantern", "Lamps.", now() - 50 * DAY, [
      chainKeyTag(COORD),
    ]),
  );
  // Someone else's record names Lantern's launch.
  relay.seed(
    projectRecord(
      SQUATTER,
      "lantern2",
      "Lantern Two",
      "Lamps too.",
      now() - DAY,
      [chainKeyTag(COORD)],
    ),
  );
  seedNumbers(relay, { coordinate: COORD, openRound: { openedAgo: 3600 } });
  await install(page, relay, READER_KEY, { investing: true, relaySelf: RELAY });
  await page.goto(projectLink(FOUNDER, "lantern"));
  await expect(page.getByTestId("back-box")).toBeVisible({ timeout: 20_000 });
  // Client-side navigation to the copying record (the query cache survives; a full reload would clear it).
  await page.evaluate(
    (path) => {
      history.pushState({}, "", path);
      dispatchEvent(new PopStateEvent("popstate"));
    },
    projectLink(SQUATTER, "lantern2"),
  );
  await expect(page.getByTestId("project-name")).toHaveText("Lantern Two", {
    timeout: 20_000,
  });
  await page.waitForTimeout(1_000);
  await expect(page.getByTestId("back-box")).toHaveCount(0);
});

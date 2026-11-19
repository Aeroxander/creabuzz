import type { Page } from "@playwright/test";
import { accountOf, linkedWalletRecord } from "../../helpers/linked-wallet";
import {
  BACKER_EVM,
  CONTRACTS,
  chainIdentity,
  FOUNDER_EVM,
  numbersContent,
} from "../../helpers/numbers-fixture";
import { addressWord, installChainWallet } from "./chain-wallet";
import { chainKeyTag, RELAY } from "./money-world";
import {
  coordOf,
  DAY,
  event,
  install,
  now,
  profile,
  projectLink,
  projectRecord,
  type Relay,
} from "./world";

/**
 * A project run first by its founder and then by a Pair (the founder and a teammate who linked anvil's third account),
 * for the Team and market journeys and their accessibility runs.
 */
export const FOUNDER_KEY = "a1".repeat(32);
export const MATE_KEY = "b7".repeat(32);
export const FOUNDER = accountOf(FOUNDER_KEY);
export const MATE = accountOf(MATE_KEY);
export const COORD = coordOf(FOUNDER, "lantern");
export const PROJECT = projectLink(FOUNDER, "lantern");
export const PAIR = "0x9a0000000000000000000000000000000000a1b2";
export const { key: KEY } = chainIdentity(COORD);

export function seedTeam(
  relay: Relay,
  stage: "backed" | "team" | "council",
  extra?: (content: Record<string, unknown>) => Record<string, unknown>,
) {
  relay.seed(profile(FOUNDER, "Fay Founder"));
  relay.seed(profile(MATE, "Sam Second"));
  relay.seed(
    projectRecord(
      FOUNDER,
      "lantern",
      "Lantern",
      "Solar lamps for night markets.",
      now() - 50 * DAY,
      [
        chainKeyTag(COORD),
        ["team", MATE, "member"],
        ["team-invite", MATE, "inv1"],
        ["p", MATE],
      ],
    ),
  );
  relay.seed(
    event(
      47003,
      MATE,
      { title: "Joined the team", body: "" },
      [
        ["a", COORD],
        ["l", "creaton-team"],
        ["team-answer", "yes"],
        ["team-invite", "inv1"],
      ],
      now() - 40 * DAY,
    ),
  );
  relay.seed(linkedWalletRecord(MATE_KEY, BACKER_EVM));
  relay.seed(linkedWalletRecord(FOUNDER_KEY, FOUNDER_EVM));
  const content = numbersContent({
    coordinate: COORD,
    now: now(),
    stage: stage === "council" ? "team" : stage,
    runner: stage === "backed" ? FOUNDER_EVM : PAIR,
  });
  if (extra) Object.assign(content, extra(content));
  content.contracts = {
    ...(content.contracts as Record<string, unknown>),
    pair: stage === "backed" ? null : PAIR,
  };
  relay.seed(
    event(
      39009,
      RELAY,
      content,
      [
        ["d", KEY],
        ["chain", "31337"],
        ["launcher", CONTRACTS.launcher],
      ],
      now(),
    ),
  );
}

export async function openTeam(
  page: Page,
  relay: Relay,
  key: string,
  wallet: Parameters<typeof installChainWallet>[1],
) {
  await install(page, relay, key, { investing: true, relaySelf: RELAY });
  await installChainWallet(page, wallet);
  await page.goto(PROJECT);
}

export const PAIR_READS = {
  "first()": `0x${addressWord(FOUNDER_EVM)}`,
  "second()": `0x${addressWord(BACKER_EVM)}`,
};

const AUCTION = "0xa11c000000000000000000000000000000000a11";
const FLOOR = 31_691_265_005_800n;

/** The one auction, running or settled with its pool open. */
export const withSale =
  (settled: boolean) => (content: Record<string, unknown>) => ({
    sale: {
      auction: AUCTION,
      minimum: "100000000000",
      startBlock: "1000",
      endBlock: "8200",
      floorPriceQ96: FLOOR.toString(),
      tickSpacingQ96: (FLOOR / 100n).toString(),
      openedAt: (content.asOf as { time: number }).time - 3600,
      ...(settled
        ? {
            settled: {
              raised: "120000000000",
              afterFee: "116400000000",
              toTreasury: "90000000000",
            },
            pool: {
              poolId: `0x${"22".repeat(32)}`,
              sqrtPriceX96: "1584563250285286751870879006720",
              poolDollars: "26400000000",
              poolShares: "66000000000000000000000000",
            },
          }
        : {}),
    },
    bids: [
      {
        auction: AUCTION,
        count: 5,
        amount: "120000000000",
        clearingPriceQ96: (FLOOR * 2n).toString(),
      },
    ],
  });

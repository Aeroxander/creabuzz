import { expect, test } from "@playwright/test";
import { encodeParameters } from "../../../packages/creaton-core/src/launchpad/evmAbi.ts";
import { DEFAULT_SHARES_PER_RAW_DOLLAR } from "../../src/features/money/calls";
import { PROPOSED_TOPIC } from "../../src/features/team/pair";
import {
  giveSharesData,
  handOverData,
  makePairCall,
  openRoundData,
  pairConfirmCall,
  pairProposeCall,
} from "../../src/features/team/team-calls";
import { BACKER_EVM, CONTRACTS, FOUNDER_EVM } from "../helpers/numbers-fixture";
import { PLAN_V2_BUDGETS, PressCounter } from "../helpers/press-counter";
import { addressWord, word } from "./helpers/chain-wallet";
import { sentCalls } from "./helpers/money-world";
import {
  FOUNDER_KEY,
  KEY,
  MATE_KEY,
  openTeam as open,
  PAIR,
  PAIR_READS,
  seedTeam as seed,
} from "./helpers/team-world";
import { createMockRelay } from "./mock-relay";

/**
 * Team in the app (plan v2, milestone 7), press-counted against section 6's budgets at 390x844: the founder adds a
 * second person and the second person accepts (2 and 0 each), a signer gives Shares through the Pair (4 and 0, the
 * People tab included), the other signer confirms in 1 press, and a round opens at Team in 1 press as a proposal. The
 * wallet is a stand-in that answers the chain's reads and records what it is asked to send; its own confirmations are
 * the wallet's, not presses in the app.
 */

test("the founder adds a second person in 2 presses and nothing typed", async ({
  page,
}) => {
  const relay = createMockRelay();
  seed(relay, "backed");
  await open(page, relay, FOUNDER_KEY, {
    account: FOUNDER_EVM,
    reads: {
      "pairAddress(bytes32,address,address)": `0x${addressWord(PAIR)}`,
    },
  });
  const path = new PressCounter();
  const offer = page.getByTestId("offer-seat");
  await expect(offer).toBeVisible({ timeout: 20_000 });
  await path.read(page, "Add a second person", page.getByTestId("second-seat"));
  await path.press(offer, "Make second signer");
  await expect(page.getByTestId("offer-seat-sheet")).toBeVisible();
  await path.read(page, "The sheet", page.getByTestId("offer-seat-sheet"));
  await path.press(
    page.getByTestId("offer-seat-sheet-confirm"),
    "Offer the second seat",
  );
  await expect(
    page.getByText("becomes the second signer when they accept"),
  ).toBeVisible();
  expect(await sentCalls(page)).toEqual([
    {
      from: FOUNDER_EVM,
      to: CONTRACTS.treasury,
      value: "0x0",
      data: handOverData(PAIR, false),
    },
  ]);
  const counts = path.counts();
  console.log(path.summary("Add a second person (founder)"));
  expect(counts.presses).toBeLessThanOrEqual(
    PLAN_V2_BUDGETS.addSecondPerson.presses,
  );
  expect(counts.fields).toBe(PLAN_V2_BUDGETS.addSecondPerson.fields);
});

test("the second person accepts in 2 presses and nothing typed", async ({
  page,
}) => {
  const relay = createMockRelay();
  seed(relay, "backed");
  await open(page, relay, MATE_KEY, {
    account: BACKER_EVM,
    reads: {
      "pendingRunner()": `0x${addressWord(PAIR)}`,
      "pairAddress(bytes32,address,address)": `0x${addressWord(PAIR)}`,
    },
  });
  const path = new PressCounter();
  const accept = page.getByTestId("seat-accept");
  await expect(accept).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("seat-offer")).toContainText(
    "Fay Founder asked you to run this project with them.",
  );
  await path.press(accept, "Accept second seat");
  await expect(page.getByTestId("seat-sheet")).toBeVisible();
  await page.waitForTimeout(400); // the sheet's spring-in, so its words are read at full opacity
  await path.read(page, "The sheet", page.getByTestId("seat-sheet"));
  await path.press(page.getByTestId("seat-sheet-confirm"), "Accept");
  await expect(page.getByText("You are the second signer.")).toBeVisible();
  expect(await sentCalls(page)).toEqual([
    {
      from: BACKER_EVM,
      to: CONTRACTS.launcher,
      value: "0x0",
      data: makePairCall(CONTRACTS.launcher, KEY, FOUNDER_EVM).data,
    },
  ]);
  console.log(path.summary("Add a second person (accepting)"));
  expect(path.presses).toBeLessThanOrEqual(
    PLAN_V2_BUDGETS.addSecondPerson.presses,
  );
  expect(path.fields).toBe(0);
});

test("a signer gives Shares through the Pair in 4 presses and nothing typed", async ({
  page,
}) => {
  const relay = createMockRelay();
  seed(relay, "team");
  await open(page, relay, FOUNDER_KEY, {
    account: FOUNDER_EVM,
    reads: PAIR_READS,
  });
  await expect(page.getByTestId("pair-card")).toBeVisible({ timeout: 20_000 });
  const path = new PressCounter();
  await path.press(page.getByTestId("tab-people"), "People");
  const give = page.getByTestId("give-shares");
  await expect(give).toBeVisible({ timeout: 20_000 });
  await path.press(give, "Give Shares");
  await path.press(page.getByTestId("give-choice-0"), "100,000 Shares");
  await path.read(page, "Review", page.getByTestId("give-sheet"));
  await expect(page.getByTestId("give-review")).toContainText(
    "released evenly over 365 days from the day a market opens",
  );
  await path.press(
    page.getByTestId("give-sheet-confirm"),
    "Ask your co-signer",
  );
  await expect(
    page.getByText("It happens when your co-signer confirms."),
  ).toBeVisible();
  expect(await sentCalls(page)).toEqual([
    {
      from: FOUNDER_EVM,
      to: PAIR,
      value: "0x0",
      data: pairProposeCall(
        PAIR,
        CONTRACTS.treasury,
        giveSharesData(BACKER_EVM, 100_000n * 10n ** 18n),
      ).data,
    },
  ]);
  console.log(path.summary("Give Shares (through the Pair)"));
  expect(path.presses).toBeLessThanOrEqual(PLAN_V2_BUDGETS.giveShares.presses);
  expect(path.fields).toBe(PLAN_V2_BUDGETS.giveShares.fields);
});

test("the other signer confirms a waiting call in 1 press, and a round opens at Team in 1", async ({
  page,
}) => {
  const relay = createMockRelay();
  seed(relay, "team");
  const gift = giveSharesData(BACKER_EVM, 100_000n * 10n ** 18n);
  await open(page, relay, MATE_KEY, {
    account: BACKER_EVM,
    reads: {
      ...PAIR_READS,
      "proposer(bytes32)": `0x${addressWord(FOUNDER_EVM)}`,
    },
    logs: [
      {
        address: PAIR,
        topics: [
          PROPOSED_TOPIC,
          `0x${word(77)}`,
          `0x${addressWord(FOUNDER_EVM)}`,
        ],
        data: encodeParameters(
          ["address", "bytes", "uint256"],
          [CONTRACTS.treasury, gift, 2n],
        ),
        blockNumber: "0x100",
      },
    ],
  });
  const waiting = page.getByTestId("pair-waiting-call");
  await expect(waiting).toContainText("Give 100,000 Shares to Sam Second", {
    timeout: 20_000,
  });
  const confirm = new PressCounter();
  await confirm.press(page.getByTestId("pair-confirm"), "Confirm");
  await expect(page.getByText("Confirmed. It ran.")).toBeVisible();
  const round = new PressCounter();
  await round.press(page.getByTestId("pair-open-round"), "Open backing");
  await expect(page.getByText("The round opens when")).toBeVisible();
  expect(await sentCalls(page)).toEqual([
    {
      from: BACKER_EVM,
      to: PAIR,
      value: "0x0",
      data: pairConfirmCall(PAIR, CONTRACTS.treasury, gift, 2n).data,
    },
    {
      from: BACKER_EVM,
      to: PAIR,
      value: "0x0",
      data: pairProposeCall(
        PAIR,
        CONTRACTS.launcher,
        openRoundData(KEY, DEFAULT_SHARES_PER_RAW_DOLLAR),
      ).data,
    },
  ]);
  expect(confirm.presses).toBe(1);
  expect(round.presses).toBeLessThanOrEqual(
    PLAN_V2_BUDGETS.openBacking.presses,
  );
  expect(round.fields).toBe(0);
});

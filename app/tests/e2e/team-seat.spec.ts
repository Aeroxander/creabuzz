import { expect, test } from "@playwright/test";
import { chainKeyFromTags } from "../../../packages/creaton-core/src/launchpad/project-chain.ts";
import {
  handOverData,
  launchCall,
  takeSeatCall,
  windDownData,
} from "../../src/features/team/team-calls";
import {
  BACKER_EVM,
  CONTRACTS,
  chainIdentity,
  FOUNDER_EVM,
} from "../helpers/numbers-fixture";
import { PressCounter } from "../helpers/press-counter";
import { addressWord, installChainWallet, word } from "./helpers/chain-wallet";
import { RELAY, sentCalls } from "./helpers/money-world";
import {
  FOUNDER,
  FOUNDER_KEY,
  KEY,
  MATE_KEY,
  openTeam as open,
  seedTeam as seed,
} from "./helpers/team-world";
import {
  coordOf,
  DAY,
  install,
  now,
  projectLink,
  projectRecord,
} from "./helpers/world";
import { createMockRelay } from "./mock-relay";

/**
 * The runner seat and the launch in the app (plan v2, milestone 7) at 390x844, press-counted: handing the seat over,
 * taking a seat that was offered, winding down, and putting a project on the network. The plan sets no budget for
 * these four, so each journey prints what it measured and holds it from growing. The wallet is a stand-in that answers
 * the chain's reads and records what it is asked to send.
 */

test("the runner hands the seat over from Money: the tab, Hand over, who, and one confirming press", async ({
  page,
}) => {
  const relay = createMockRelay();
  seed(relay, "backed");
  await open(page, relay, FOUNDER_KEY, { account: FOUNDER_EVM });
  const path = new PressCounter();
  await path.press(page.getByTestId("tab-money"), "Money");
  const handOver = page.getByTestId("hand-over");
  await expect(handOver).toBeVisible({ timeout: 20_000 });
  await path.press(handOver, "Hand over");
  const sheet = page.getByTestId("hand-over-sheet");
  await expect(sheet).toBeVisible();
  const confirm = page.getByTestId("hand-over-sheet-confirm");
  await expect(confirm).toBeDisabled();
  await path.tick(sheet.getByRole("radio", { name: "Sam Second" }), "who");
  await page.waitForTimeout(400); // the sheet's spring-in, so its words are read at full opacity
  await path.read(page, "The sheet", sheet);
  await path.press(confirm, "Offer the seat");
  await expect(
    page.getByText("Offered. They take the seat when they accept."),
  ).toBeVisible();
  expect(await sentCalls(page)).toEqual([
    {
      from: FOUNDER_EVM,
      to: CONTRACTS.treasury,
      value: "0x0",
      data: handOverData(BACKER_EVM, false),
    },
  ]);
  console.log(path.summary("Hand over the runner seat"));
  expect(path.presses).toBeLessThanOrEqual(4);
  expect(path.fields).toBe(0);
});

test("the person offered the seat takes it in 2 presses and nothing typed", async ({
  page,
}) => {
  const relay = createMockRelay();
  seed(relay, "backed");
  await open(page, relay, MATE_KEY, {
    account: BACKER_EVM,
    reads: { "pendingRunner()": `0x${addressWord(BACKER_EVM)}` },
  });
  const path = new PressCounter();
  const accept = page.getByTestId("seat-accept");
  await expect(accept).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("seat-offer")).toContainText(
    "You are offered the runner seat",
  );
  await path.press(accept, "Take the seat");
  await expect(page.getByTestId("seat-sheet")).toBeVisible();
  await page.waitForTimeout(400);
  await path.read(page, "The sheet", page.getByTestId("seat-sheet"));
  await path.press(page.getByTestId("seat-sheet-confirm"), "Take the seat");
  await expect(page.getByText("You run the project now.")).toBeVisible();
  expect(await sentCalls(page)).toEqual([
    {
      from: BACKER_EVM,
      to: CONTRACTS.treasury,
      value: "0x0",
      data: takeSeatCall(CONTRACTS.treasury).data,
    },
  ]);
  console.log(path.summary("Take the runner seat"));
  expect(path.presses).toBeLessThanOrEqual(2);
  expect(path.fields).toBe(0);
});

test("the runner winds down from Money in 3 presses, the last one after reading what it means", async ({
  page,
}) => {
  const relay = createMockRelay();
  seed(relay, "backed");
  await open(page, relay, FOUNDER_KEY, { account: FOUNDER_EVM });
  const path = new PressCounter();
  await path.press(page.getByTestId("tab-money"), "Money");
  const windDown = page.getByTestId("wind-down");
  await expect(windDown).toBeVisible({ timeout: 20_000 });
  await path.press(windDown, "Wind down");
  const sheet = page.getByTestId("wind-down-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("This cannot be undone.");
  await expect(sheet).toContainText(
    "Backers keep taking their unpaid money back",
  );
  expect(await sentCalls(page)).toEqual([]);
  await page.waitForTimeout(400);
  await path.read(page, "The sheet", sheet);
  await path.press(
    page.getByTestId("wind-down-sheet-confirm"),
    "Wind down for good",
  );
  await expect(page.getByText("The project wound down.")).toBeVisible();
  expect(await sentCalls(page)).toEqual([
    {
      from: FOUNDER_EVM,
      to: CONTRACTS.launcher,
      value: "0x0",
      data: windDownData(KEY),
    },
  ]);
  console.log(path.summary("Wind down"));
  expect(path.presses).toBeLessThanOrEqual(3);
  expect(path.fields).toBe(0);
});

test.describe("putting a project on the network", () => {
  const KILN = coordOf(FOUNDER, "kiln");
  const HASH = `0x${word(0xabcdefn)}`;
  const identity = chainIdentity(KILN, FOUNDER_EVM);
  const launch = launchCall({
    launcher: CONTRACTS.launcher,
    projectId: identity.projectId,
    name: "Kiln",
    symbol: "KILN",
    settingsHash: HASH,
  });
  const launched = `0x${addressWord(FOUNDER_EVM)}${addressWord(CONTRACTS.shares)}${word(0).repeat(5)}`;

  /** A second project of the founder's with no launch yet, beside one whose numbers name the Launcher. */
  async function openKiln(
    page: Parameters<typeof install>[0],
    relay: ReturnType<typeof createMockRelay>,
  ) {
    seed(relay, "backed");
    relay.seed(
      projectRecord(
        FOUNDER,
        "kiln",
        "Kiln",
        "A shared pottery kiln.",
        now() - 3 * DAY,
      ),
    );
    await install(page, relay, FOUNDER_KEY, {
      investing: true,
      relaySelf: RELAY,
    });
    await installChainWallet(page, {
      account: FOUNDER_EVM,
      reads: { "launchHash(bytes32)": HASH },
      afterSend: { "projectByKey(bytes32)": launched },
    });
    await page.goto(projectLink(FOUNDER, "kiln"));
  }

  const kilnRecords = (relay: ReturnType<typeof createMockRelay>) =>
    relay.events.filter(
      (e) =>
        e.kind === 37001 && e.tags.some((t) => t[0] === "d" && t[1] === "kiln"),
    );

  test("the founder launches in 2 presses (the tab and one more), and the page is tied to the launch", async ({
    page,
  }) => {
    const relay = createMockRelay();
    await openKiln(page, relay);
    const path = new PressCounter();
    await path.press(page.getByTestId("tab-money"), "Money");
    const press = page.getByTestId("launch-press");
    await expect(press).toBeVisible({ timeout: 20_000 });
    await expect(press).toHaveText("Put it on the network");
    await path.read(page, "The card", page.getByTestId("launch-project"));
    await path.press(press, "Put it on the network");
    await expect(page.getByText("Your project is on the network.")).toBeVisible(
      { timeout: 20_000 },
    );
    expect(await sentCalls(page)).toEqual([
      {
        from: FOUNDER_EVM,
        to: CONTRACTS.launcher,
        value: "0x0",
        data: launch.data,
      },
    ]);
    const records = kilnRecords(relay);
    expect(records.length).toBe(2);
    const newest = records[records.length - 1];
    expect(chainKeyFromTags(newest.tags)).toBe(identity.key);
    expect(newest.tags).toContainEqual(["name", "Kiln"]);
    expect(newest.content).toBe(records[0].content);
    // The page has its launch now: the card is gone.
    await expect(page.getByTestId("launch-project")).toHaveCount(0);
    console.log(path.summary("Put a project on the network"));
    expect(path.presses).toBeLessThanOrEqual(2);
    expect(path.fields).toBe(0);
  });

  test("a launch whose page could not be updated is finished with one more press, never launched twice", async ({
    page,
  }) => {
    let refusals = 1;
    const relay = createMockRelay({
      refuse: (event) => {
        if (event.kind !== 37001 || refusals === 0) return null;
        refusals -= 1;
        return "error: could not save the record";
      },
    });
    await openKiln(page, relay);
    await page.getByTestId("tab-money").click();
    const press = page.getByTestId("launch-press");
    await expect(press).toHaveText("Put it on the network", {
      timeout: 20_000,
    });
    await press.click();
    await expect(page.getByTestId("launch-problem")).toBeVisible({
      timeout: 20_000,
    });
    expect(kilnRecords(relay).length).toBe(1);
    await expect(press).toHaveText("Finish linking");
    await press.click();
    await expect(
      page.getByText("Your project is on the network."),
    ).toBeVisible();
    // One launch only: the second press wrote the record and sent nothing to the wallet.
    expect((await sentCalls(page)).length).toBe(1);
    const records = kilnRecords(relay);
    expect(chainKeyFromTags(records[records.length - 1].tags)).toBe(
      identity.key,
    );
  });
});

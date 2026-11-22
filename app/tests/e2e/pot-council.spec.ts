import { type Page, expect, test } from "@playwright/test";
import { encodeCall } from "../../../packages/creaton-core/src/pot/abi-codec.ts";
import { LAUNCHER_ABI } from "../../../packages/creaton-core/src/pot/abis.generated.ts";
import * as pot from "../../../packages/creaton-core/src/pot/pot-calls.ts";
import * as reads from "../../../packages/creaton-core/src/pot/pot-reads.ts";
import { call, send } from "../anvil/rpc";
import { potCode } from "../anvil/pot-chain";
import { expectAccessible } from "../helpers/a11y";
import { expectNoSidewaysScroll } from "../helpers/layout";
import { backFor, launchProject, NO_CHAIN_WHY } from "./helpers/live-chain";
import { FOUNDER_NOSTR, liveWorld, openMoney } from "./helpers/live-browser";

test.skip(NO_CHAIN_WHY !== null, NO_CHAIN_WHY ?? "");

/**
 * The vote card and the stand sheet in a real browser (COUNCIL-PLAN.md sections 6.2, 6.3, 6.8 and 6.9): the card in each
 * phase it has (names going forward, voting, the planned change while it waits, a result that changed nothing), the pause
 * card's opener, and the stand sheet in its three modes with its text and account limits, at the phone's size with axe and
 * at 360 x 640.
 *
 * The chain in this file has the holder pause bound, as a deployment with `HOLDER_PAUSE=1` does, and a backer parks Shares
 * in it. The vote keys are put into the server's record the way a deployment with `COUNCIL=1` would sign them: the server's
 * own reader tests those numbers (`record_council_tests.rs`), and this spec reads the screens that show them.
 */

const world = liveWorld();
const E18 = 1_000_000_000_000_000_000n;
const DAY = 86_400;
// The fixture values the unit tests share (`tests/helpers/council-v2-parse.ts`): that file reads the example with
// `__dirname`, which this loader does not give, so the same few contract-shaped values are restated here.
const ACCOUNTS = [
  "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
  "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
  "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65",
  "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc",
];
const LIST = [
  "0x976ea74026e726554db657fa54763abd0c3a0aa9",
  "0x14dc79964da2c08b23698b3d3cc7ca32193d9955",
  "0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f",
  "0xa0ee7a142d267c1f36714e4a8f75612f20a79720",
  "0xbcd4042de499d14e55001ccbb24a551f3b954096",
];
const HASH = `0x${"ab".repeat(32)}`;
/** The vote contract's own numbers (COUNCIL-PLAN.md 2.4): a one-day stand, a three-day vote, the 16.5-day wait. */
function ruleOf() {
  return {
    standSecs: DAY,
    voteSecs: 3 * DAY,
    waitSecs: 1_425_600,
    floorDivisor: 3,
    openDivisor: 20,
    standDivisor: 1000,
    cooldownSecs: 28 * DAY,
    seatsEverySecs: 182 * DAY,
    proposalTtlSecs: 14 * DAY,
    needed: 3,
    seats: 5,
    maxLists: 4,
    maxPeople: 12,
    minVote: E18.toString(),
  };
}
/** The four times of a ballot opened at `openedAt`, in the contract's own order. */
function timesFrom(openedAt: number) {
  const standEnd = openedAt + DAY;
  const voteEnd = standEnd + 3 * DAY;
  return { openedAt, standEnd, voteEnd, effectiveAt: voteEnd + 1_425_600 };
}
const read = (to: string, data: string) => call(to, data);

/** A choice of the ballot, in the record's shape. */
function option(input: {
  index: number;
  kind: "keep" | "list" | "person";
  members: string[];
  tally: bigint;
}) {
  const named = input.kind !== "keep";
  return {
    index: input.index,
    kind: input.kind,
    members: input.members,
    proposer: named ? (ACCOUNTS[0] as string) : null,
    recordHash: named ? HASH : null,
    tally: input.tally.toString(),
  };
}

type Phase = "standing" | "voting" | "waiting" | "ended" | "none" | "seats";

/** The ballot the record carries for a phase: the times, the tallies and the result the contracts would give. */
function ballotFor(phase: Phase, now: number, supply: bigint) {
  const floor = (supply + 2n) / 3n;
  const cast = (supply * 40n) / 100n;
  const keep = (supply * 30n) / 100n;
  const base = {
    id: 3,
    kind: "replace",
    supply: supply.toString(),
    floor: floor.toString(),
    carriedOutAt: null,
  };
  const list = (tally: bigint) =>
    option({ index: 1, kind: "list", members: LIST, tally });
  const keepRow = (tally: bigint) =>
    option({ index: 0, kind: "keep", members: [], tally });
  if (phase === "none") return null;
  if (phase === "seats")
    return {
      id: 3,
      kind: "seats",
      ...timesFrom(now - DAY / 2),
      supply: supply.toString(),
      floor: floor.toString(),
      cast: "0",
      options: [keepRow(0n)],
      result: null,
      carriedOutAt: null,
      phase: "standing",
    };
  if (phase === "standing")
    return {
      ...base,
      ...timesFrom(now - DAY / 2),
      cast: "0",
      options: [keepRow(0n), list(0n)],
      result: null,
      phase: "standing",
    };
  if (phase === "voting")
    return {
      ...base,
      ...timesFrom(now - 2 * DAY),
      cast: cast.toString(),
      options: [keepRow(keep), list(cast - keep)],
      result: null,
      phase: "voting",
    };
  if (phase === "waiting")
    return {
      ...base,
      ...timesFrom(now - 8 * DAY),
      cast: cast.toString(),
      options: [
        keepRow((supply * 10n) / 100n),
        list(cast - (supply * 10n) / 100n),
      ],
      result: { outcome: "moved", winners: [1], recorded: true },
      phase: "waiting",
    };
  return {
    ...base,
    ...timesFrom(now - 5 * DAY),
    cast: cast.toString(),
    options: [
      keepRow((supply * 34n) / 100n),
      list(cast - (supply * 34n) / 100n),
    ],
    result: { outcome: "kept", winners: [], recorded: true },
    phase: "ended",
  };
}

/**
 * The server's record with milestone 9's keys in it, as the reader signs them for a deployment with the vote contract. The
 * pause block is the step 4 shape the record parser checks, with the Shares the tallies stand on parked.
 */
function patchVote(
  content: Record<string, unknown>,
  phase: Phase,
  gate: string,
) {
  // biome-ignore lint/suspicious/noExplicitAny: the record is the loose JSON the server signs
  const c = content as any;
  const now = Number(c.asOf.time);
  const unit = Number(c.unit);
  const backers = BigInt(c.shares.backers);
  const divisor = 3n;
  c.contracts.pause = gate;
  c.pause = {
    contract: gate,
    parkedTotal: backers.toString(),
    line: ((backers + divisor - 1n) / divisor).toString(),
    dayLength: Math.floor(unit / 7),
    lineDivisor: 3,
    armedAt: null,
    pausesFrom: null,
    paused: false,
    since: null,
    parkerCount: 1,
  };
  c.vote = {
    contract: gate,
    rule: ruleOf(),
    open: ballotFor(phase, now, backers),
    next: {
      seatsAt: null,
      replaceFrom: now - DAY,
      // One in twenty of the backers' Shares, the rule's own floor for opening a replace vote.
      openFloor: (backers / 20n).toString(),
    },
  };
}

/** A project with the pause bound, a backer who parked their Shares, and the page on its Money tab. */
async function openCard(page: Page, phase: Phase, label: string) {
  const w = world.get();
  const project = await launchProject(w, label, FOUNDER_NOSTR);
  await backFor(w, project, w.who.backer, 100n);
  const gate = await reads.pauseGateOf(read, project.treasury);
  if (!gate) throw new Error("the project has no pause");
  const held = await reads.balanceOf(read, project.shares, w.who.backer);
  // Half parked: the record the server signs lists holders by what their wallet still holds, and the card's presses need
  // this account among them (a record lists a parked Share as its holder too; this test's record is built from the wallet).
  const parked = held - held / 2n;
  for (const call_ of pot.parkCalls({
    shares: project.shares,
    pause: gate,
    amount: parked,
  }))
    await send(w.who.backer, call_.to, call_.data);
  const opened = await openMoney(page, w, project, {
    account: w.who.backer,
    // The record lists this account among the holders: the card's presses are for the people who back the project.
    holders: [w.who.backer],
    patch: (content) => patchVote(content, phase, gate),
  });
  return { project, gate, wallet: opened.wallet };
}

test.beforeAll(async () => {
  const w = world.get();
  // The pause the deployment binds before any project is launched: a deployment with HOLDER_PAUSE=1 does this.
  const receipt = await send(w.who.admin, null, potCode("HolderPause"));
  const impl = receipt.contractAddress;
  if (!impl) throw new Error("HolderPause did not deploy");
  await send(
    w.who.admin,
    w.chain.launcher,
    encodeCall(LAUNCHER_ABI, "bindPause", [impl]),
  );
});

test("the card while names are put forward, and the stand sheet it opens for a list", async ({
  page,
}) => {
  const standing = await openCard(page, "standing", "cardstanding");
  const card = page.getByTestId("vote-card");
  await expect(card).toBeVisible();
  await expect(card.getByRole("heading")).toHaveText(
    "A vote on who runs this project",
  );
  await expect(page.getByTestId("vote-state-standing")).toContainText(
    "Voting starts then.",
  );
  const stand = page.getByTestId("vote-stand");
  await expect(stand).toHaveText("Put forward a list");
  await expect(page.getByTestId("vote-public")).toHaveText(
    "Posts and votes are public.",
  );
  await expect(page.getByTestId("vote-last")).toContainText(
    "Taking out stays open",
  );
  await expectAccessible(page, "the standing card");
  await page.screenshot({
    path: "test-results/pot-screens/vote-standing.png",
  });
  await stand.click();
  await expect(page.getByTestId("stand-sheet")).toBeVisible();
  await expect(
    page.getByLabel("Say in a few words who you are and what you would do"),
  ).toBeVisible();
  await expect(page.getByTestId("stand-promise")).toHaveText(
    "Do not promise anyone a profit or a return.",
  );
  await expect(page.getByTestId("stand-no-removal")).toHaveText(
    "You cannot take your name off once you stand.",
  );
  await expect(page.getByTestId("stand-public")).toHaveText(
    "Posts and votes are public.",
  );
  await expect(page.getByTestId("stand-banner")).toHaveText(
    "You can take your money out any time. Nothing here promises a profit.",
  );
  await expect(page.getByTestId("stand-confirm")).toBeDisabled();
  const words = "We would keep the marketplace open on Fridays.";
  await page.getByTestId("stand-text").fill(words);
  await expect(page.getByTestId("stand-count")).toHaveText(
    `${words.length} of 280 characters`,
  );
  // A paste of five accounts fills all five; the press then waits for nothing else.
  await page.evaluate((accounts) => {
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="stand-seat-1"]',
    );
    if (!input) throw new Error("no stand-seat-1");
    const data = new DataTransfer();
    data.setData("text/plain", accounts.join("\n"));
    input.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true }),
    );
  }, LIST as string[]);
  for (let i = 0; i < 5; i += 1)
    await expect(page.getByTestId(`stand-seat-${i + 1}`)).toHaveValue(
      LIST[i] as string,
    );
  await expect(page.getByTestId("stand-confirm")).toBeEnabled();
  await expectAccessible(page, "the stand sheet for a list");
  expect(standing.wallet.prompts).toBe(0);
  await page.screenshot({
    path: "test-results/pot-screens/stand-list-sheet.png",
  });
});

test("the card while voting: a row per choice, the count line from the rule, one distinct press each", async ({
  page,
}) => {
  const voting = await openCard(page, "voting", "cardvoting");
  const card = page.getByTestId("vote-card");
  await expect(card).toBeVisible();
  await expect(page.getByTestId("vote-state-voting")).toContainText(
    "Voting ends ",
  );
  const rows = page.locator('[data-testid^="vote-row-"]');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Keep things as they are");
  await expect(rows.nth(0)).toContainText("75%");
  await expect(rows.nth(1)).toContainText("List 1:");
  await expect(rows.nth(1)).toContainText("25%");
  // No signed text matches the chain's hash here, so the row says so.
  await expect(rows.nth(1)).toContainText("No text");
  await expect(rows.nth(1)).toContainText(
    "Nobody on a list has to agree to it.",
  );
  await expect(page.getByTestId("vote-count")).toHaveText(
    "40% of Shares have voted. The vote counts when at least 33% do, and a list wins with more than half of those.",
  );
  const presses = page.locator('[data-testid^="vote-press-"]');
  await expect(presses).toHaveCount(2);
  await expect(presses.nth(0)).toHaveAttribute(
    "aria-label",
    "Vote to keep things as they are",
  );
  await expect(presses.nth(1)).toHaveAttribute(
    "aria-label",
    /^Vote for List 1: 0x976e…/,
  );
  for (const press of await presses.all()) {
    const box = await press.boundingBox();
    expect(
      box?.height,
      "a press is at least 44 px tall",
    ).toBeGreaterThanOrEqual(44);
  }
  await expectAccessible(page, "the voting card");
  expect(voting.wallet.prompts).toBe(0);
  await page.screenshot({
    path: "test-results/pot-screens/vote-voting.png",
  });
});

test("the card after the vote: the planned change while it waits", async ({
  page,
}) => {
  await openCard(page, "waiting", "cardwaiting");
  const waiting = page.getByTestId("vote-state-waiting");
  await expect(waiting).toContainText(
    "Holders voted to change who runs this project.",
  );
  await expect(waiting).toContainText("take over from the founder.");
  await expect(waiting).toContainText("Taking out stays open.");
  await expect(page.locator('[data-testid^="vote-press-"]')).toHaveCount(0);
  await expectAccessible(page, "the card while the change waits");
  await page.screenshot({
    path: "test-results/pot-screens/vote-waiting.png",
  });
});

test("a result that changed nothing says so", async ({ page }) => {
  await openCard(page, "ended", "cardended");
  await expect(page.getByTestId("vote-state-ended")).toHaveText(
    "The vote ended. Nothing changes.",
  );
  await expectAccessible(page, "the card after a vote that changed nothing");
});

test("the pause card offers the opener only where it can open one, and the sheet's opening mode", async ({
  page,
}) => {
  await openCard(page, "none", "cardopener");
  await expect(page.getByTestId("pause-ask-line")).toHaveText(
    "Enough Shares are parked to ask holders who should run this project.",
  );
  await page.getByTestId("pause-ask-press").click();
  const sheet = page.getByTestId("stand-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("heading")).toHaveText("Open the vote");
  await expect(page.getByTestId("stand-opening")).toContainText(
    "This opens a vote. For the first one day anyone with parked Shares can put forward a list.",
  );
  await expect(page.getByTestId("stand-seat-1")).toBeVisible();
  await expect(page.getByTestId("stand-confirm")).toBeDisabled();
  await expectAccessible(page, "the stand sheet that opens a vote");
});

test("the stand sheet stands a person: one text, no list fields", async ({
  page,
}) => {
  await openCard(page, "seats", "cardseats");
  await page.getByTestId("vote-stand").click();
  const sheet = page.getByTestId("stand-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("heading")).toHaveText("Stand for a seat");
  await expect(page.getByTestId("stand-seat-1")).toHaveCount(0);
  await expect(page.getByTestId("stand-confirm")).toBeDisabled();
  await page.getByTestId("stand-text").fill("I would answer questions weekly.");
  await expect(page.getByTestId("stand-confirm")).toBeEnabled();
  await expectAccessible(page, "the stand sheet for a person");
});

test.describe("a 360 x 640 phone", () => {
  test.use({ viewport: { width: 360, height: 640 } });

  test("the voting card fits without scrolling sideways", async ({ page }) => {
    await openCard(page, "voting", "card360");
    await expect(page.getByTestId("vote-card")).toBeVisible();
    await expectNoSidewaysScroll(page, "the voting card at 360 x 640");
    await expectAccessible(page, "the voting card at 360 x 640");
    await page.screenshot({
      path: "test-results/pot-screens/vote-360.png",
    });
  });
});

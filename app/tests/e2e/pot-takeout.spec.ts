import { expect, type Page, test } from "@playwright/test";
import { encodeCall } from "../../../packages/creaton-core/src/pot/abi-codec.ts";
import { TREASURY_ABI } from "../../../packages/creaton-core/src/pot/abis.generated.ts";
import * as pot from "../../../packages/creaton-core/src/pot/pot-calls.ts";
import * as reads from "../../../packages/creaton-core/src/pot/pot-reads.ts";
import { call } from "../anvil/rpc";
import { walletOf } from "../anvil/pot-chain";
import { PLAN_V2_BUDGETS, PressCounter } from "../helpers/press-counter";
import {
  backFor,
  checkIn,
  giveDollars,
  type LiveProject,
  launchProject,
  NO_CHAIN_WHY,
  passTime,
} from "./helpers/live-chain";
import { FOUNDER_NOSTR, liveWorld, openMoney } from "./helpers/live-browser";

test.skip(NO_CHAIN_WHY !== null, NO_CHAIN_WHY ?? "");

/**
 * Take out from a browser whose wallet is a real account on a real local chain, in every state a project can be in: open,
 * the door closed by the team, quiet, dormant, open to a wind-down, wound down; with outside money still arriving; with no
 * Shares; and with the server's numbers unreadable. Each time the cash that lands is the chain's quote of a moment before,
 * within the guard the sheet sent (0.5%), and the Shares are gone.
 */

const world = liveWorld();
const read = (to: string, data: string) => call(to, data);
const UNIT = 1680;

/** Take out all of `who`'s Shares through the sheet; check what lands. Returns the counter and the wallet prompts. */
async function takeOutAll(
  page: Page,
  project: LiveProject,
  who: string,
  wallet: { prompts: number },
) {
  const heldBefore = await reads.balanceOf(read, project.shares, who);
  const quote = await reads.quoteTakeOut(
    read,
    project.treasury,
    who,
    heldBefore,
  );
  const dollarsBefore = await reads.balanceOf(read, project.dollar, who);
  const path = new PressCounter();
  await path.press(page.getByTestId("holding-take-out"), "Take out");
  const sheet = page.getByTestId("takeout-sheet");
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId("takeout-cash")).toContainText("dollars");
  await path.read(page, "the Take out sheet");
  const promptsBefore = wallet.prompts;
  await path.press(page.getByTestId("sheet-confirm"), "Take out");
  await expect(sheet).toBeHidden({ timeout: 30_000 });
  const cash =
    (await reads.balanceOf(read, project.dollar, who)) - dollarsBefore;
  expect(cash).toBeGreaterThan(0n);
  expect(cash).toBeGreaterThanOrEqual((quote.cashNow * 995n) / 1000n);
  expect(cash).toBeLessThanOrEqual((quote.cashNow * 1005n) / 1000n);
  expect(await reads.balanceOf(read, project.shares, who)).toBe(0n);
  expect(wallet.prompts - promptsBefore).toBe(1);
  return path;
}

test(`Take out: ${PLAN_V2_BUDGETS.takeMoneyBack.presses} presses from the page, one wallet prompt, the cash is the chain's quote`, async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "takeall", FOUNDER_NOSTR);
  await backFor(w, project, w.who.backer, 100n);
  await backFor(w, project, w.who.second, 60n);
  await checkIn(w, project);
  const { wallet } = await openMoney(page, w, project, {
    account: w.who.backer,
  });
  await expect(page.getByTestId("holding-shares")).toBeVisible();
  const path = await takeOutAll(page, project, w.who.backer, wallet);
  expect(path.presses).toBeLessThanOrEqual(
    PLAN_V2_BUDGETS.takeMoneyBack.presses,
  );
  expect(path.fields).toBe(0);
  // The second backer's Shares did not move, and the page now says this account holds none.
  expect(
    await reads.balanceOf(read, project.shares, w.who.second),
  ).toBeGreaterThan(0n);
  await expect(page.getByTestId("holding-none")).toBeVisible({
    timeout: 20_000,
  });
  console.log(
    `MEASURED Take out, wallet: ${path.presses} presses, ${path.fields} fields, 1 wallet prompt`,
  );
});

test("half and a quarter take out that part and keep the rest", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "portions", FOUNDER_NOSTR);
  await backFor(w, project, w.who.backer, 100n);
  await checkIn(w, project);
  const { wallet } = await openMoney(page, w, project, {
    account: w.who.backer,
  });
  const held = await reads.balanceOf(read, project.shares, w.who.backer);
  await page.getByTestId("holding-take-out").click();
  await page.getByTestId("takeout-portion-half").check();
  await expect(page.getByTestId("takeout-kept")).toContainText("Shares");
  await page.getByTestId("sheet-confirm").click();
  await expect(page.getByTestId("takeout-sheet")).toBeHidden({
    timeout: 30_000,
  });
  expect(await reads.balanceOf(read, project.shares, w.who.backer)).toBe(
    held - held / 2n,
  );
  await page.getByTestId("holding-take-out").click();
  await page.getByTestId("takeout-portion-quarter").check();
  const left = held - held / 2n;
  await expect(page.getByTestId("takeout-shares")).toBeVisible();
  await page.getByTestId("sheet-confirm").click();
  await expect(page.getByTestId("takeout-sheet")).toBeHidden({
    timeout: 30_000,
  });
  expect(await reads.balanceOf(read, project.shares, w.who.backer)).toBe(
    left - left / 4n,
  );
  expect(wallet.prompts).toBe(2);
});

interface State {
  name: string;
  /** Seconds the chain's clock moves forward after the last check-in. */
  jump: number;
  /** Done on the chain, after the clock moved, before the page opens. */
  setUp?: (project: LiveProject) => Promise<void>;
  /** What the page calls it. */
  label: string;
  /** What the Back box says instead of a form (null: it is open). */
  backWords: RegExp | null;
}

const STATES: State[] = [
  { name: "open", jump: 0, label: "Open", backWords: null },
  {
    name: "the door closed by the team",
    jump: 0,
    label: "Open",
    backWords: /closed the door to new backing/,
    setUp: async (p) => {
      await walletOf(world.get().who.founder).sendCalls(
        [pot.setDoorCall(p.treasury, false)],
        31337,
      );
    },
  },
  {
    name: "quiet",
    jump: 2 * UNIT + 120,
    label: "Quiet",
    backWords: /has not checked in since/,
  },
  {
    name: "dormant",
    jump: 13 * UNIT + 120,
    label: "Dormant",
    backWords: /has not checked in since/,
  },
  {
    name: "open to a wind-down",
    jump: 26 * UNIT + 120,
    label: "Can be wound down",
    backWords: /has not checked in since/,
  },
  {
    name: "wound down",
    jump: 26 * UNIT + 120,
    label: "Wound down",
    backWords: /has wound down/,
    setUp: async (p) => {
      await walletOf(world.get().who.stranger).sendCalls(
        [
          {
            to: p.treasury,
            data: encodeCall(TREASURY_ABI, "windDown", []),
            value: "0x0",
          },
        ],
        31337,
      );
    },
  },
];

for (const [index, state] of STATES.entries())
  test(`Take out works when the project is ${state.name}`, async ({ page }) => {
    const w = world.get();
    const project = await launchProject(w, `state${index}`, FOUNDER_NOSTR);
    await backFor(w, project, w.who.backer, 100n);
    await backFor(w, project, w.who.second, 50n);
    await checkIn(w, project);
    if (state.jump > 0) await passTime(state.jump);
    await state.setUp?.(project);
    const { wallet } = await openMoney(page, w, project, {
      account: w.who.backer,
    });
    await expect(page.getByTestId("money-state")).toHaveText(state.label);
    // Back says why it is not offered (or is offered); Take out is offered in every state.
    if (state.backWords) {
      await expect(page.getByTestId("back-door-shut")).toContainText(
        state.backWords,
      );
      await expect(page.getByTestId("backing-amount")).toHaveCount(0);
      await expect(page.getByTestId("back-door-shut")).toContainText(
        "You can still take your money out",
      );
    } else await expect(page.getByTestId("backing-amount")).toBeVisible();
    await takeOutAll(page, project, w.who.backer, wallet);
  });

test("outside money still arriving is said on the sheet and left for the people who stay", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "arriving", FOUNDER_NOSTR);
  await backFor(w, project, w.who.backer, 100n);
  await backFor(w, project, w.who.second, 100n);
  await checkIn(w, project);
  await giveDollars(w, w.who.stranger);
  await walletOf(w.who.stranger).sendCalls(
    pot.addRevenueCalls({
      dollar: project.dollar,
      treasury: project.treasury,
      amount: 60_000_000n,
    }),
    31337,
  );
  const { wallet } = await openMoney(page, w, project, {
    account: w.who.backer,
  });
  await page.getByTestId("holding-take-out").click();
  await expect(page.getByTestId("takeout-arriving")).toContainText(
    "still arriving",
  );
  await expect(page.getByTestId("takeout-arriving")).toContainText(
    "not paid out now",
  );
  await page.getByTestId("sheet-confirm").click();
  await expect(page.getByTestId("takeout-sheet")).toBeHidden({
    timeout: 30_000,
  });
  expect(wallet.prompts).toBe(1);
  expect(await reads.balanceOf(read, project.shares, w.who.backer)).toBe(0n);
});

test("a person with no Shares is offered no Take out and told why", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "noshares", FOUNDER_NOSTR);
  await backFor(w, project, w.who.second, 50n);
  const { wallet } = await openMoney(page, w, project, {
    account: w.who.stranger,
  });
  await expect(page.getByTestId("holding-none")).toBeVisible();
  await expect(page.getByTestId("holding-take-out")).toHaveCount(0);
  expect(wallet.prompts).toBe(0);
});

test("with the server's numbers unreadable, a holder still takes out, from the Launcher", async ({
  page,
}) => {
  const w = world.get();
  const project = await launchProject(w, "serverdown", FOUNDER_NOSTR);
  await backFor(w, project, w.who.backer, 80n);
  await checkIn(w, project);
  const { wallet } = await openMoney(page, w, project, {
    account: w.who.backer,
    numbersDown: true,
  });
  await expect(page.getByText("The numbers could not be read")).toBeVisible();
  await expect(page.getByTestId("play-money")).toHaveCount(0);
  await expect(page.getByTestId("chain-only-shares")).toBeVisible();
  await expect(page.getByTestId("holding-take-out")).toBeVisible({
    timeout: 20_000,
  });
  await takeOutAll(page, project, w.who.backer, wallet);
});

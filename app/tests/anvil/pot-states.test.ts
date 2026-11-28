// biome-ignore-all lint/style/noNonNullAssertion: each plan is asserted non-null on the line before it is used
/**
 * Take out stays open in every state of the door and of the project, on the real contracts, driven only through the app's
 * own call builders, readers and wallet: the door shut by the founder, the door shut because the team stopped checking in,
 * the project wound down by anyone after a long quiet, and a project wound down by its runner by choice. Each time the
 * backer's cash lands and is no less than the guard the sheet would have sent, a Back is refused in words, and the
 * contracts' own views (door, box, wind-down kind) say what the screens say. Run by `scripts/pot-app-loop.sh`; skipped without `M7_ANVIL_RPC`.
 */
import { describe, expect, it } from "vitest";
import {
  chainKeyOf,
  projectIdOf,
} from "../../../packages/creaton-core/src/launchpad/project-chain.ts";
import {
  decodeReturn,
  encodeCall,
} from "../../../packages/creaton-core/src/pot/abi-codec.ts";
import {
  LAUNCHER_ABI,
  TREASURY_ABI,
} from "../../../packages/creaton-core/src/pot/abis.generated.ts";
import * as pot from "../../../packages/creaton-core/src/pot/pot-calls.ts";
import {
  planBack,
  planTakeOut,
} from "../../../packages/creaton-core/src/pot/pot-plans.ts";
import * as reads from "../../../packages/creaton-core/src/pot/pot-reads.ts";
import { potProblem } from "../../src/features/money/problems";
import { WalletStepError } from "../../src/features/money/wallet";
import { deployPot, walletOf } from "./pot-chain";
import { accounts, call, passTime, RPC } from "./rpc";

const run = RPC ? describe : describe.skip;
const DOLLAR = 1_000_000n;
const SHARE = 10n ** 18n;
const CHAIN = 31337;
const read = (to: string, data: string) => call(to, data);

async function view(
  abi: typeof TREASURY_ABI | typeof LAUNCHER_ABI,
  to: string,
  name: string,
  args: (bigint | string)[] = [],
) {
  return decodeReturn(
    abi,
    name,
    await read(to, encodeCall(abi, name, args)),
    args.length,
  );
}

/** What a step that was refused said, in the app's own words. */
async function stoppedWith(
  promise: Promise<unknown>,
  action: Parameters<typeof potProblem>[1],
) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(WalletStepError);
  return potProblem(error, action);
}

/** Launch a project from `founder` and give back its contracts. */
async function launchProject(
  chain: Awaited<ReturnType<typeof deployPot>>,
  founder: string,
  label: string,
) {
  const wallet = walletOf(founder);
  const [settingsHash] = await view(
    LAUNCHER_ABI,
    chain.launcher,
    "settingsHash",
  );
  const projectId = projectIdOf(`37001:${"ee".repeat(32)}:${label}`);
  await wallet.sendCalls(
    [
      pot.launchCall({
        launcher: chain.launcher,
        projectId,
        name: label,
        symbol: label.slice(0, 4).toUpperCase(),
        ratePpm: 1000,
        teamPool: 10_000_000n * SHARE,
        settingsHash: settingsHash as string,
      }),
    ],
    CHAIN,
  );
  const key = chainKeyOf(founder, projectId);
  const [project] = (await view(LAUNCHER_ABI, chain.launcher, "projectByKey", [
    key,
  ])) as [string[]];
  return {
    key,
    shares: (project[1] as string).toLowerCase(),
    treasury: (project[3] as string).toLowerCase(),
  };
}

/**
 * Back with the app's own plan and check the Shares that landed are the quote. The quote is read at one second and the press is
 * mined a second or so later, and the price moves with the clock once outside money is arriving, so the Shares may sit a hair
 * off the quote, within one part in 1,000, and never below the call's own minimum.
 */
async function back(
  chain: Awaited<ReturnType<typeof deployPot>>,
  project: { shares: string; treasury: string },
  who: string,
  dollars: bigint,
) {
  const before = await reads.balanceOf(read, project.shares, who);
  const plan = await planBack(read, {
    dollar: chain.dollar,
    treasury: project.treasury,
    amount: dollars,
  });
  expect(plan).not.toBeNull();
  await walletOf(who).sendCalls(plan!.calls, CHAIN);
  const got = (await reads.balanceOf(read, project.shares, who)) - before;
  expect(got).toBeGreaterThanOrEqual(plan!.minShares);
  expect(got).toBeGreaterThanOrEqual(
    plan!.quote.shares - plan!.quote.shares / 1000n,
  );
  expect(got).toBeLessThanOrEqual(
    plan!.quote.shares + plan!.quote.shares / 1000n,
  );
  return got;
}

/** Take out `shares` and check the cash is what the contract's own quote said, no less than the guard. */
async function takeOut(
  chain: Awaited<ReturnType<typeof deployPot>>,
  project: { shares: string; treasury: string },
  who: string,
  shares: bigint,
) {
  const plan = await planTakeOut(read, {
    treasury: project.treasury,
    holder: who,
    shares,
    to: who,
  });
  expect(plan, "the chain quoted something to pay").not.toBeNull();
  const heldBefore = await reads.balanceOf(read, project.shares, who);
  const before = await reads.balanceOf(read, chain.dollar, who);
  await walletOf(who).sendCalls([plan!.call], CHAIN);
  const cash = (await reads.balanceOf(read, chain.dollar, who)) - before;
  expect(cash).toBeGreaterThanOrEqual(plan!.minCash);
  // The chain paid what it quoted. The quote is read at one second and the press is mined a second or so later, and outside
  // money that is still arriving moves with the clock, so the cash may sit a hair off the quote: within one part in 1,000,
  // and (above) never below the call's own minimum.
  expect(cash).toBeGreaterThanOrEqual(
    plan!.quote.cashNow - plan!.quote.cashNow / 1000n,
  );
  expect(cash).toBeLessThanOrEqual(
    plan!.quote.cashNow + plan!.quote.cashNow / 1000n,
  );
  expect(await reads.balanceOf(read, project.shares, who)).toBe(
    heldBefore - shares,
  );
  return cash;
}

run("Take out in every state, on the real contracts", () => {
  it("pays whatever the door, the quiet or the wind-down says", async () => {
    const [admin, founder, b1, b2, b3, stranger] = await accounts();
    const chain = await deployPot(admin);
    for (const who of [founder, b1, b2, b3, stranger])
      await walletOf(who).sendCalls([pot.faucetCall(chain.dollar)], CHAIN);
    const project = await launchProject(chain, founder, "states");
    const tr = project.treasury;
    const founderWallet = walletOf(founder);

    // Three backers; the Shares each got are what the quote said.
    await back(chain, project, b1, 100n * DOLLAR);
    await back(chain, project, b2, 60n * DOLLAR);
    await back(chain, project, b3, 40n * DOLLAR);
    await founderWallet.sendCalls(
      [pot.checkInCall(tr, `0x${"11".repeat(32)}`)],
      CHAIN,
    );
    expect(await reads.doorOpenNow(read, tr)).toBe(true);

    // 1. The founder shuts the door. A Back is refused in words; a take-out is not affected.
    await founderWallet.sendCalls([pot.setDoorCall(tr, false)], CHAIN);
    expect(await reads.doorOpenNow(read, tr)).toBe(false);
    const planWhileShut = await planBack(read, {
      dollar: chain.dollar,
      treasury: tr,
      amount: 10n * DOLLAR,
    });
    expect(
      await stoppedWith(
        walletOf(stranger).sendCalls(planWhileShut!.calls, CHAIN),
        "back",
      ),
    ).toMatch(/not taking new backers/);
    await takeOut(
      chain,
      project,
      b1,
      (await reads.balanceOf(read, project.shares, b1)) / 4n,
    );
    await founderWallet.sendCalls([pot.setDoorCall(tr, true)], CHAIN);
    expect(await reads.doorOpenNow(read, tr)).toBe(true);

    // 2. The team stops checking in: after two time units the door shuts by itself (the switch is still on). Taking out
    // works; a check-in opens the door again.
    await passTime(chain.unit * 2 + 60);
    expect((await view(TREASURY_ABI, tr, "doorFlag"))[0]).toBe(true);
    expect(await reads.doorOpenNow(read, tr)).toBe(false);
    await takeOut(
      chain,
      project,
      b2,
      (await reads.balanceOf(read, project.shares, b2)) / 2n,
    );
    await founderWallet.sendCalls(
      [pot.checkInCall(tr, `0x${"22".repeat(32)}`)],
      CHAIN,
    );
    expect(await reads.doorOpenNow(read, tr)).toBe(true);

    // 3. Outside money arrives: a take-out is not paid on what is still arriving (the quote says how much it leaves).
    await walletOf(stranger).sendCalls(
      pot.addRevenueCalls({
        dollar: chain.dollar,
        treasury: tr,
        amount: 30n * DOLLAR,
      }),
      CHAIN,
    );
    const heldB3 = await reads.balanceOf(read, project.shares, b3);
    const quoteNow = await reads.quoteTakeOut(read, tr, b3, heldB3 / 2n);
    expect(quoteNow.arrivingLeftBehind).toBeGreaterThan(0n);
    await takeOut(chain, project, b3, heldB3 / 2n);

    // 4. A long quiet: 26 time units with no check-in. Anyone may wind the project down; the box goes back to the pot, the
    // door is shut for good, and a second wind-down is refused in words.
    await passTime(chain.unit * 26 + 60);
    expect((await view(TREASURY_ABI, tr, "windDownKind"))[0]).toBe(0n);
    await walletOf(stranger).sendCalls(
      [
        {
          to: tr,
          data: encodeCall(TREASURY_ABI, "windDown", []),
          value: "0x0" as const,
        },
      ],
      CHAIN,
    );
    expect((await view(TREASURY_ABI, tr, "windDownKind"))[0]).toBe(2n);
    expect((await view(TREASURY_ABI, tr, "box"))[0]).toBe(0n);
    expect((await view(TREASURY_ABI, tr, "activeEnd"))[0]).toBe(0n);
    expect(await reads.doorOpenNow(read, tr)).toBe(false);
    expect(
      await stoppedWith(
        walletOf(stranger).sendCalls(
          [
            {
              to: tr,
              data: encodeCall(TREASURY_ABI, "windDown", []),
              value: "0x0" as const,
            },
          ],
          CHAIN,
        ),
        "check-in",
      ),
    ).toMatch(/wound down/);
    const planAfter = await planBack(read, {
      dollar: chain.dollar,
      treasury: tr,
      amount: 10n * DOLLAR,
    });
    expect(
      await stoppedWith(
        walletOf(stranger).sendCalls(planAfter!.calls, CHAIN),
        "back",
      ),
    ).toMatch(/wound down|not taking new backers/);
    // The check-in of a wound-down project is refused too; the person who runs it is told in words.
    await expect(
      founderWallet.sendCalls(
        [pot.checkInCall(tr, `0x${"33".repeat(32)}`)],
        CHAIN,
      ),
    ).rejects.toBeInstanceOf(WalletStepError);

    // 5. After the wind-down every backer still takes out everything they hold, and is paid the chain's quote.
    for (const who of [b1, b2, b3]) {
      const held = await reads.balanceOf(read, project.shares, who);
      if (held > 0n) await takeOut(chain, project, who, held);
      expect(await reads.balanceOf(read, project.shares, who)).toBe(0n);
    }
  });

  it("winds a project down by choice (the runner) and the backers still take out", async () => {
    const [admin, founder, b1, b2] = await accounts();
    const chain = await deployPot(admin);
    for (const who of [founder, b1, b2])
      await walletOf(who).sendCalls([pot.faucetCall(chain.dollar)], CHAIN);
    const project = await launchProject(chain, founder, "chosen");
    await back(chain, project, b1, 80n * DOLLAR);
    await back(chain, project, b2, 20n * DOLLAR);
    // Not the runner: refused in words (the Launcher checks who asks).
    expect(
      await stoppedWith(
        walletOf(b1).sendCalls(
          [pot.windDownCall(chain.launcher, project.key)],
          CHAIN,
        ),
        "check-in",
      ),
    ).toMatch(/\S/);
    await walletOf(founder).sendCalls(
      [pot.windDownCall(chain.launcher, project.key)],
      CHAIN,
    );
    expect(
      (await view(TREASURY_ABI, project.treasury, "windDownKind"))[0],
    ).toBe(1n);
    expect(await reads.doorOpenNow(read, project.treasury)).toBe(false);
    // The money is out to the Shares that remain: one leaves fully, the other in two parts.
    const held1 = await reads.balanceOf(read, project.shares, b1);
    await takeOut(chain, project, b1, held1);
    const held2 = await reads.balanceOf(read, project.shares, b2);
    await takeOut(chain, project, b2, held2 / 2n);
    await takeOut(chain, project, b2, held2 - held2 / 2n);
    expect(await reads.balanceOf(read, project.shares, b2)).toBe(0n);
  });
});

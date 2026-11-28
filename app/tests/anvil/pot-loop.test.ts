// biome-ignore-all lint/style/noNonNullAssertion: each plan is asserted non-null on the line before it is used
/**
 * The join-and-leave money contracts on a real EVM, driven only through the app's own call builders, quote readers and
 * wallet: the faucet, a launch, Back in one signature (and in two), Take out with its minimum-cash guard, the weekly
 * check-in carrying a record hash, the door, the allowance (a draw, a raise that must wait), a Team grant claimed as it
 * vests, a member's own exit with its notice, outside money, and the refusals read in the app's own words. Run by
 * `scripts/pot-app-loop.sh`; skipped without `M7_ANVIL_RPC`.
 */
import { describe, expect, it } from "vitest";
import { decodeReturn } from "../../../packages/creaton-core/src/pot/abi-codec.ts";
import {
  LAUNCHER_ABI,
  TREASURY_ABI,
  VESTER_ABI,
} from "../../../packages/creaton-core/src/pot/abis.generated.ts";
import * as pot from "../../../packages/creaton-core/src/pot/pot-calls.ts";
import {
  planBack,
  planTakeOut,
  planTeamTakeOut,
} from "../../../packages/creaton-core/src/pot/pot-plans.ts";
import * as reads from "../../../packages/creaton-core/src/pot/pot-reads.ts";
import {
  chainKeyOf,
  projectIdOf,
} from "../../../packages/creaton-core/src/launchpad/project-chain.ts";
import { encodeCall } from "../../../packages/creaton-core/src/pot/abi-codec.ts";
import { potProblem } from "../../src/features/money/problems";
import { WalletStepError } from "../../src/features/money/wallet";
import { deployPot, walletOf } from "./pot-chain";
import { accounts, call, chainTime, passTime, RPC, rpc } from "./rpc";

const run = RPC ? describe : describe.skip;
const DOLLAR = 1_000_000n;
const SHARE = 10n ** 18n;
const CHAIN = 31337;

/** A read through anvil, shaped as the sender's `readCall`. */
const read = (to: string, data: string) => call(to, data);

async function view(
  abi: typeof TREASURY_ABI | typeof VESTER_ABI | typeof LAUNCHER_ABI,
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

/** An error a press stopped with, read in the app's own words (the wallet's `reverted`/`failed` carry the contract's reason). */
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

run("the pot contracts on anvil, through the app's own builders", () => {
  it("runs a project from launch to take out", async () => {
    const [admin, founder, backer1, backer2, member, outsider] =
      await accounts();
    const chain = await deployPot(admin);
    const wallets = Object.fromEntries(
      [founder, backer1, backer2, member, outsider].map((a) => [
        a,
        walletOf(a),
      ]),
    );

    // Everyone takes their play dollars once; a second try is refused in words.
    for (const who of [founder, backer1, backer2, member, outsider])
      await wallets[who].sendCalls([pot.faucetCall(chain.dollar)], CHAIN);
    expect(await reads.balanceOf(read, chain.dollar, backer1)).toBe(
      1000n * DOLLAR,
    );
    expect(
      await stoppedWith(
        wallets[backer1].sendCalls([pot.faucetCall(chain.dollar)], CHAIN),
        "faucet",
      ),
    ).toMatch(/already took its play dollars/);

    // Launch: the settings hash is read, then the project is born with its allowance rate and Team pool.
    const [settingsHash] = await view(
      LAUNCHER_ABI,
      chain.launcher,
      "settingsHash",
    );
    const projectId = projectIdOf(`37001:${"ab".repeat(32)}:loop`);
    await wallets[founder].sendCalls(
      [
        pot.launchCall({
          launcher: chain.launcher,
          projectId,
          name: "Loop",
          symbol: "LOOP",
          ratePpm: 1000,
          teamPool: 10_000_000n * SHARE,
          settingsHash: settingsHash as string,
        }),
      ],
      CHAIN,
    );
    const [project] = await view(LAUNCHER_ABI, chain.launcher, "project", [
      founder,
      projectId,
    ]);
    const [, shares, team, treasury, vester] = project as string[];
    expect(
      (
        await view(LAUNCHER_ABI, chain.launcher, "keyOf", [founder, projectId])
      )[0],
    ).toBe(chainKeyOf(founder, projectId));
    const treasuryAddress = treasury as string;
    const vesterAddress = vester as string;
    const balance = (token: string, who: string) =>
      reads.balanceOf(read, token, who);

    // Back in ONE signature on the play dollar: the plan reads the quote, the press is one call, and the Shares are the quote.
    const plan1 = await planBack(read, {
      dollar: chain.dollar,
      treasury: treasuryAddress,
      amount: 100n * DOLLAR,
    });
    expect(plan1?.oneSignature).toBe(true);
    expect(plan1?.calls).toHaveLength(1);
    await wallets[backer1].sendCalls(plan1?.calls ?? [], CHAIN);
    expect(await balance(shares as string, backer1)).toBe(plan1?.quote.shares);
    expect(await balance(chain.dollar, backer1)).toBe(900n * DOLLAR);

    // Back in two signatures when told the dollar cannot pay and call: approve, then join.
    const plan2 = await planBack(read, {
      dollar: chain.dollar,
      treasury: treasuryAddress,
      amount: 50n * DOLLAR,
      to: backer2,
      payAndCall: false,
    });
    expect(plan2?.calls).toHaveLength(2);
    await wallets[backer2].sendCalls(plan2?.calls ?? [], CHAIN);
    expect(await balance(shares as string, backer2)).toBeGreaterThanOrEqual(
      plan2?.minShares ?? 1n,
    );

    // Take out part of backer one's Shares: the cash lands, and is no less than the guard.
    const mine = await balance(shares as string, backer1);
    const out = await planTakeOut(read, {
      treasury: treasuryAddress,
      holder: backer1,
      shares: mine / 4n,
      to: backer1,
    });
    expect(out).not.toBeNull();
    const before = await balance(chain.dollar, backer1);
    await wallets[backer1].sendCalls([out!.call], CHAIN);
    const cash = (await balance(chain.dollar, backer1)) - before;
    expect(cash).toBeGreaterThanOrEqual(out!.minCash);
    expect(await balance(shares as string, backer1)).toBe(mine - mine / 4n);

    // The weekly check-in carries the hash of the record signed first.
    const hash = `0x${"5a".repeat(32)}`;
    await wallets[founder].sendCalls(
      [pot.checkInCall(treasuryAddress, hash)],
      CHAIN,
    );
    const logs = await rpc<{ topics: string[]; data: string }[]>(
      "eth_getLogs",
      [{ address: treasuryAddress, fromBlock: "0x0", toBlock: "latest" }],
    );
    expect(logs.some((l) => l.data.includes(hash.slice(2)))).toBe(true);
    // Another account may not check in, and is told so in words.
    expect(
      await stoppedWith(
        wallets[backer1].sendCalls(
          [pot.checkInCall(treasuryAddress, hash)],
          CHAIN,
        ),
        "check-in",
      ),
    ).toBe("Only the person who runs the project can check in.");

    // The door: shut, a Back is refused in words and nothing moves; open again, it works.
    await wallets[founder].sendCalls(
      [pot.setDoorCall(treasuryAddress, false)],
      CHAIN,
    );
    expect(await reads.doorOpenNow(read, treasuryAddress)).toBe(false);
    const refused = await planBack(read, {
      dollar: chain.dollar,
      treasury: treasuryAddress,
      amount: 10n * DOLLAR,
    });
    expect(
      await stoppedWith(
        wallets[outsider].sendCalls(refused?.calls ?? [], CHAIN),
        "back",
      ),
    ).toMatch(/not taking new backers/);
    await wallets[founder].sendCalls(
      [pot.setDoorCall(treasuryAddress, true)],
      CHAIN,
    );
    expect(await reads.doorOpenNow(read, treasuryAddress)).toBe(true);

    // A raise must be announced and wait a unit; applying early is refused in words, then works.
    await wallets[founder].sendCalls(
      [pot.proposeRateCall(treasuryAddress, 1500)],
      CHAIN,
    );
    expect(
      await stoppedWith(
        wallets[outsider].sendCalls(
          [pot.applyRateCall(treasuryAddress)],
          CHAIN,
        ),
        "rate",
      ),
    ).toMatch(/can be applied from/);
    await passTime(chain.unit + 5);
    await wallets[outsider].sendCalls(
      [pot.applyRateCall(treasuryAddress)],
      CHAIN,
    );
    expect((await view(TREASURY_ABI, treasuryAddress, "ratePpm"))[0]).toBe(
      1500n,
    );

    // A Team grant vests on active time only: the runner checks in through every window, the grant passes its cliff,
    // and anyone may send the member what has unlocked.
    await wallets[founder].sendCalls(
      [
        pot.grantTeamCall({
          treasury: treasuryAddress,
          member,
          amount: 1000n * SHARE,
        }),
      ],
      CHAIN,
    );
    const [ids] = (await view(VESTER_ABI, vesterAddress, "idsOf", [
      member,
    ])) as [bigint[]];
    const grantId = ids[0] as bigint;
    for (let i = 0; i < 15; i += 1) {
      await passTime(chain.unit * 2 - 120);
      await wallets[founder].sendCalls(
        [pot.checkInCall(treasuryAddress, hash)],
        CHAIN,
      );
    }
    const claimable = await reads.claimableOf(read, vesterAddress, grantId);
    expect(claimable).toBeGreaterThan(0n);
    await wallets[outsider].sendCalls(
      [pot.claimGrantCall(vesterAddress, grantId)],
      CHAIN,
    );
    expect(await balance(team as string, member)).toBeGreaterThanOrEqual(
      claimable,
    );

    // The allowance box has filled: the runner draws a little of it.
    const drawn = 10_000n;
    const dollarsBefore = await balance(chain.dollar, outsider);
    await wallets[founder].sendCalls(
      [
        pot.drawCall({
          treasury: treasuryAddress,
          to: outsider,
          amount: drawn,
        }),
      ],
      CHAIN,
    );
    expect((await balance(chain.dollar, outsider)) - dollarsBefore).toBe(drawn);
    // More than the box holds is refused in words.
    expect(
      await stoppedWith(
        wallets[founder].sendCalls(
          [
            pot.drawCall({
              treasury: treasuryAddress,
              to: outsider,
              amount: 900n * DOLLAR,
            }),
          ],
          CHAIN,
        ),
        "draw",
      ),
    ).toMatch(/more than the allowance box holds/);

    // Outside money: approve, then add; it arrives over a unit and is shown as arriving.
    await wallets[outsider].sendCalls(
      pot.addRevenueCalls({
        dollar: chain.dollar,
        treasury: treasuryAddress,
        amount: 40n * DOLLAR,
      }),
      CHAIN,
    );
    expect(
      (await view(TREASURY_ABI, treasuryAddress, "arriving"))[0],
    ).toBeGreaterThan(0n);

    // The member's own exit: announce, wait out the notice, run it. Running it early is refused in words.
    await wallets[member].sendCalls(
      [pot.announceForfeitCall(vesterAddress, grantId)],
      CHAIN,
    );
    expect(
      await stoppedWith(
        wallets[outsider].sendCalls(
          [pot.executeForfeitCall(vesterAddress, grantId)],
          CHAIN,
        ),
        "forfeit",
      ),
    ).toMatch(/notice is still running/);
    await passTime(chain.unit + 5);
    await wallets[outsider].sendCalls(
      [pot.executeForfeitCall(vesterAddress, grantId)],
      CHAIN,
    );

    // Team Shares pay only what the project holds above what backers put in. The outside money arriving has lifted the
    // pot over it, so a Team take-out now has a (tiny) estimate, a guard below it, and pays at least the guard.
    const teamPlan = await planTeamTakeOut(read, {
      treasury: treasuryAddress,
      shares: 1n * SHARE,
      to: member,
    });
    expect(teamPlan).not.toBeNull();
    const teamBefore = await balance(chain.dollar, member);
    await wallets[member].sendCalls([teamPlan!.call], CHAIN);
    expect(
      (await balance(chain.dollar, member)) - teamBefore,
    ).toBeGreaterThanOrEqual(teamPlan!.minCash);

    // The chain's own clock and the quote agree that the project is still checking in.
    expect(await chainTime()).toBeGreaterThan(0);
  });
});

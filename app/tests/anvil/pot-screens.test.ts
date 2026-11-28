// biome-ignore-all lint/style/noNonNullAssertion: each plan is asserted non-null on the line before it is used
/**
 * What the money screens read and send, against the real contracts on a local chain: the Back sheet's reader and its
 * plan, the Take out sheet's reader, the allowance state, a grant and what a member keeps on their own exit, a project's
 * parts from the Launcher. Run by `scripts/pot-app-loop.sh`; skipped without `M7_ANVIL_RPC`.
 */
import { describe, expect, it } from "vitest";
import {
  decodeReturn,
  encodeCall,
} from "../../../packages/creaton-core/src/pot/abi-codec.ts";
import {
  LAUNCHER_ABI,
  TREASURY_ABI,
  type VESTER_ABI,
} from "../../../packages/creaton-core/src/pot/abis.generated.ts";
import * as pot from "../../../packages/creaton-core/src/pot/pot-calls.ts";
import * as reads from "../../../packages/creaton-core/src/pot/pot-reads.ts";
import * as state from "../../../packages/creaton-core/src/pot/pot-state.ts";
import {
  chainKeyOf,
  projectIdOf,
} from "../../../packages/creaton-core/src/launchpad/project-chain.ts";
import { readBack } from "../../src/features/pot/back-read";
import { readTakeOut } from "../../src/features/pot/takeout-read";
import type { ProjectNumbers } from "../../src/features/money/numbers";
import type { MoneyTarget } from "../../src/features/pot/target";
import { deployPot, walletOf } from "./pot-chain";
import { accounts, call, RPC } from "./rpc";

const run = RPC ? describe : describe.skip;
const DOLLAR = 1_000_000n;
const SHARE = 10n ** 18n;
const CHAIN = 31337;
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

run("the money screens against the real contracts", () => {
  it("reads and sends what the sheets show", async () => {
    const [admin, founder, backer, second] = await accounts();
    const chain = await deployPot(admin);
    const wallets = Object.fromEntries(
      [founder, backer, second].map((a) => [a, walletOf(a)]),
    );
    for (const who of [founder, backer, second])
      await wallets[who].sendCalls([pot.faucetCall(chain.dollar)], CHAIN);
    // The faucet's use and amount, as the faucet sheet reads them.
    expect(await state.faucetUsedBy(read, chain.dollar, backer)).toBe(true);
    expect(await state.faucetAmount(read, chain.dollar)).toBe(1000n * DOLLAR);
    expect(await state.readPlatformDollar(read, chain.launcher)).toBe(
      chain.dollar,
    );

    const [settingsHash] = await view(
      LAUNCHER_ABI,
      chain.launcher,
      "settingsHash",
    );
    const projectId = projectIdOf(`37001:${"cd".repeat(32)}:screens`);
    await wallets[founder].sendCalls(
      [
        pot.launchCall({
          launcher: chain.launcher,
          projectId,
          name: "Screens",
          symbol: "SCR",
          ratePpm: 1000,
          teamPool: 10_000_000n * SHARE,
          settingsHash: settingsHash as string,
        }),
      ],
      CHAIN,
    );
    const key = chainKeyOf(founder, projectId);
    // A project's contracts from the Launcher alone (the take-out that cannot lean on the record).
    const parts = await state.readProjectParts(read, chain.launcher, key);
    expect(parts.founder).toBe(founder);
    const [project] = (await view(
      LAUNCHER_ABI,
      chain.launcher,
      "projectByKey",
      [key],
    )) as [string[]];
    expect(parts.treasury).toBe((project[3] as string).toLowerCase());
    // An unknown key is refused, not read as a project of empty addresses.
    await expect(
      state.readProjectParts(read, chain.launcher, `0x${"77".repeat(32)}`),
    ).rejects.toThrow();

    const numbers = {
      contracts: {
        treasury: parts.treasury,
        shares: parts.shares,
        team: parts.team,
        vester: parts.vester,
        dollar: chain.dollar,
      },
      launcher: chain.launcher,
      key,
      unit: chain.unit,
      limits: { cliffUnits: 13 },
    } as unknown as ProjectNumbers;
    const target: MoneyTarget = {
      chainId: CHAIN,
      key,
      treasury: parts.treasury,
      shares: parts.shares,
      team: parts.team,
      vester: parts.vester,
      dollar: chain.dollar,
      playMoney: true,
    };

    // The Back sheet's own reader: the quote, the fee, the door and what the account holds, then its calls are sent.
    const back = await readBack(read, numbers, 100n * DOLLAR, backer);
    expect(back.ok).toBe(true);
    if (!back.ok) throw new Error("not ok");
    expect(back.fee).toBe(2n * DOLLAR);
    expect(back.ratePpm).toBe(1000);
    expect(back.plan.oneSignature).toBe(true);
    await wallets[backer].sendCalls(back.plan.calls, CHAIN);
    const held = await reads.balanceOf(read, parts.shares, backer);
    expect(held).toBeGreaterThanOrEqual(back.plan.minShares);
    expect(held).toBe(back.plan.quote.shares);

    // The allowance state the runner's card reads equals the Treasury's own views.
    const allowance = await state.readAllowanceState(read, parts.treasury);
    expect(allowance.ratePpm).toBe(1000);
    expect(allowance.box).toBe(
      (await view(TREASURY_ABI, parts.treasury, "box"))[0],
    );
    expect(allowance.maxRatePpm).toBe(2000);
    expect(allowance.pending).toBeNull();

    // The Take out sheet's reader: all of what is held; the cash is no less than the guard.
    const out = await readTakeOut(read, target, "backer", backer);
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("not ok");
    expect(out.shares).toBe(held);
    const before = await reads.balanceOf(read, chain.dollar, backer);
    await wallets[backer].sendCalls([out.call], CHAIN);
    expect(
      (await reads.balanceOf(read, chain.dollar, backer)) - before,
    ).toBeGreaterThanOrEqual(out.minCash);

    // A grant, and what the member keeps on their own exit (everything built up so far, no cliff).
    await wallets[founder].sendCalls(
      [
        pot.grantTeamCall({
          treasury: parts.treasury,
          member: second,
          amount: 1000n * SHARE,
        }),
      ],
      CHAIN,
    );
    const ids = await reads.grantIdsOf(read, parts.vester, second);
    expect(ids).toHaveLength(1);
    const grant = await state.readGrant(read, parts.vester, ids[0]!);
    expect(grant.member).toBe(second);
    expect(grant.total).toBe(1000n * SHARE);
    expect(grant.state).toBe(0);
    expect(grant.protectedGrant).toBe(false);
    expect(
      await state.accruedOf(read, parts.vester, ids[0]!),
    ).toBeLessThanOrEqual(grant.total);
  });
});

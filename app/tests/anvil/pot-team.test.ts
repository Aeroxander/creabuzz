// biome-ignore-all lint/style/noNonNullAssertion: each plan is asserted non-null on the line before it is used
/**
 * A founder launches, on the real contracts, driven only through the app's own launch path (the launch sheet's reader, its
 * terms and its call), its call builders and its words for a refusal: launch with the default numbers and with others, a
 * change of the platform's settings between the sheet and the signature. Run by `scripts/pot-app-loop.sh`; skipped without `M7_ANVIL_RPC`.
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
  type PAIR_ABI,
  type TREASURY_ABI,
} from "../../../packages/creaton-core/src/pot/abis.generated.ts";
import * as reads from "../../../packages/creaton-core/src/pot/pot-reads.ts";
import * as state from "../../../packages/creaton-core/src/pot/pot-state.ts";
import { launchCallFor } from "../../src/features/launch/launch-plan";
import { isLaunched } from "../../src/features/launch/launch-read";
import {
  type LaunchTerms,
  launchTermsFor,
} from "../../src/features/launch/launch-terms";
import { potProblem } from "../../src/features/money/pot-copy";
import { WalletStepError } from "../../src/features/money/wallet";
import { deployPot, walletOf } from "./pot-chain";
import { accounts, call, RPC, send } from "./rpc";

const run = RPC ? describe : describe.skip;
const DOLLAR = 1_000_000n;
const SHARE = 10n ** 18n;
const CHAIN = 31337;
const read = (to: string, data: string) => call(to, data);
type Chain = Awaited<ReturnType<typeof deployPot>>;

async function view(
  abi: typeof TREASURY_ABI | typeof LAUNCHER_ABI | typeof PAIR_ABI,
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
  const words = potProblem(error, action);
  expect(words).not.toMatch(/0x|revert|\(\)/);
  return words;
}

/** Launch a project exactly as the launch sheet does: its reader, its starting terms (or the ones given), its call. */
async function launch(
  chain: Chain,
  founder: string,
  label: string,
  chosen?: LaunchTerms,
) {
  const project = {
    coordinate: `37001:${"ee".repeat(32)}:${label}`,
    name: label,
  };
  const offer = await state.readLaunchOffer(read, chain.launcher);
  const terms = chosen ?? launchTermsFor(offer);
  if (!terms) throw new Error("the terms were refused");
  const key = chainKeyOf(founder, projectIdOf(project.coordinate));
  expect(await isLaunched(read, chain.launcher, key)).toBe(false);
  await walletOf(founder).sendCalls(
    [
      launchCallFor({
        launcher: chain.launcher,
        project,
        founder,
        terms,
        offer,
      }),
    ],
    CHAIN,
  );
  expect(await isLaunched(read, chain.launcher, key)).toBe(true);
  const parts = await state.readProjectParts(read, chain.launcher, key);
  return { chain, key, parts, terms, offer, founder, label };
}

run("launching, on the real contracts", () => {
  it("launches through the launch sheet's own path, with the numbers it showed, and refuses a changed setting in words", async () => {
    const [admin, founder] = await accounts();
    const chain = await deployPot(admin);

    // The sheet's reader: the settings fingerprint, the platform's limits and the rules, from the contracts themselves.
    const offer = await state.readLaunchOffer(read, chain.launcher);
    expect(offer.settingsHash).toBe(
      (await view(LAUNCHER_ABI, chain.launcher, "settingsHash"))[0],
    );
    expect(offer.feeBps).toBe(200);
    expect(offer.unit).toBe(chain.unit);
    expect(offer.agentUsd).toBe(25n * DOLLAR);
    expect(offer.maxRatePpm).toBe(2000);
    expect(offer.maxTeamPool).toBe(100_000_000n * SHARE);
    expect(offer.rules).toEqual({
      minJoin: DOLLAR,
      checkInUnits: 2,
      windDownUnits: 26,
      cliffUnits: 13,
      vestUnits: 104,
    });

    // The defaults launch what they say: 0.10% a day and a pool of 10,000,000 Team Shares.
    const first = await launch(chain, founder, "defaults");
    expect(first.terms).toEqual({
      ratePpm: 1000,
      teamPool: 10_000_000n * SHARE,
    });
    expect(await state.ratePpmNow(read, first.parts.treasury)).toBe(1000);
    expect(
      await reads.balanceOf(read, first.parts.team, first.parts.vester),
    ).toBe(10_000_000n * SHARE);
    expect(first.parts.founder).toBe(founder);

    // The contracts take other numbers too: 0.2% (the ceiling) and 500,000 Team Shares.
    const second = await launch(chain, founder, "typed", {
      ratePpm: 2000,
      teamPool: 500_000n * SHARE,
    });
    expect(await state.ratePpmNow(read, second.parts.treasury)).toBe(2000);
    expect(
      await reads.balanceOf(read, second.parts.team, second.parts.vester),
    ).toBe(500_000n * SHARE);
    // The sheet sends nothing when the platform's ceilings sit under the starting numbers; the contract refuses one more
    // thousandth over the ceiling if it were sent anyway.
    expect(launchTermsFor({ ...offer, maxRatePpm: 999 })).toBeNull();
    const forced = launchCallFor({
      launcher: chain.launcher,
      project: { coordinate: `37001:${"ee".repeat(32)}:over`, name: "over" },
      founder,
      terms: { ratePpm: 2001, teamPool: 10n * SHARE },
      offer,
    });
    expect(
      await stoppedWith(walletOf(founder).sendCalls([forced], CHAIN), "launch"),
    ).toMatch(/\S/);
    // The same project twice is refused in words.
    expect(
      await stoppedWith(
        walletOf(founder).sendCalls(
          [
            launchCallFor({
              launcher: chain.launcher,
              project: {
                coordinate: `37001:${"ee".repeat(32)}:typed`,
                name: "typed",
              },
              founder,
              terms: { ratePpm: 1000, teamPool: 10n * SHARE },
              offer,
            }),
          ],
          CHAIN,
        ),
        "launch",
      ),
    ).toMatch(/already|launched/i);

    // The platform changes its settings between the sheet and the signature: nothing is created, and the words say so.
    const platform = (await view(LAUNCHER_ABI, chain.launcher, "platform")) as [
      string,
      string,
      bigint,
      bigint,
      bigint,
    ];
    await send(
      admin,
      chain.launcher,
      encodeCall(LAUNCHER_ABI, "setSettings", [
        [platform[0], platform[1], platform[2], platform[3], 26n * DOLLAR],
      ]),
    );
    const moved = await state.readLaunchOffer(read, chain.launcher);
    expect(moved.settingsHash).not.toBe(offer.settingsHash);
    const stale = launchCallFor({
      launcher: chain.launcher,
      project: { coordinate: `37001:${"ee".repeat(32)}:late`, name: "late" },
      founder,
      terms: { ratePpm: 1000, teamPool: 10n * SHARE },
      offer, // the settings the sheet read before the change
    });
    expect(
      await stoppedWith(walletOf(founder).sendCalls([stale], CHAIN), "launch"),
    ).toMatch(/settings changed/);
    expect(
      await isLaunched(
        read,
        chain.launcher,
        chainKeyOf(founder, projectIdOf(`37001:${"ee".repeat(32)}:late`)),
      ),
    ).toBe(false);
    // Read again, the same press launches under the new settings.
    const again = await launch(chain, founder, "late");
    expect(again.offer.agentUsd).toBe(26n * DOLLAR);
  });
});

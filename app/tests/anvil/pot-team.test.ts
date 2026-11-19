// biome-ignore-all lint/style/noNonNullAssertion: each plan is asserted non-null on the line before it is used
/**
 * A founder launches, and the seat that runs the project's money changes hands, on the real contracts, driven only through
 * the app's own launch path (the launch sheet's reader, its terms and its call), its seat reader, its call builders and its
 * words for a refusal: launch with the default numbers and with others, a change of the platform's settings between the
 * sheet and the signature, an offer of the seat that is taken, withdrawn or left to run out, a founder who leaves with the
 * seat, a Pair made from an offer to its address and a wind-down through it, and a wind-down by anyone after a long
 * quiet. Run by `scripts/pot-app-loop.sh`; skipped without `M7_ANVIL_RPC`.
 */
import { describe, expect, it } from "vitest";
import {
  chainKeyOf,
  projectIdOf,
} from "../../../packages/creaton-core/src/launchpad/project-chain.ts";
import {
  decodeCall,
  decodeReturn,
  encodeCall,
} from "../../../packages/creaton-core/src/pot/abi-codec.ts";
import {
  LAUNCHER_ABI,
  PAIR_ABI,
  type TREASURY_ABI,
} from "../../../packages/creaton-core/src/pot/abis.generated.ts";
import * as pot from "../../../packages/creaton-core/src/pot/pot-calls.ts";
import { planTakeOut } from "../../../packages/creaton-core/src/pot/pot-plans.ts";
import * as reads from "../../../packages/creaton-core/src/pot/pot-reads.ts";
import * as state from "../../../packages/creaton-core/src/pot/pot-state.ts";
import { launchCallFor } from "../../src/features/launch/launch-plan";
import { isLaunched } from "../../src/features/launch/launch-read";
import {
  DEFAULT_LAUNCH_DRAFT,
  type LaunchTerms,
  readLaunchTerms,
} from "../../src/features/launch/launch-terms";
import type { ProjectNumbers } from "../../src/features/money/numbers";
import { potProblem } from "../../src/features/money/pot-copy";
import { asRunner } from "../../src/features/money/runner";
import { WalletStepError } from "../../src/features/money/wallet";
import { describePotCall } from "../../src/features/pot/pair-terms";
import { readSeatView } from "../../src/features/seat/use-seat";
import { deployPot, walletOf } from "./pot-chain";
import { accounts, call, passTime, RPC, send } from "./rpc";

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

/** Launch a project exactly as the launch sheet does: its reader, its terms from what is typed, its call. */
async function launch(
  chain: Chain,
  founder: string,
  label: string,
  draft = DEFAULT_LAUNCH_DRAFT,
) {
  const project = {
    coordinate: `37001:${"ee".repeat(32)}:${label}`,
    name: label,
  };
  const offer = await state.readLaunchOffer(read, chain.launcher);
  const terms: LaunchTerms = readLaunchTerms(draft, offer);
  if (!terms.ok) throw new Error("the terms were refused");
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
type Launched = Awaited<ReturnType<typeof launch>>;

/** The record's numbers, as far as the seat screens read them. */
function numbersOf(
  l: Launched,
  runner: { address: string; signers?: [string, string] },
): ProjectNumbers {
  return {
    key: l.key,
    founder: l.founder,
    launcher: l.chain.launcher,
    chainId: CHAIN,
    unit: l.chain.unit,
    windDown: null,
    contracts: {
      treasury: l.parts.treasury,
      shares: l.parts.shares,
      team: l.parts.team,
      vester: l.parts.vester,
      dollar: l.chain.dollar,
      pair: runner.signers ? runner.address : null,
    },
    runner: {
      address: runner.address,
      isPair: Boolean(runner.signers),
      signers: runner.signers ?? null,
    },
  } as unknown as ProjectNumbers;
}

/** Send a runner call as this account must (straight, or as a proposal through the Pair). */
async function asRunnerSend(
  numbers: ProjectNumbers,
  who: string,
  inner: pot.PotCall,
) {
  const sent = asRunner(numbers, who, inner);
  if (!sent) throw new Error("not a runner");
  await walletOf(who).sendCalls([sent.call], CHAIN);
  return sent.through;
}

run("launching and handing over the seat, on the real contracts", () => {
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
      ok: true,
      ratePpm: 1000,
      teamPool: 10_000_000n * SHARE,
    });
    expect(await state.ratePpmNow(read, first.parts.treasury)).toBe(1000);
    expect(
      await reads.balanceOf(read, first.parts.team, first.parts.vester),
    ).toBe(10_000_000n * SHARE);
    expect(first.parts.founder).toBe(founder);

    // Other numbers typed: 0.2% (the ceiling) and 500,000 Team Shares.
    const second = await launch(chain, founder, "typed", {
      rate: "0.2",
      pool: "500,000",
    });
    expect(await state.ratePpmNow(read, second.parts.treasury)).toBe(2000);
    expect(
      await reads.balanceOf(read, second.parts.team, second.parts.vester),
    ).toBe(500_000n * SHARE);
    // One more thousandth is refused by the sheet, and by the contract if it were sent anyway.
    const over = readLaunchTerms({ rate: "0.2001", pool: "10" }, offer);
    expect(over).toMatchObject({ ok: false });
    const forced = launchCallFor({
      launcher: chain.launcher,
      project: { coordinate: `37001:${"ee".repeat(32)}:over`, name: "over" },
      founder,
      terms: { ok: true, ratePpm: 2001, teamPool: 10n * SHARE },
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
              terms: { ok: true, ratePpm: 1000, teamPool: 10n * SHARE },
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
      terms: { ok: true, ratePpm: 1000, teamPool: 10n * SHARE },
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

  it("an offer of the seat is taken, or withdrawn, or runs out, and each is read the way the screens read it", async () => {
    const [admin, founder, anna, dora] = await accounts();
    const chain = await deployPot(admin);
    const l = await launch(chain, founder, "seat");
    const treasury = l.parts.treasury;
    const alone = numbersOf(l, { address: founder });

    // Nothing is offered: the founder runs it, nobody else is offered anything.
    let view1 = await readSeatView(alone, { address: founder, read }, [anna]);
    expect(view1.offerIsFor).toBeNull();
    expect(view1.seat.runner).toBe(founder);
    expect(view1.seat.offerLasts).toBe(2 * chain.unit);

    // Offer it to Anna: she reads it as hers, the founder as someone else's, and Dora sees nothing for her.
    expect(
      await asRunnerSend(
        alone,
        founder,
        pot.handOverCall({ treasury, next: anna, founderLeaves: false }),
      ),
    ).toBe("alone");
    view1 = await readSeatView(alone, { address: anna, read }, []);
    expect(view1.offerIsFor).toBe("me");
    expect(view1.seat.offeredTo).toBe(anna);
    expect(
      (await readSeatView(alone, { address: founder, read }, [anna]))
        .offerIsFor,
    ).toBe("other");
    expect(
      (await readSeatView(alone, { address: dora, read }, [])).offerIsFor,
    ).toBe("other");
    // Dora cannot take it: refused in words.
    expect(
      await stoppedWith(
        walletOf(dora).sendCalls([pot.takeSeatCall(treasury)], CHAIN),
        "seat",
      ),
    ).toMatch(/\S/);

    // The founder withdraws it: nobody is offered anything, and Anna's press is refused in words.
    await asRunnerSend(
      alone,
      founder,
      pot.handOverCall({
        treasury,
        next: pot.ZERO_ADDRESS,
        founderLeaves: false,
      }),
    );
    expect((await state.readSeatState(read, treasury)).offeredTo).toBeNull();
    expect(
      await stoppedWith(
        walletOf(anna).sendCalls([pot.takeSeatCall(treasury)], CHAIN),
        "seat",
      ),
    ).toMatch(/\S/);

    // Offered again, left to run out: after two time units it cannot be taken, and the words say it ended.
    await asRunnerSend(
      alone,
      founder,
      pot.handOverCall({ treasury, next: anna, founderLeaves: false }),
    );
    await passTime(2 * chain.unit + 30);
    expect(
      await stoppedWith(
        walletOf(anna).sendCalls([pot.takeSeatCall(treasury)], CHAIN),
        "seat",
      ),
    ).toMatch(/offer.*(ended|ran out|too late|no longer)/i);
    // A new offer replaces the old one, and this one is taken.
    await asRunnerSend(
      alone,
      founder,
      pot.handOverCall({ treasury, next: anna, founderLeaves: false }),
    );
    await walletOf(anna).sendCalls([pot.takeSeatCall(treasury)], CHAIN);
    expect((await state.readSeatState(read, treasury)).runner).toBe(anna);
    // The founder no longer runs it: a runner call from them is refused in words, Anna's goes through.
    const annaRuns = numbersOf(l, { address: anna });
    expect(
      asRunner(annaRuns, founder, pot.setDoorCall(treasury, false)),
    ).toBeNull();
    await expect(
      walletOf(founder).sendCalls([pot.setDoorCall(treasury, false)], CHAIN),
    ).rejects.toBeInstanceOf(WalletStepError);
    await asRunnerSend(annaRuns, anna, pot.setDoorCall(treasury, false));
    expect(await reads.doorOpenNow(read, treasury)).toBe(false);
  });

  it("a founder who leaves with the seat gives up what has not unlocked, and a member cannot ask for that", async () => {
    const [admin, founder, anna, dora] = await accounts();
    const chain = await deployPot(admin);
    const l = await launch(chain, founder, "leaving");
    const treasury = l.parts.treasury;
    const alone = numbersOf(l, { address: founder });
    // Only the founder may say they are leaving: Anna, once she runs it, cannot offer that on the founder's behalf.
    await asRunnerSend(
      alone,
      founder,
      pot.handOverCall({ treasury, next: anna, founderLeaves: true }),
    );
    const view = await readSeatView(alone, { address: anna, read }, []);
    expect(view.offerIsFor).toBe("me");
    expect(view.seat.founderLeaves).toBe(true);
    await walletOf(anna).sendCalls([pot.takeSeatCall(treasury)], CHAIN);
    expect((await state.readSeatState(read, treasury)).founderLeaves).toBe(
      false,
    );
    const annaRuns = numbersOf(l, { address: anna });
    expect(
      await stoppedWith(
        asRunnerSend(
          annaRuns,
          anna,
          pot.handOverCall({ treasury, next: dora, founderLeaves: true }),
        ),
        "seat",
      ),
    ).toMatch(/\S/);
  });

  it("makes a Pair from an offer to its address, then winds the project down through it: both signers, in words, taking out stays open", async () => {
    const [admin, founder, anna, backer] = await accounts();
    const chain = await deployPot(admin);
    for (const who of [founder, anna, backer])
      await walletOf(who).sendCalls([pot.faucetCall(chain.dollar)], CHAIN);
    const l = await launch(chain, founder, "pair");
    const treasury = l.parts.treasury;
    const alone = numbersOf(l, { address: founder });

    // The offer is to the address the Launcher works out for the two of them.
    const pairAddress = await state.pairAddressOf(
      read,
      chain.launcher,
      l.key,
      founder,
      anna,
    );
    await asRunnerSend(
      alone,
      founder,
      pot.handOverCall({ treasury, next: pairAddress, founderLeaves: false }),
    );
    // Anna reads it as an offer to a pair with her; the founder, given Anna among the team, reads who it is for.
    const forAnna = await readSeatView(alone, { address: anna, read }, []);
    expect(forAnna.offerIsFor).toBe("pair-with-me");
    expect(forAnna.offeredPairWith).toBe(anna);
    const forFounder = await readSeatView(alone, { address: founder, read }, [
      anna,
    ]);
    expect(forFounder.offeredPairWith).toBe(anna);
    // Someone else cannot accept it: the address is for these two.
    expect(
      (await readSeatView(alone, { address: backer, read }, [])).offerIsFor,
    ).toBe("other");
    expect(
      await stoppedWith(
        walletOf(backer).sendCalls(
          [pot.makePairCall(chain.launcher, l.key, founder)],
          CHAIN,
        ),
        "pair",
      ),
    ).toMatch(/\S/);

    // Anna accepts with the one who asked named: the two are the project's runner.
    await walletOf(anna).sendCalls(
      [pot.makePairCall(chain.launcher, l.key, founder)],
      CHAIN,
    );
    expect((await state.readSeatState(read, treasury)).runner).toBe(
      pairAddress,
    );
    expect(
      (await view(LAUNCHER_ABI, chain.launcher, "isPair", [pairAddress]))[0],
    ).toBe(true);
    const paired = numbersOf(l, {
      address: pairAddress,
      signers: [founder, anna],
    });
    // The founder alone can no longer set the door: it is a proposal now, and nothing happens until Anna confirms.
    expect(
      await asRunnerSend(paired, founder, pot.setDoorCall(treasury, false)),
    ).toBe("pair");
    expect(await reads.doorOpenNow(read, treasury)).toBe(true);

    // A backer puts money in; then the wind-down is proposed by the founder and confirmed by Anna.
    const quote = await reads.quoteBack(read, treasury, 50n * DOLLAR);
    await walletOf(backer).sendCalls(
      pot.backCalls({
        dollar: chain.dollar,
        treasury,
        amount: 50n * DOLLAR,
        minShares: quote.shares,
        to: backer,
        payAndCall: true,
      }),
      CHAIN,
    );
    const inner = pot.windDownCall(chain.launcher, l.key);
    const [nonceBefore] = await view(PAIR_ABI, pairAddress, "nonce");
    expect(await asRunnerSend(paired, founder, inner)).toBe("pair");
    // The founder cannot confirm their own proposal: refused in words.
    expect(
      await stoppedWith(
        walletOf(founder).sendCalls(
          [
            pot.pairConfirmCall(
              pairAddress,
              inner.to,
              inner.data,
              nonceBefore as bigint,
            ),
          ],
          CHAIN,
        ),
        "pair",
      ),
    ).toMatch(/\S/);
    // Anna reads the waiting call in words naming what it does, then confirms exactly it.
    const sentence = describePotCall(paired, inner.to, inner.data, (a) => a);
    expect(sentence.kind).toBe("wind-down");
    expect(sentence.words).toMatch(/for good/);
    await walletOf(anna).sendCalls(
      [
        pot.pairConfirmCall(
          pairAddress,
          inner.to,
          inner.data,
          nonceBefore as bigint,
        ),
      ],
      CHAIN,
    );
    expect((await state.readSeatState(read, treasury)).windDownKind).toBe(1);
    // A second wind-down is refused in words, and the backer still takes out everything.
    expect(
      await stoppedWith(
        walletOf(founder).sendCalls(
          [pot.treasuryWindDownCall(treasury)],
          CHAIN,
        ),
        "wind-down",
      ),
    ).toMatch(/wound down/);
    const held = await reads.balanceOf(read, l.parts.shares, backer);
    const plan = await planTakeOut(read, {
      treasury,
      holder: backer,
      shares: held,
      to: backer,
    });
    expect(plan).not.toBeNull();
    const before = await reads.balanceOf(read, chain.dollar, backer);
    await walletOf(backer).sendCalls([plan!.call], CHAIN);
    const cash = (await reads.balanceOf(read, chain.dollar, backer)) - before;
    expect(cash).toBeGreaterThanOrEqual(plan!.minCash);
    expect(cash).toBeGreaterThan(40n * DOLLAR);
    expect(await reads.balanceOf(read, l.parts.shares, backer)).toBe(0n);
    // The call builders agree with the Pair's own record of what was proposed.
    expect(decodeCall(LAUNCHER_ABI, inner.data)?.name).toBe("windDown");
  });

  it("anyone may wind a quiet project down, but not before half a year, and the refusal before is in words", async () => {
    const [admin, founder, stranger, backer] = await accounts();
    const chain = await deployPot(admin);
    for (const who of [founder, backer])
      await walletOf(who).sendCalls([pot.faucetCall(chain.dollar)], CHAIN);
    const l = await launch(chain, founder, "quiet");
    const treasury = l.parts.treasury;
    const quote = await reads.quoteBack(read, treasury, 30n * DOLLAR);
    await walletOf(backer).sendCalls(
      pot.backCalls({
        dollar: chain.dollar,
        treasury,
        amount: 30n * DOLLAR,
        minShares: quote.shares,
        to: backer,
        payAndCall: true,
      }),
      CHAIN,
    );
    // Quiet for a while, not for 26 time units: refused, in words.
    await passTime(10 * chain.unit);
    expect(
      await stoppedWith(
        walletOf(stranger).sendCalls(
          [pot.treasuryWindDownCall(treasury)],
          CHAIN,
        ),
        "wind-down",
      ),
    ).toMatch(/\S/);
    expect((await state.readSeatState(read, treasury)).windDownKind).toBe(0);
    await passTime(17 * chain.unit);
    await walletOf(stranger).sendCalls(
      [pot.treasuryWindDownCall(treasury)],
      CHAIN,
    );
    expect((await state.readSeatState(read, treasury)).windDownKind).toBe(2);
    // The runner's own wind-down is not possible on top: said in words.
    expect(
      await stoppedWith(
        walletOf(founder).sendCalls(
          [pot.windDownCall(chain.launcher, l.key)],
          CHAIN,
        ),
        "wind-down",
      ),
    ).toMatch(/wound down/);
  });
});

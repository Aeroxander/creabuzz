/**
 * The runner seat on a real EVM, through the app's own calls and wallet: a plain hand-over and its taking, a founder
 * who leaves (their Shares cut to the days served, the rest back in the work pot), a Pair's proposal withdrawn, and a
 * signer's check-in through the Pair. Run by `scripts/m7-chain-loop.sh`; skipped without `M7_ANVIL_RPC`.
 */
import { describe, expect, it } from "vitest";
import {
  directCall,
  handOverData,
  LAUNCHER_READS,
  makePairCall,
  PAIR_READS,
  pairCancelCall,
  pairCheckInCall,
  pairConfirmCall,
  takeSeatCall,
  TREASURY_READS,
} from "../../src/features/team/team-calls";
import { teamProblem } from "../../src/features/team/team-copy";
import { readAddress } from "../../src/features/team/use-team";
import { deployPlatform } from "./deploy";
import { accounts, chainTime, passTime, RPC, word } from "./rpc";
import { DAY, data, launched, proposeThrough, SHARE, walletOf } from "./steps";

const ZERO = `0x${"0".repeat(40)}`;
const run = RPC ? describe : describe.skip;

run("milestone 7 on anvil: the runner seat", () => {
  it("hands the seat to a successor, who takes it; nothing changes until they do, and nobody else can", async () => {
    const [admin, founder, successor, stranger, , , , , , stake] =
      await accounts();
    const platform = await deployPlatform(admin, stake);
    const p = await launched(
      platform,
      founder,
      `37001:${"e1".repeat(32)}:seat`,
    );
    const founderWallet = walletOf(founder);
    const granted = await word(
      p.vester,
      data("grants(address)", ["address"], [founder]),
    );
    const potBefore = await word(p.treasury, TREASURY_READS.workPot);

    await founderWallet.sendCalls(
      [directCall(p.treasury, handOverData(successor, false))],
      31337,
    );
    // Offered, not taken: the founder still runs it, and the app's read of the offer names the successor.
    expect(await readAddress(founderWallet, p.treasury, data("runner()"))).toBe(
      founder,
    );
    expect(
      await readAddress(
        founderWallet,
        p.treasury,
        TREASURY_READS.pendingRunner,
      ),
    ).toBe(successor);
    try {
      await walletOf(stranger).sendCalls([takeSeatCall(p.treasury)], 31337);
      throw new Error("a stranger took the seat");
    } catch (error) {
      expect(teamProblem(error, "take-seat")).toBe(
        "This wallet was not offered the seat. Nothing changed.",
      );
    }

    await walletOf(successor).sendCalls([takeSeatCall(p.treasury)], 31337);
    expect(await readAddress(founderWallet, p.treasury, data("runner()"))).toBe(
      successor,
    );
    expect(
      await readAddress(
        founderWallet,
        p.treasury,
        TREASURY_READS.pendingRunner,
      ),
    ).toBe(ZERO);
    // A plain hand-over leaves the founder's Shares and the work pot as they were.
    expect(
      await word(p.vester, data("grants(address)", ["address"], [founder])),
    ).toBe(granted);
    expect(await word(p.treasury, TREASURY_READS.workPot)).toBe(potBefore);
    // The founder no longer runs it: their next hand-over is refused, in the app's words.
    try {
      await founderWallet.sendCalls(
        [directCall(p.treasury, handOverData(stranger, false))],
        31337,
      );
      throw new Error("the last runner handed over again");
    } catch (error) {
      expect(teamProblem(error, "hand-over")).not.toMatch(/0x|revert/i);
    }
    // A later runner cannot mark the founder as leaving.
    try {
      await walletOf(successor).sendCalls(
        [directCall(p.treasury, handOverData(stranger, true))],
        31337,
      );
      throw new Error("a later runner cut the founder's Shares");
    } catch (error) {
      expect(teamProblem(error, "hand-over")).toBe(
        "Only the founder can mark that they are leaving. Nothing changed.",
      );
    }
  }, 600_000);

  it("cuts a leaving founder's Shares to the days served out of 365, and puts the rest in the work pot", async () => {
    const [admin, founder, successor, , , , , , , stake] = await accounts();
    const platform = await deployPlatform(admin, stake);
    const p = await launched(
      platform,
      founder,
      `37001:${"e2".repeat(32)}:leave`,
    );
    const born = Number(await word(p.vester, data("bornAt()")));
    const granted = await word(p.vester, data("founderAmount()"));
    expect(granted).toBe(200_000_000n * SHARE);
    const potBefore = await word(p.treasury, TREASURY_READS.workPot);

    await passTime(73 * DAY);
    await walletOf(founder).sendCalls(
      [directCall(p.treasury, handOverData(successor, true))],
      31337,
    );
    await walletOf(successor).sendCalls([takeSeatCall(p.treasury)], 31337);
    const served = BigInt((await chainTime()) - born);
    const kept = (granted * served) / BigInt(365 * DAY);
    // About a fifth of the year served: about a fifth kept.
    expect(Number(kept / SHARE)).toBeGreaterThan(39_900_000);
    expect(Number(kept / SHARE)).toBeLessThan(40_100_000);
    expect(await word(p.vester, data("founderAmount()"))).toBe(kept);
    expect(
      await word(p.vester, data("grants(address)", ["address"], [founder])),
    ).toBe(kept);
    expect(await word(p.treasury, TREASURY_READS.workPot)).toBe(
      potBefore + (granted - kept),
    );
    expect(
      await readAddress(walletOf(founder), p.treasury, data("runner()")),
    ).toBe(successor);
  }, 600_000);

  it("withdraws a Pair's proposal so it can never be confirmed, and checks in through the Pair", async () => {
    const [admin, founder, cosigner, stranger, , , , , , stake] =
      await accounts();
    const platform = await deployPlatform(admin, stake);
    const p = await launched(
      platform,
      founder,
      `37001:${"e3".repeat(32)}:pair`,
    );
    const founderWallet = walletOf(founder);
    const cosignerWallet = walletOf(cosigner);
    const pair = await readAddress(
      founderWallet,
      platform.launcher,
      LAUNCHER_READS.pairAddress(p.key, founder, cosigner),
    );
    await founderWallet.sendCalls(
      [directCall(p.treasury, handOverData(pair, false))],
      31337,
    );
    await cosignerWallet.sendCalls(
      [makePairCall(platform.launcher, p.key, founder)],
      31337,
    );

    // The founder asks to hand the seat to a stranger, then thinks better of it.
    const proposal = await proposeThrough(
      pair,
      founderWallet,
      p.treasury,
      handOverData(stranger, false),
    );
    expect(
      await readAddress(founderWallet, pair, PAIR_READS.proposer(proposal.id)),
    ).toBe(founder);
    // Only the signer who asked can withdraw it.
    try {
      await cosignerWallet.sendCalls(
        [pairCancelCall(pair, proposal.id)],
        31337,
      );
      throw new Error("the other signer withdrew it");
    } catch (error) {
      expect(teamProblem(error, "withdraw")).toBe(
        "Only the signer who proposed this can withdraw it.",
      );
    }
    await founderWallet.sendCalls([pairCancelCall(pair, proposal.id)], 31337);
    // Gone: the app's list drops it (its proposer reads as nobody) and a late confirm is refused in the app's words.
    expect(
      await readAddress(founderWallet, pair, PAIR_READS.proposer(proposal.id)),
    ).toBe(ZERO);
    try {
      await cosignerWallet.sendCalls(
        [pairConfirmCall(pair, proposal.target, proposal.data, proposal.nonce)],
        31337,
      );
      throw new Error("a withdrawn call ran");
    } catch (error) {
      expect(teamProblem(error, "confirm")).toBe(
        "This call is not waiting any more: it was confirmed or withdrawn. The list here catches up in a moment.",
      );
    }
    expect(
      await readAddress(
        founderWallet,
        p.treasury,
        TREASURY_READS.pendingRunner,
      ),
    ).toBe(ZERO);

    // Either signer checks in through the Pair; a stranger cannot.
    await passTime(5 * DAY);
    const before = await word(p.treasury, TREASURY_READS.activeEnd);
    await cosignerWallet.sendCalls([pairCheckInCall(pair)], 31337);
    const after = await word(p.treasury, TREASURY_READS.activeEnd);
    expect(after).toBe(BigInt((await chainTime()) + 14 * DAY));
    expect(after).toBeGreaterThan(before);
    try {
      await walletOf(stranger).sendCalls([pairCheckInCall(pair)], 31337);
      throw new Error("a stranger checked in");
    } catch (error) {
      expect(teamProblem(error, "confirm")).not.toMatch(/0x|revert/i);
    }
  }, 600_000);
});

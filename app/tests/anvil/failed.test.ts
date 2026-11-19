/**
 * A sale that does not reach its minimum, on a real EVM through the app's own calls and wallet: bids come in under
 * 100,000 dollars, anyone closes it with the app's one step, and every bidder collects all their dollars with the app's
 * collect call; no market opens and the project is still a Team. Run by `scripts/m7-chain-loop.sh`; skipped without
 * `M7_ANVIL_RPC`.
 */
import { describe, expect, it } from "vitest";
import {
  bidCalls,
  collectCalls,
  finishCall,
  MARKET_READS,
} from "../../src/features/market/market-calls";
import {
  BID_SUBMITTED,
  readFinishCalls,
} from "../../src/features/market/use-market";
import {
  directCall,
  handOverData,
  LAUNCHER_READS,
  makePairCall,
  openAuctionData,
  TREASURY_READS,
} from "../../src/features/team/team-calls";
import { teamProblem } from "../../src/features/team/team-copy";
import { readAddress, readWord } from "../../src/features/team/use-team";
import { deployPlatform, mintDollars } from "./deploy";
import { accounts, blockNumber, call, chainTime, mine, RPC, word } from "./rpc";
import { confirmThrough, DAY, DOLLAR, data, launched, walletOf } from "./steps";

const run = RPC ? describe : describe.skip;

run("milestone 7 on anvil: a sale under its minimum", () => {
  it("closes with one step, pays every bid back in full, and opens no market", async () => {
    const [admin, founder, cosigner, b1, b2, stranger, , , , stake] =
      await accounts();
    const platform = await deployPlatform(admin, stake);
    const p = await launched(
      platform,
      founder,
      `37001:${"f1".repeat(32)}:quiet`,
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
    const start = BigInt(
      (await call(platform.launcher, LAUNCHER_READS.salePrices())).slice(0, 66),
    );
    await confirmThrough(
      pair,
      founderWallet,
      cosignerWallet,
      platform.launcher,
      openAuctionData(p.key, start),
    );
    const auction = await readAddress(
      founderWallet,
      p.finisher,
      data("auction()"),
    );
    const endBlock = Number(await word(p.finisher, data("endBlock()")));
    await mine(2);

    // Two bids of 20,000: 40,000 of the 100,000 the sale needs.
    const bidders = [b1, b2];
    const balanceOf = (who: string) =>
      word(platform.quote, data("balanceOf(address)", ["address"], [who]));
    for (const bidder of bidders) {
      await mintDollars(stranger, platform.quote, bidder, 20_000n * DOLLAR);
      await walletOf(bidder).sendCalls(
        bidCalls({
          auction,
          quote: platform.quote,
          owner: bidder,
          amount: 20_000n * DOLLAR,
          floorQ96: start,
          permit2Allowance: 0n,
          deadline: BigInt((await chainTime()) + 10 * DAY),
        }),
        31337,
      );
      expect(await balanceOf(bidder)).toBe(0n);
    }
    await mine(endBlock - (await blockNumber()) + 2);
    expect(
      await readWord(founderWallet, auction, MARKET_READS.isGraduated),
    ).toBe(0n);

    // Closing alone is refused until the pool step ran (what the app first sent), in the app's words.
    try {
      await walletOf(stranger).sendCalls(
        [finishCall(p.finisher, "sweep")],
        31337,
      );
      throw new Error("a sale closed before its pool step");
    } catch (error) {
      expect(teamProblem(error, "finish")).not.toMatch(/0x|revert/i);
    }
    // The record says the minimum was not reached: the press reads the chain and sends the pool step, then the sweep.
    const stranded = walletOf(stranger);
    const steps = await readFinishCalls(stranded, p.finisher, auction, false);
    expect(steps).toEqual([
      finishCall(p.finisher, "openPool"),
      finishCall(p.finisher, "sweep"),
    ]);
    await stranded.sendCalls(steps, 31337);
    expect(await word(p.finisher, data("stage()"))).toBe(3n);
    // A second press has nothing to refuse it: the one step left does nothing.
    expect(await readFinishCalls(stranded, p.finisher, auction, false)).toEqual(
      [finishCall(p.finisher, "sweep")],
    );
    expect(await word(p.treasury, TREASURY_READS.poolOpen)).toBe(0n);
    expect(await word(p.treasury, TREASURY_READS.settled)).toBe(0n);
    expect(
      await word(
        platform.launcher,
        data("stageOf(bytes32)", ["bytes32"], [p.key]),
      ),
    ).toBe(2n);

    // Each bidder finds their bid by its log and collects with the app's call for a failed sale: every dollar back.
    for (const bidder of bidders) {
      const wallet = walletOf(bidder);
      const logs = await wallet.getLogs({
        address: auction,
        topics: [BID_SUBMITTED, null, `0x${bidder.slice(2).padStart(64, "0")}`],
        from: Math.max(0, endBlock - 7_300),
        to: endBlock,
      });
      expect(logs.length).toBe(1);
      await wallet.sendCalls(
        collectCalls(auction, BigInt(logs[0].topics[1]), {
          exit: true,
          claim: false,
        }),
        31337,
      );
      expect(await balanceOf(bidder)).toBe(20_000n * DOLLAR);
      expect(
        await word(p.shares, data("balanceOf(address)", ["address"], [bidder])),
      ).toBe(0n);
    }
    expect(await balanceOf(auction)).toBe(0n);
  }, 600_000);
});

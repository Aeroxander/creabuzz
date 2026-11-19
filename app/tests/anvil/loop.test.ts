/**
 * Milestone 7's chain loop: 10,000 alone, then a second person, then 50,000, then the auction and its pool, driven by
 * the app's own call builders through the app's own wallet (`injectedWallet`) on a real EVM (anvil), with the real
 * contracts from `contracts/next/out`. Every check reads the chain. Run by `scripts/m7-chain-loop.sh`, which starts
 * anvil and sets `M7_ANVIL_RPC`; skipped without it.
 */
import { describe, expect, it } from "vitest";
import {
  bidCalls,
  finishCall,
  handBackCalls,
} from "../../src/features/market/market-calls";
import {
  buyMoves,
  handBackPaid,
  poolSharePrice,
} from "../../src/features/market/market-math";
import {
  BID_SUBMITTED,
  readFinishCalls,
  readPool,
} from "../../src/features/market/use-market";
import { openBackingCall } from "../../src/features/money/calls";
import type { MoneyWallet } from "../../src/features/money/wallet";
import {
  directCall,
  giveSharesData,
  handOverData,
  LAUNCHER_READS,
  makePairCall,
  openAuctionData,
  openRoundData,
  PAIR_READS,
  pairSpendCall,
  TREASURY_READS,
  windDownData,
} from "../../src/features/team/team-calls";
import { teamProblem } from "../../src/features/team/team-copy";
import { readAddress } from "../../src/features/team/use-team";
import { collectBid } from "./steps";
import { deployPlatform, mintDollars } from "./deploy";
import {
  accounts,
  blockNumber,
  call,
  chainTime,
  mine,
  RPC,
  send,
  word,
} from "./rpc";
import {
  backAndClose,
  confirmThrough,
  DAY,
  DOLLAR,
  data,
  launched,
  openedRound,
  SHARE,
  walletOf,
} from "./steps";

const run = RPC ? describe : describe.skip;

run("milestone 7 on anvil: alone, then two, then a market", () => {
  it("runs 10,000 alone, a second person, 50,000, the auction, the pool and a hand-back with the app's calls", async () => {
    const a = await accounts();
    const [admin, founder, cosigner, b1, b2, b3, b4, b5, stranger, stake] = a;
    const platform = await deployPlatform(admin, stake);
    const coordinate = `37001:${"ab".repeat(32)}:lantern`;
    const p = await launched(platform, founder, coordinate);
    expect(
      await word(
        platform.launcher,
        data("stageOf(bytes32)", ["bytes32"], [p.key]),
      ),
    ).toBe(0n);

    // Solo: one press opens a round at the default price; two backers fill the 10,000 cap.
    const founderWallet = walletOf(founder);
    const opened = await founderWallet.sendCalls(
      [openBackingCall(platform.launcher, p.key)],
      31337,
    );
    const round1 = await openedRound(opened.txHash, platform.launcher);
    await backAndClose(
      platform,
      p,
      round1,
      [b1, b2],
      5_000n * DOLLAR,
      stranger,
    );
    expect(await word(p.rounds, data("raised()"))).toBe(10_000n * DOLLAR);
    expect(
      await word(
        platform.launcher,
        data("stageOf(bytes32)", ["bytes32"], [p.key]),
      ),
    ).toBe(1n);
    // The cap holds: a second round alone is refused, in the app's words.
    try {
      await founderWallet.sendCalls(
        [openBackingCall(platform.launcher, p.key)],
        31337,
      );
      throw new Error("a round past the cap opened");
    } catch (error) {
      expect(teamProblem(error, "open-round")).toBe(
        "The project has raised the most it can at this stage, so no round can open.",
      );
    }

    // A second person: the founder offers the seat to the Pair of the two, the second person accepts.
    const pair = await readAddress(
      founderWallet,
      platform.launcher,
      LAUNCHER_READS.pairAddress(p.key, founder, cosigner),
    );
    await founderWallet.sendCalls(
      [directCall(p.treasury, handOverData(pair, false))],
      31337,
    );
    const cosignerWallet = walletOf(cosigner);
    await cosignerWallet.sendCalls(
      [makePairCall(platform.launcher, p.key, founder)],
      31337,
    );
    expect(
      await word(
        platform.launcher,
        data("stageOf(bytes32)", ["bytes32"], [p.key]),
      ),
    ).toBe(2n);
    expect(await readAddress(founderWallet, p.treasury, data("runner()"))).toBe(
      pair,
    );
    expect(
      await word(
        platform.launcher,
        data("capOf(address)", ["address"], [pair]),
      ),
    ).toBe(50_000n * DOLLAR);
    expect(await readAddress(founderWallet, pair, PAIR_READS.second)).toBe(
      cosigner,
    );

    // Both sign a round up to 50,000: one proposes, the other confirms the exact call read back from the Proposed log.
    const confirmLatest = (
      proposer: MoneyWallet,
      confirmer: MoneyWallet,
      target: string,
      inner: string,
    ) => confirmThrough(pair, proposer, confirmer, target, inner);
    const roundTx = await confirmLatest(
      founderWallet,
      cosignerWallet,
      platform.launcher,
      openRoundData(p.key, 3n * 10n ** 15n),
    );
    const round2 = await openedRound(roundTx.txHash, platform.launcher);
    await backAndClose(
      platform,
      p,
      round2,
      [b1, b2, b3, b4],
      10_000n * DOLLAR,
      stranger,
    );
    expect(await word(p.rounds, data("raised()"))).toBe(50_000n * DOLLAR);

    // Give Shares through the Pair: before a market they are held in the Vester for the person.
    const vesterBefore = await word(
      p.shares,
      data("balanceOf(address)", ["address"], [p.vester]),
    );
    await confirmLatest(
      cosignerWallet,
      founderWallet,
      p.treasury,
      giveSharesData(b5, 1_000_000n * SHARE),
    );
    expect(
      await word(p.shares, data("balanceOf(address)", ["address"], [p.vester])),
    ).toBe(vesterBefore + 1_000_000n * SHARE);
    expect(
      await word(p.shares, data("balanceOf(address)", ["address"], [b5])),
    ).toBe(0n);

    // One signer alone spends up to 500 dollars in 7 days; one dollar more is refused, in the app's words.
    await founderWallet.sendCalls(
      [pairSpendCall(pair, stranger, 500n * DOLLAR)],
      31337,
    );
    expect(
      await word(
        platform.quote,
        data("balanceOf(address)", ["address"], [stranger]),
      ),
    ).toBe(500n * DOLLAR);
    try {
      await founderWallet.sendCalls(
        [pairSpendCall(pair, stranger, DOLLAR)],
        31337,
      );
      throw new Error("spent past the limit");
    } catch (error) {
      expect(teamProblem(error, "spend")).toMatch(
        /more than one signer may spend alone in 7 days/,
      );
    }

    // The auction, opened by both at the lowest start; five bids of 25,000 at the most it allows.
    const start = BigInt(
      (await call(platform.launcher, LAUNCHER_READS.salePrices())).slice(0, 66),
    );
    await confirmLatest(
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
    for (const bidder of [b1, b2, b3, b4, b5]) {
      await mintDollars(stranger, platform.quote, bidder, 25_000n * DOLLAR);
      await walletOf(bidder).sendCalls(
        bidCalls({
          auction,
          quote: platform.quote,
          owner: bidder,
          amount: 25_000n * DOLLAR,
          floorQ96: start,
          permit2Allowance: 0n,
          deadline: BigInt((await chainTime()) + 10 * DAY),
        }),
        31337,
      );
    }
    await mine(endBlock - (await blockNumber()) + 2);

    // Anyone finishes it with the app's three steps; the market is open.
    // The record lags (it still says the minimum was not reached): the first press runs the pool step and is then
    // refused, and the next press, reading the auction itself, splits the money and sweeps. Never stuck.
    const finisherWallet = walletOf(stranger);
    const first = await readFinishCalls(
      finisherWallet,
      p.finisher,
      auction,
      false,
    );
    expect(first).toEqual([
      finishCall(p.finisher, "openPool"),
      finishCall(p.finisher, "sweep"),
    ]);
    try {
      await finisherWallet.sendCalls(first, 31337);
      throw new Error("a sale that reached its minimum closed as failed");
    } catch (error) {
      expect(teamProblem(error, "finish")).toBe(
        "The sale's money has to be split first. Press the earlier finishing step.",
      );
    }
    const second = await readFinishCalls(
      finisherWallet,
      p.finisher,
      auction,
      false,
    );
    expect(second).toEqual([
      finishCall(p.finisher, "settle"),
      finishCall(p.finisher, "sweep"),
    ]);
    await finisherWallet.sendCalls(second, 31337);
    expect(await word(p.finisher, data("stage()"))).toBe(2n);
    expect(
      await word(
        platform.launcher,
        data("stageOf(bytes32)", ["bytes32"], [p.key]),
      ),
    ).toBe(3n);

    // Each bidder finds their bid by its log and collects it: the unused dollars back, the Shares bought.
    for (const bidder of [b1, b2, b3, b4, b5]) {
      const wallet = walletOf(bidder);
      const logs = await wallet.getLogs({
        address: auction,
        topics: [BID_SUBMITTED, null, `0x${bidder.slice(2).padStart(64, "0")}`],
        from: Math.max(0, endBlock - 7_300),
        to: endBlock,
      });
      expect(logs.length).toBe(1);
      await wallet.sendCalls(
        await collectBid(wallet, auction, BigInt(logs[0].topics[1]), true),
        31337,
      );
      expect(
        await word(p.shares, data("balanceOf(address)", ["address"], [bidder])),
      ).toBeGreaterThan(0n);
    }

    // The pool, read as the app reads it: its price near the auction's, and its depth.
    const pool = await readPool(founderWallet, p.finisher, p.shares);
    expect(pool.liquidity).toBeGreaterThan(0n);
    const clearing = BigInt(
      (await call(auction, data("clearingPrice()"))).slice(0, 66),
    );
    const price = poolSharePrice(pool.sqrtPriceX96, pool.sharesAreCurrency0);
    const auctionPrice = (Number(clearing) / 2 ** 96) * 1e12;
    expect(Math.abs(price / auctionPrice - 1)).toBeLessThan(0.05);
    const predicted = buyMoves({
      sqrtPriceX96: pool.sqrtPriceX96,
      liquidity: pool.liquidity,
      sharesAreCurrency0: pool.sharesAreCurrency0,
      dollars: 100n * DOLLAR,
    });
    expect(predicted).toBeGreaterThan(0);

    // A 100-dollar buy through the test swap router moves the price as the depth line said.
    await mintDollars(stranger, platform.quote, stranger, 100n * DOLLAR);
    await send(
      stranger,
      platform.quote,
      data(
        "approve(address,uint256)",
        ["address", "uint256"],
        [platform.swapTest, 100n * DOLLAR],
      ),
    );
    const zeroForOne = pool.key.currency0 === platform.quote;
    await send(
      stranger,
      platform.swapTest,
      data(
        "swap((address,address,uint24,int24,address),(bool,int256,uint160),(bool,bool),bytes)",
        [
          { tuple: ["address", "address", "uint24", "int24", "address"] },
          { tuple: ["bool", "int256", "uint160"] },
          { tuple: ["bool", "bool"] },
          "bytes",
        ],
        [
          [
            pool.key.currency0,
            pool.key.currency1,
            BigInt(pool.key.fee),
            BigInt(pool.key.tickSpacing),
            pool.key.hooks,
          ],
          [
            zeroForOne,
            -(100n * DOLLAR),
            zeroForOne
              ? 4_295_128_740n
              : 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341n,
          ],
          [false, false],
          "0x",
        ],
      ),
    );
    const after = await readPool(founderWallet, p.finisher, p.shares);
    const moved =
      poolSharePrice(after.sqrtPriceX96, after.sharesAreCurrency0) / price - 1;
    expect(Math.abs(moved - (predicted ?? 0))).toBeLessThan(
      (predicted ?? 0) * 0.02,
    );

    // A bidder hands Shares back at the floor with the app's two calls, and gets what the Treasury's rule pays.
    const handing = 1_000_000n * SHARE;
    const [melting, permanent, counting, total] = await Promise.all([
      word(p.treasury, TREASURY_READS.melting),
      word(p.treasury, TREASURY_READS.permanentFloor),
      word(p.treasury, TREASURY_READS.countingSupply),
      word(p.shares, data("totalSupply()")),
    ]);
    const dollarsBefore = await word(
      platform.quote,
      data("balanceOf(address)", ["address"], [b1]),
    );
    await walletOf(b1).sendCalls(
      handBackCalls(p.shares, p.treasury, handing),
      31337,
    );
    const got =
      (await word(
        platform.quote,
        data("balanceOf(address)", ["address"], [b1]),
      )) - dollarsBefore;
    const slice =
      (melting * handing) / counting + (permanent * handing) / total;
    // The release runs per second, so the floor melted a little between the read and the hand-back.
    const expected = handBackPaid(slice, false);
    expect(got).toBeLessThanOrEqual(expected);
    expect(Number(expected - got)).toBeLessThan(Number(expected) * 1e-4);
    expect(got).toBeGreaterThan(0n);

    // Another project winds down before any market, with the app's call; a second wind-down is refused in its words.
    const q = await launched(
      platform,
      founder,
      `37001:${"cd".repeat(32)}:kiln`,
    );
    await founderWallet.sendCalls(
      [directCall(platform.launcher, windDownData(q.key))],
      31337,
    );
    expect(await word(q.treasury, TREASURY_READS.woundDown)).toBe(1n);
    try {
      await founderWallet.sendCalls(
        [directCall(platform.launcher, windDownData(q.key))],
        31337,
      );
      throw new Error("wound down twice");
    } catch (error) {
      expect(teamProblem(error, "wind-down")).toBe(
        "This project has already wound down. Nothing changed.",
      );
    }
  }, 600_000);
});

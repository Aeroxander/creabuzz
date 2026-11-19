/**
 * An auction with more demand than it can fill, on a real EVM through the app's own calls and wallet: five bids (480,000
 * dollars) at the top price the app places (4 times the start) against 250,000,000 Shares. The last bid pushes the price
 * to that top price, so every bid is only partly filled at the final price: the app reads the auction's checkpoint list to give the
 * auction the two hints it wants, each bidder gets their unused dollars back and the Shares their bid bought, and nothing
 * is left in the auction. Run by `scripts/m7-chain-loop.sh`; skipped without `M7_ANVIL_RPC`.
 */
import { describe, expect, it } from "vitest";
import { readExitPlan } from "../../src/features/market/exit-plan";
import { finishCall } from "../../src/features/market/market-calls";
import {
  BID_SUBMITTED,
  readFinishCalls,
} from "../../src/features/market/use-market";
import { bidCalls } from "../../src/features/market/market-calls";
import {
  directCall,
  handOverData,
  LAUNCHER_READS,
  makePairCall,
  openAuctionData,
} from "../../src/features/team/team-calls";
import { readAddress } from "../../src/features/team/use-team";
import { deployPlatform, mintDollars } from "./deploy";
import { accounts, blockNumber, call, chainTime, mine, RPC, word } from "./rpc";
import {
  collectBid,
  confirmThrough,
  DAY,
  DOLLAR,
  data,
  launched,
  SHARE,
  walletOf,
} from "./steps";

const run = RPC ? describe : describe.skip;

run("milestone 7 on anvil: an oversubscribed auction", () => {
  it("settles every partly filled bid with hints read from the auction's checkpoints", async () => {
    const [admin, founder, cosigner, b1, b2, b3, b4, b5, stranger, stake] =
      await accounts();
    const platform = await deployPlatform(admin, stake);
    const p = await launched(
      platform,
      founder,
      `37001:${"f2".repeat(32)}:crowded`,
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

    // 480,000 dollars of bids at the top price against 250,000,000 Shares. The auction refuses a bid whose top price is not
    // above the price it has reached, so the first four (380,000) leave the price under the top, and the last one pushes it
    // there: from then on every bid sits at exactly the final price.
    const bidders = [b1, b2, b3, b4, b5];
    const amounts = [95_000n, 95_000n, 95_000n, 95_000n, 100_000n];
    const balanceOf = (token: string, who: string) =>
      word(token, data("balanceOf(address)", ["address"], [who]));
    for (const [i, bidder] of bidders.entries()) {
      await mintDollars(stranger, platform.quote, bidder, amounts[i] * DOLLAR);
      await walletOf(bidder).sendCalls(
        bidCalls({
          auction,
          quote: platform.quote,
          owner: bidder,
          amount: amounts[i] * DOLLAR,
          floorQ96: start,
          permit2Allowance: 0n,
          deadline: BigInt((await chainTime()) + 10 * DAY),
        }),
        31337,
      );
      // Each in its own block, so the auction writes a checkpoint for each and the walk has something to walk.
      await mine(3);
    }
    await mine(endBlock - (await blockNumber()) + 2);

    // Anyone finishes it: the pool step, then the money's split and the sweep.
    const finisher = walletOf(stranger);
    await finisher.sendCalls([finishCall(p.finisher, "openPool")], 31337);
    const rest = await readFinishCalls(finisher, p.finisher, auction, true);
    await finisher.sendCalls(rest, 31337);
    expect(await word(p.finisher, data("stage()"))).toBe(2n);

    // Every bid is at the final price: partly filled, settled with the last checkpoint under it and 0 for "not outbid".
    let sold = 0n;
    for (const [i, bidder] of bidders.entries()) {
      const wallet = walletOf(bidder);
      const logs = await wallet.getLogs({
        address: auction,
        topics: [BID_SUBMITTED, null, `0x${bidder.slice(2).padStart(64, "0")}`],
        from: Math.max(0, endBlock - 7_300),
        to: endBlock,
      });
      expect(logs.length).toBe(1);
      const id = BigInt(logs[0].topics[1]);
      const plan = await readExitPlan(wallet, auction, id);
      expect(plan.kind).toBe("partial");
      if (plan.kind === "partial") {
        expect(plan.outbid).toBe(0n);
        expect(plan.lastFullyFilled).toBeGreaterThan(0n);
      }
      await wallet.sendCalls(
        await collectBid(wallet, auction, id, true),
        31337,
      );
      // Their unused dollars are back and the Shares their bid bought are theirs: what was spent buys Shares at prices
      // that never passed the top one (0.0016 a Share), so it buys at least that many.
      const shares = await balanceOf(p.shares, bidder);
      const back = await balanceOf(platform.quote, bidder);
      expect(shares).toBeGreaterThan(0n);
      expect(back).toBeGreaterThan(0n);
      const spent = amounts[i] * DOLLAR - back;
      // (The top price is 4 times a start rounded up to a tick grid, so a hair over 0.0016: a millionth of room.)
      expect(shares * 1_600n * 1_000_001n).toBeGreaterThanOrEqual(
        spent * SHARE * 1_000_000n,
      );
      sold += shares;
    }
    // All 250,000,000 Shares were bought between them (a little rounding aside).
    expect(sold).toBeGreaterThan(249_000_000n * SHARE);
    expect(sold).toBeLessThanOrEqual(250_000_000n * SHARE);
    // Nothing is left in the auction but rounding dust of a few millionths of a dollar.
    expect(await balanceOf(platform.quote, auction)).toBeLessThan(10n);
  }, 600_000);
});

/**
 * Milestone 7's chain loop: 10,000 alone, then a second person, then 50,000, then the auction and its pool, driven by
 * the app's own call builders through the app's own wallet (`injectedWallet`) on a real EVM (anvil), with the real
 * contracts from `contracts/next/out`. Every check reads the chain. Run by `scripts/m7-chain-loop.sh`, which starts
 * anvil and sets `M7_ANVIL_RPC`; skipped without it.
 */
import { describe, expect, it } from "vitest";
import { encodeFunctionData } from "../../../packages/creaton-core/src/launchpad/evmAbi.ts";
import {
  chainKeyOf,
  projectIdOf,
} from "../../../packages/creaton-core/src/launchpad/project-chain.ts";
import {
  bidCalls,
  collectCalls,
  finishCall,
  handBackCalls,
} from "../../src/features/market/market-calls";
import {
  buyMoves,
  handBackPaid,
  poolSharePrice,
} from "../../src/features/market/market-math";
import { BID_SUBMITTED, readPool } from "../../src/features/market/use-market";
import { backCalls, openBackingCall } from "../../src/features/money/calls";
import {
  injectedWallet,
  type MoneyWallet,
} from "../../src/features/money/wallet";
import { proposalOf, PROPOSED_TOPIC } from "../../src/features/team/pair";
import {
  directCall,
  giveSharesData,
  handOverData,
  LAUNCHER_READS,
  launchCall,
  makePairCall,
  openAuctionData,
  openRoundData,
  PAIR_READS,
  pairConfirmCall,
  pairProposeCall,
  pairSpendCall,
  TREASURY_READS,
  windDownData,
} from "../../src/features/team/team-calls";
import { teamProblem } from "../../src/features/team/team-copy";
import { readAddress, readWord } from "../../src/features/team/use-team";
import { deployPlatform, mintDollars, type Platform } from "./deploy";
import {
  accounts,
  blockNumber,
  call,
  mine,
  passTime,
  providerFor,
  RPC,
  send,
  waitReceipt,
  word,
} from "./rpc";

const DOLLAR = 1_000_000n;
const SHARE = 10n ** 18n;
const DAY = 86_400;
const data = (
  signature: string,
  types: Parameters<typeof encodeFunctionData>[1] = [],
  values: Parameters<typeof encodeFunctionData>[2] = [],
) => encodeFunctionData(signature, types, values);

const walletOf = (account: string): MoneyWallet =>
  injectedWallet(providerFor(account), { polls: 100, pollMs: 20 });

/** The `round` id a Launcher's `RoundOpened` log in a call's receipt carries (topic 3). */
async function openedRound(hash: string, launcher: string): Promise<bigint> {
  const receipt = await waitReceipt(hash);
  const log = receipt.logs.find(
    (l) => l.address.toLowerCase() === launcher && l.topics.length === 4,
  );
  if (!log) throw new Error("no round opened");
  return BigInt(log.topics[3]);
}

interface Project {
  key: string;
  shares: string;
  treasury: string;
  vester: string;
  finisher: string;
  rounds: string;
}

async function launched(
  platform: Platform,
  founder: string,
  coordinate: string,
): Promise<Project> {
  const wallet = walletOf(founder);
  const projectId = projectIdOf(coordinate);
  const key = chainKeyOf(founder, projectId);
  const hash = await readWord(
    wallet,
    platform.launcher,
    LAUNCHER_READS.launchHash(key),
  );
  await wallet.sendCalls(
    [
      launchCall({
        launcher: platform.launcher,
        projectId,
        name: "Lantern",
        symbol: "LANTERN",
        settingsHash: `0x${hash.toString(16).padStart(64, "0")}`,
      }),
    ],
    31337,
  );
  const words = (
    await call(platform.launcher, LAUNCHER_READS.projectByKey(key))
  )
    .slice(2)
    .match(/.{64}/g) as string[];
  const at = (i: number) => `0x${words[i].slice(24)}`;
  return {
    key,
    shares: at(1),
    treasury: at(2),
    vester: at(3),
    finisher: at(4),
    rounds: at(5),
  };
}

/** Back round `round` with `amount` from each of `backers`, close it after its 24 hours, and deliver everyone's Shares. */
async function backAndClose(
  platform: Platform,
  p: Project,
  round: bigint,
  backers: string[],
  amount: bigint,
  stranger: string,
) {
  for (const backer of backers) {
    await mintDollars(stranger, platform.quote, backer, amount);
    await walletOf(backer).sendCalls(
      backCalls({
        quote: platform.quote,
        rounds: p.rounds,
        round: Number(round),
        amount,
      }),
      31337,
    );
  }
  await passTime(DAY + 60);
  await send(stranger, p.rounds, data("close(uint256)", ["uint256"], [round]));
  for (const backer of backers)
    await send(
      stranger,
      p.rounds,
      data("settle(uint256,address)", ["uint256", "address"], [round, backer]),
    );
}

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
    const confirmLatest = async (
      proposer: MoneyWallet,
      confirmer: MoneyWallet,
      target: string,
      inner: string,
    ) => {
      await proposer.sendCalls([pairProposeCall(pair, target, inner)], 31337);
      const head = await blockNumber();
      const logs = await confirmer.getLogs({
        address: pair,
        topics: [PROPOSED_TOPIC],
        from: Math.max(0, head - 50),
        to: head,
      });
      const proposal = logs
        .map((l) => proposalOf(l, pair))
        .filter((x) => x !== null)
        .pop();
      if (!proposal) throw new Error("no proposal");
      expect(proposal.data).toBe(inner.toLowerCase());
      return confirmer.sendCalls(
        [pairConfirmCall(pair, proposal.target, proposal.data, proposal.nonce)],
        31337,
      );
    };
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
          deadline: BigInt(Math.floor(Date.now() / 1000) + 10 * DAY),
        }),
        31337,
      );
    }
    await mine(endBlock - (await blockNumber()) + 2);

    // Anyone finishes it with the app's three steps; the market is open.
    await walletOf(stranger).sendCalls(
      [
        finishCall(p.finisher, "openPool"),
        finishCall(p.finisher, "settle"),
        finishCall(p.finisher, "sweep"),
      ],
      31337,
    );
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
        collectCalls(auction, BigInt(logs[0].topics[1]), {
          exit: true,
          claim: true,
        }),
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

// The search for a task's payment (`findPayment`) against a fake wallet, no chain. It pins the two halves of the rule on time:
// a payment counts when its block's time is at least `since - SKEW_SECS`, and the search may stop only once a piece starts at
// or before that moment.
import { encodeParameters } from "@creaton/core/launchpad/evmAbi.ts";
import { addressTopic, topicOf } from "@creaton/core/launchpad/work.ts";
import { describe, expect, it } from "vitest";
import type { ChainLog } from "../money/wallet";
import { findPayment, PaymentSearchShort } from "./pay-lookup";

const TREASURY = "0x20b6000000000000000000000000000000000906";
const BOX = "0x00000000000000000000000000000000000000ee";
const PAYEE = "0x00000000000000000000000000000000000000cd";
const RAW = 40_000_000n;
const HASH = `0x${"cd".repeat(32)}`;
const DRAWN = topicOf("AllowanceDrawn(address,address,uint256,uint256)");
/** The acceptance's own clock, and the hour a payment's block may sit before it. */
const SINCE = 1_800_000_000;
const HOUR = 3_600;
/** The newest block: three pieces of ten thousand blocks (15001..25000, 5001..15000, 0..5000). */
const HEAD = 25_000;

function drawAt(block: number, hash = HASH): ChainLog {
  return {
    address: TREASURY,
    topics: [DRAWN, addressTopic(BOX), addressTopic(PAYEE)],
    data: encodeParameters(["uint256", "uint256"], [RAW, 1n]),
    blockNumber: `0x${block.toString(16)}`,
    transactionHash: hash,
  };
}

/** A wallet that holds `logs`, answers a range with the logs inside it, and tells the time of a block by `timeOf`. */
function fakeWallet(logs: ChainLog[], timeOf: (block: number) => number) {
  const ranges: { from: number; to: number }[] = [];
  return {
    ranges,
    wallet: {
      blockNumber: async () => HEAD,
      blockTime: async (block: number | "latest") =>
        timeOf(block === "latest" ? HEAD : block),
      getLogs: async (filter: { from?: number; to?: number }) => {
        const from = filter.from ?? 0;
        const to = filter.to ?? HEAD;
        ranges.push({ from, to });
        return logs.filter((l) => {
          const b = Number(BigInt(l.blockNumber));
          return b >= from && b <= to;
        });
      },
    },
  };
}

const search = (w: Parameters<typeof findPayment>[0]) =>
  findPayment(w, TREASURY, PAYEE, RAW, SINCE);

describe("the stop test and the filter on time", () => {
  it("finds a payment from the hour before the cut that lies in an older piece than the one that starts within an hour after the acceptance", async () => {
    // The newest piece starts half an hour after the acceptance; the payment (made 30 minutes before the cut) is one piece older.
    const { wallet, ranges } = fakeWallet([drawAt(9_000)], (b) => {
      if (b >= 15_001) return SINCE + HOUR / 2;
      if (b === 9_000) return SINCE - HOUR / 2;
      return SINCE - 2 * HOUR;
    });
    const found = await search(wallet);
    expect(found?.txHash).toBe(HASH);
    expect(found?.at).toBe(SINCE - HOUR / 2);
    // It went on past the newest piece to find it.
    expect(ranges).toHaveLength(2);
  });

  it("does not return a payment older than the hour before the acceptance, and counts one exactly at its edge", async () => {
    const tooOld = fakeWallet([drawAt(20_000)], () => SINCE - HOUR - 1);
    expect(await search(tooOld.wallet)).toBeNull();
    const atEdge = fakeWallet([drawAt(20_000)], () => SINCE - HOUR);
    expect((await search(atEdge.wallet))?.txHash).toBe(HASH);
  });

  it("stops, reading no further piece, once a piece starts at or before an hour before the acceptance", async () => {
    // The newest piece starts exactly an hour before the acceptance: nothing older can count.
    const stop = fakeWallet([], () => SINCE - HOUR);
    expect(await search(stop.wallet)).toBeNull();
    expect(stop.ranges).toHaveLength(1);
  });

  it("goes on while a piece starts later than an hour before the acceptance", async () => {
    // One second later than the cut: an older piece may still hold a payment that counts, so it is read, to the very first block.
    const goes = fakeWallet([], () => SINCE - HOUR + 1);
    expect(await search(goes.wallet)).toBeNull();
    expect(goes.ranges.map((r) => r.from)).toEqual([15_001, 5_001, 0]);
  });

  it("says the search is short when a bound is reached before the acceptance", async () => {
    const wallet = { ...fakeWallet([], () => SINCE + 1).wallet };
    const far = { ...wallet, blockNumber: async () => 10_000_000 };
    await expect(search(far)).rejects.toBeInstanceOf(PaymentSearchShort);
  });

  it("does not stop at the first piece when the wallet cannot tell the time of a block: it reads to the first block", async () => {
    // A start whose time is unknown does not count as reaching the acceptance: an older piece may still hold the payment.
    const { wallet, ranges } = fakeWallet([], () => SINCE - 10 * HOUR);
    const { blockTime: _unused, ...noClock } = wallet;
    expect(await search(noClock)).toBeNull();
    expect(ranges.map((r) => r.from)).toEqual([15_001, 5_001, 0]);
  });

  it("finds a payment in an older piece when the wallet cannot tell the time of a block, on amount and wallet alone", async () => {
    const { wallet, ranges } = fakeWallet([drawAt(9_000)], () => SINCE);
    const { blockTime: _unused, ...noClock } = wallet;
    expect((await search(noClock))?.txHash).toBe(HASH);
    // Nothing in the newest piece, and no clock to say that it was enough: the next piece was read.
    expect(ranges).toHaveLength(2);
  });
});

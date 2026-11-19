// How a bid is settled, from the auction's own checkpoint records: the plan is pure, so each case the contract
// distinguishes is pinned here (`tests/anvil/oversubscribed.test.ts` proves the same hints on a real EVM).
import { describe, expect, it } from "vitest";
import { type Checkpoint, planExit, readExitPlan } from "./exit-plan";
import { MARKET_READS } from "./market-calls";

const LAST = (1n << 64n) - 1n;
const cp = (
  block: bigint,
  clearingPrice: bigint,
  next: bigint,
): Checkpoint => ({
  block,
  clearingPrice,
  next,
});
const base = { startBlock: 1_000n, endBlock: 8_200n, graduated: true };
const MAX = 400n;

describe("planExit", () => {
  it("returns every bid whole when the auction did not reach its minimum", () => {
    expect(
      planExit({ ...base, graduated: false, maxPrice: MAX, checkpoints: [] }),
    ).toEqual({ kind: "exit" });
  });

  it("a bid above the final price is settled whole", () => {
    expect(
      planExit({
        ...base,
        maxPrice: MAX,
        checkpoints: [cp(1_000n, 100n, 8_200n), cp(8_200n, 300n, LAST)],
      }),
    ).toEqual({ kind: "exit" });
  });

  it("a bid at exactly the final price was partly filled: the last checkpoint below it, and 0 for the outbid block", () => {
    expect(
      planExit({
        ...base,
        maxPrice: MAX,
        checkpoints: [
          cp(1_000n, 100n, 1_005n),
          cp(1_005n, 250n, 8_200n),
          cp(8_200n, MAX, LAST),
        ],
      }),
    ).toEqual({ kind: "partial", lastFullyFilled: 1_005n, outbid: 0n });
  });

  it("a bid the price rose past is settled with the block it was outbid at", () => {
    expect(
      planExit({
        ...base,
        maxPrice: MAX,
        checkpoints: [
          cp(1_000n, 100n, 1_005n),
          cp(1_005n, 250n, 1_500n),
          cp(1_500n, 500n, 8_200n),
          cp(8_200n, 500n, LAST),
        ],
      }),
    ).toEqual({ kind: "partial", lastFullyFilled: 1_005n, outbid: 1_500n });
  });

  it("is not made before the last checkpoint was written, and says why", () => {
    expect(
      planExit({
        ...base,
        maxPrice: MAX,
        checkpoints: [cp(1_000n, 100n, 5_000n), cp(5_000n, 200n, LAST)],
      }),
    ).toEqual({ kind: "unavailable", reason: "unfinished" });
  });

  it("is never guessed when the records do not fit the bid", () => {
    // The walk does not begin at the bid's own start.
    expect(
      planExit({
        ...base,
        maxPrice: MAX,
        checkpoints: [cp(1_001n, 100n, LAST)],
      }),
    ).toEqual({ kind: "unavailable", reason: "inconsistent" });
    // The price at the start was already at the bid's top price: it could not have been placed.
    expect(
      planExit({
        ...base,
        maxPrice: MAX,
        checkpoints: [cp(1_000n, MAX, LAST)],
      }),
    ).toEqual({ kind: "unavailable", reason: "inconsistent" });
    // A final price above the bid's top with no checkpoint above it in the walk.
    expect(
      planExit({
        ...base,
        maxPrice: MAX,
        checkpoints: [cp(1_000n, 100n, 8_200n), cp(8_200n, 100n, LAST)],
      }).kind,
    ).toBe("exit");
  });
});

const word = (n: bigint) => n.toString(16).padStart(64, "0");

describe("readExitPlan", () => {
  it("stops a checkpoint list that never ends, never reading past its limit", async () => {
    let reads = 0;
    const wallet = {
      readCall: async (_to: string, data: string) => {
        if (data === MARKET_READS.isGraduated) return `0x${word(1n)}`;
        if (data === MARKET_READS.endBlock) return `0x${word(8_200n)}`;
        if (data === MARKET_READS.bid(7n))
          return `0x${word(1_000n)}${word(0n)}${word(0n)}${word(400n)}${word(0n)}${word(1n)}${word(0n)}`;
        reads += 1;
        // Each checkpoint names a later one, for ever.
        const at = BigInt(`0x${data.slice(10)}`);
        return `0x${word(100n)}${word(0n)}${word(0n)}${word(0n)}${word(0n)}${word(at + 1n)}`;
      },
    };
    const plan = await readExitPlan(
      wallet,
      "0xa11c000000000000000000000000000000000a11",
      7n,
    );
    expect(plan).toEqual({ kind: "unavailable", reason: "inconsistent" });
    expect(reads).toBe(512);
  });
});

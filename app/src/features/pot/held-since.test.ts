// How long a person has held Shares, worked out from their own transfers (plan section 2.5): the walk back from the balance,
// the reset by a take-out to nothing, a transfer in that does not move it, the block that is both a receipt and a give-up,
// the pages a node that refuses a wide range is read in, and every read that cannot be finished giving null.
import { describe, expect, it } from "vitest";
import {
  type HeldSince,
  heldLine,
  holdingBlock,
  readHeldSince,
} from "./held-since";

const SHARE = 10n ** 18n;
const move = (block: number, delta: bigint) => ({ block, delta });
const answering =
  (moves: { block: number; delta: bigint }[]) =>
  async (from: number, to: number) =>
    moves.filter((m) => m.block >= from && m.block <= to);

describe("the block in which the present holding began", () => {
  it("is the receipt that came after nothing, and a later transfer in does not move it", async () => {
    const moves = [move(5, 10n * SHARE), move(9, 3n * SHARE)];
    expect(await holdingBlock(13n * SHARE, 20, answering(moves))).toBe(5);
  });

  it("is reset by a take-out to nothing: only the Back after it counts", async () => {
    const moves = [
      move(5, 10n * SHARE),
      move(8, -10n * SHARE),
      move(12, 4n * SHARE),
    ];
    expect(await holdingBlock(4n * SHARE, 20, answering(moves))).toBe(12);
  });

  it("is not reset by a part take-out or by Shares given away that leave some", async () => {
    const moves = [move(5, 10n * SHARE), move(8, -4n * SHARE)];
    expect(await holdingBlock(6n * SHARE, 20, answering(moves))).toBe(5);
  });

  it("takes a block's moves together: in and out in one block is its net", async () => {
    // Block 7 gives up 6 and receives 6 (in either order): the holding that began at block 5 goes on.
    const moves = [
      move(5, 10n * SHARE),
      move(7, 6n * SHARE),
      move(7, -6n * SHARE),
    ];
    expect(await holdingBlock(10n * SHARE, 20, answering(moves))).toBe(5);
  });

  it("is null when the moves do not add up to the balance, or there are none, or the account holds nothing", async () => {
    expect(
      await holdingBlock(20n * SHARE, 20, answering([move(5, 10n * SHARE)])),
    ).toBeNull();
    // Moves that would take the balance below nothing.
    expect(
      await holdingBlock(1n * SHARE, 20, answering([move(5, 10n * SHARE)])),
    ).toBeNull();
    // A block that takes the balance below nothing is not walked on: a later give-up must not make it look like a start.
    expect(
      await holdingBlock(
        1n * SHARE,
        20,
        answering([move(4, -9n * SHARE), move(5, 10n * SHARE)]),
      ),
    ).toBeNull();
    expect(await holdingBlock(5n * SHARE, 20, answering([]))).toBeNull();
    expect(await holdingBlock(0n, 20, answering([]))).toBeNull();
  });

  it("reads in pages, newest first, when the node refuses the whole chain, and stops at the answer", async () => {
    const moves = [move(3_000, 8n * SHARE), move(11_000, 1n * SHARE)];
    const asked: [number, number][] = [];
    const picky = async (from: number, to: number) => {
      asked.push([from, to]);
      if (to - from + 1 > 5_000) throw new Error("range too wide");
      return moves.filter((m) => m.block >= from && m.block <= to);
    };
    expect(await holdingBlock(9n * SHARE, 12_000, picky)).toBe(3_000);
    // The whole chain was tried once; then pages of 5,000 from the newest block back, no further than needed.
    expect(asked[0]).toEqual([0, 12_000]);
    expect(asked[1]).toEqual([7_001, 12_000]);
    expect(asked[2]).toEqual([2_001, 7_000]);
    expect(asked.length).toBe(3);
  });

  it("halves a page the node refuses and gives up on a node that refuses a small one", async () => {
    let calls = 0;
    const refuses = async () => {
      calls += 1;
      throw new Error("no");
    };
    expect(await holdingBlock(1n * SHARE, 1_000_000, refuses)).toBeNull();
    // 5,000 down to 100 by halving: a bounded number of asks, not one per block.
    expect(calls).toBeLessThan(20);
  });

  it("stops after a bounded number of pages", async () => {
    let calls = 0;
    const empty = async (from: number, to: number) => {
      calls += 1;
      if (to - from + 1 > 5_000) throw new Error("range too wide");
      return [];
    };
    expect(await holdingBlock(1n * SHARE, 100_000_000, empty)).toBeNull();
    expect(calls).toBeLessThanOrEqual(41);
  });
});

/** A source and a read for the account, from a list of moves, with block times one minute apart from block 0. */
function scene(options: {
  balance: bigint;
  moves: { block: number; delta: bigint }[];
  unit?: number;
  head?: number;
  noTime?: boolean;
  failTime?: boolean;
}) {
  const head = options.head ?? 100;
  const account = `0x${"a".repeat(40)}`;
  const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
  const TRANSFER_IN = (topics: (string | null)[]) => topics[1] === null;
  const source = {
    blockNumber: async () => head,
    ...(options.noTime
      ? {}
      : {
          blockTime: async (block: number | "latest") => {
            if (options.failTime) throw new Error("no time");
            return 1_000_000 + 60 * (block === "latest" ? head : block);
          },
        }),
    getLogs: async (filter: {
      address: string;
      topics: (string | null)[];
      from: number;
      to: number;
    }) => {
      const mine = `0x${"a".repeat(40).padStart(64, "0")}`;
      const other = `0x${"b".repeat(40).padStart(64, "0")}`;
      return options.moves
        .filter((m) => m.block >= filter.from && m.block <= filter.to)
        .filter((m) => m.delta > 0n === TRANSFER_IN(filter.topics))
        .map((m) => ({
          address: filter.address,
          topics: [
            filter.topics[0] as string,
            m.delta > 0n ? other : mine,
            m.delta > 0n ? mine : other,
          ],
          data: word(m.delta > 0n ? m.delta : -m.delta),
          blockNumber: `0x${m.block.toString(16)}`,
        }));
    },
  };
  const read = async (_to: string, data: string) =>
    // `unit()` has no argument; `balanceOf(address)` has one.
    data.length > 10
      ? word(options.balance)
      : word(BigInt(options.unit ?? 600));
  return {
    source: source as unknown as Parameters<typeof readHeldSince>[0],
    read,
    input: {
      account,
      shares: `0x${"1".repeat(40)}`,
      treasury: `0x${"2".repeat(40)}`,
    },
  };
}

describe("reading the holding from the network", () => {
  it("gives when it began, the network's time now and the unit, from the account's own logs", async () => {
    const s = scene({
      balance: 7n * SHARE,
      moves: [move(10, 5n * SHARE), move(30, 2n * SHARE)],
      unit: 600,
    });
    const held = await readHeldSince(s.source, s.read, s.input);
    expect(held).toEqual({
      since: 1_000_000 + 600,
      now: 1_000_000 + 6_000,
      unit: 600,
    });
  });

  it("gives null when the sender cannot say a block's time, or the time read fails, never a guess", async () => {
    const base = { balance: 5n * SHARE, moves: [move(10, 5n * SHARE)] };
    for (const flaw of [{ noTime: true }, { failTime: true }]) {
      const s = scene({ ...base, ...flaw });
      expect(await readHeldSince(s.source, s.read, s.input)).toBeNull();
    }
  });

  it("gives null for an account that holds nothing, for moves that do not add up, and for a unit of nothing", async () => {
    for (const flaw of [
      { balance: 0n, moves: [move(10, 5n * SHARE)] },
      { balance: 9n * SHARE, moves: [move(10, 5n * SHARE)] },
      { balance: 5n * SHARE, moves: [move(10, 5n * SHARE)], unit: 0 },
    ]) {
      const s = scene(flaw);
      expect(await readHeldSince(s.source, s.read, s.input)).toBeNull();
    }
  });

  it("never throws, whatever the node does", async () => {
    const s = scene({ balance: 5n * SHARE, moves: [move(10, 5n * SHARE)] });
    const broken = {
      ...s.source,
      getLogs: async () => {
        throw new Error("down");
      },
    } as unknown as Parameters<typeof readHeldSince>[0];
    expect(await readHeldSince(broken, s.read, s.input)).toBeNull();
  });
});

describe("the line", () => {
  const held = (since: number, now: number, unit = 604_800): HeldSince => ({
    since,
    now,
    unit,
  });
  it("counts whole units and says weeks, one week once", () => {
    expect(heldLine(held(0, 3 * 604_800 + 5))).toBe(
      "You have held it for 3 weeks.",
    );
    expect(heldLine(held(0, 604_800))).toBe("You have held it for 1 week.");
  });
  it("says the day it began when it is under one unit, never 0 weeks", () => {
    const line = heldLine(held(1_800_000_000, 1_800_000_000 + 604_799));
    expect(line).toMatch(/^You backed .+\.$/);
    expect(line).not.toMatch(/0 weeks|held it/);
  });
  it("uses the project's own unit: a short test-network unit gives weeks of that length", () => {
    expect(heldLine(held(0, 1_680 * 2, 1_680))).toBe(
      "You have held it for 2 weeks.",
    );
  });
  it("has no reward words", () => {
    expect(heldLine(held(0, 5 * 604_800))).not.toMatch(
      /point|badge|streak|keep it going|earn|reward/i,
    );
  });
});

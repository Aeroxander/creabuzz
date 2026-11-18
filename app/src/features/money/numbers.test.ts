import { describe, expect, it } from "vitest";
import {
  BACKER_EVM,
  chainIdentity,
  numbersContent,
} from "../../../tests/helpers/numbers-fixture";
import { mostBack } from "./calls";
import {
  anyRoundUnclosed,
  canLower,
  dollarsText,
  holdingsFor,
  type NumbersEvent,
  openRound,
  parseNumbers,
  projectPriceText,
  type ProjectNumbers,
  receiptsFor,
  refundFor,
  roundState,
  sharesPerDollar,
  sharesText,
} from "./numbers";

const SERVER = "f".repeat(64);
const NOW = 1_800_000_000;
const COORDINATE = `37001:${"b".repeat(64)}:demo`;
const { key } = chainIdentity(COORDINATE);

function record(
  content: unknown,
  overrides: Partial<NumbersEvent> = {},
): NumbersEvent {
  return {
    id: "1".repeat(64),
    pubkey: SERVER,
    kind: 39009,
    created_at: NOW,
    tags: [["d", key]],
    content: JSON.stringify(content),
    ...overrides,
  };
}

const project = { coordinate: COORDINATE, chainKey: key };

function parsed(content: unknown, overrides: Partial<NumbersEvent> = {}) {
  const numbers = parseNumbers(record(content, overrides), SERVER, project);
  if (!numbers || numbers.removed) throw new Error("not parsed");
  return numbers as ProjectNumbers;
}

describe("project numbers", () => {
  it("a round past its 24 hours but not closed is waiting, and keeps a new round from opening (A8)", () => {
    const n = parsed(
      numbersContent({
        coordinate: COORDINATE,
        now: NOW,
        openRound: { openedAgo: 86_400 + 600 },
      }),
    );
    const last = n.rounds[n.rounds.length - 1];
    expect(openRound(n, NOW)).toBeNull();
    expect(roundState(last, NOW)).toBe("waiting");
    expect(roundState(n.rounds[0], NOW)).toBe("closed");
    expect(roundState(last, last.opensAt + 60)).toBe("open");
    expect(anyRoundUnclosed(n)).toBe(true);
  });

  it("at most 77.90 of each 100 can ever come back (A5)", () => {
    expect(mostBack(100_000_000n)).toBe(77_900_000n);
    expect(dollarsText(mostBack(25_000_000n))).toBe("19.47");
  });

  it("reads stage, raised against the cap, rounds, receipts and holders", () => {
    const n = parsed(
      numbersContent({
        coordinate: COORDINATE,
        now: NOW,
        openRound: { openedAgo: 3600 },
      }),
    );
    expect(n.stage.name).toBe("backed");
    expect(n.raised).toEqual({
      total: 2_500_000_000n,
      cap: 10_000_000_000n,
      left: 7_500_000_000n,
    });
    expect(n.rounds.map((r) => r.round)).toEqual([1, 2]);
    expect(openRound(n, NOW)?.round).toBe(2);
    expect(openRound(n, NOW + 86_400)).toBeNull();
    expect(
      receiptsFor(n, [BACKER_EVM.toUpperCase().replace("0X", "0x")]),
    ).toHaveLength(1);
    expect(refundFor(n, 1, BACKER_EVM)?.per100).toBe("58.64");
    expect(holdingsFor(n, [BACKER_EVM])).toEqual({
      held: 300_000_000_000_000_000_000_000n,
      free: 0n,
      listed: true,
    });
  });

  it("believes only the server's own key", () => {
    const content = numbersContent({ coordinate: COORDINATE, now: NOW });
    expect(
      parseNumbers(
        record(content, { pubkey: "e".repeat(64) }),
        SERVER,
        project,
      ),
    ).toBeNull();
    expect(parseNumbers(record(content), null, project)).toBeNull();
  });

  it("ignores numbers that are not this project's launch", () => {
    const content = numbersContent({ coordinate: COORDINATE, now: NOW });
    // The record names no chain key.
    expect(
      parseNumbers(record(content), SERVER, {
        coordinate: COORDINATE,
        chainKey: null,
      }),
    ).toBeNull();
    // Another project's record pointing at this launch.
    expect(
      parseNumbers(record(content), SERVER, {
        coordinate: `37001:${"c".repeat(64)}:demo`,
        chainKey: key,
      }),
    ).toBeNull();
    // A version this app does not know.
    expect(
      parseNumbers(record({ ...content, version: 2 }), SERVER, project),
    ).toBeNull();
  });

  it("flags a cut list and handles a launch that left the chain", () => {
    const content = numbersContent({ coordinate: COORDINATE, now: NOW });
    expect(parsed({ ...content, truncated: true }).truncated).toBe(true);
    expect(
      parseNumbers(record({ version: 1, key, removed: true }), SERVER, project),
    ).toEqual({ removed: true, key });
  });

  it("lets an ask be lowered only in the first 12 hours", () => {
    const n = parsed(
      numbersContent({
        coordinate: COORDINATE,
        now: NOW,
        openRound: { openedAgo: 3600 },
      }),
    );
    const round = openRound(n, NOW);
    if (!round) throw new Error("no round");
    expect(canLower(round, NOW)).toBe(true);
    expect(canLower(round, round.opensAt + 12 * 3600)).toBe(false);
  });

  it("says amounts in plain numbers", () => {
    expect(dollarsText(2_500_000_000n)).toBe("2,500");
    expect(dollarsText(58_639_010n)).toBe("58.63");
    expect(sharesText(7_200_000n * 10n ** 18n)).toBe("7,200,000");
    expect(sharesPerDollar(3_000_000_000_000_000n)).toBe("3,000");
    expect(projectPriceText("333333.33")).toBe("333,333.33");
  });
});

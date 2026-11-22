import { decodeCall } from "@creaton/core/pot/abi-codec.ts";
import {
  COUNCIL_ABI,
  PAIR_ABI,
  TREASURY_ABI,
} from "@creaton/core/pot/abis.generated.ts";
import { drawCall } from "@creaton/core/pot/pot-calls.ts";
import { describe, expect, it } from "vitest";
import {
  BACKER_EVM,
  FOUNDER_EVM,
  STRANGER_EVM,
} from "../../../tests/helpers/numbers-v2-fixture";
import { parsedExample } from "../../../tests/helpers/numbers-v2-parse";
import type { ProjectNumbers } from "./numbers";
import { councilRecord } from "../../../tests/helpers/council-v2-parse";
import { asRunner, asSeat, checkInFor, mayCheckIn, runnerRole } from "./runner";

const PAIR = `0x${"9".repeat(40)}`;
const HASH = `0x${"ab".repeat(32)}`;

/** The example, run by a Pair of two signers instead of one person. */
function pairRun(): ProjectNumbers {
  return {
    ...parsedExample(),
    runner: {
      address: PAIR,
      isPair: true,
      signers: [FOUNDER_EVM, BACKER_EVM],
    },
  };
}

describe("who sends what for a project", () => {
  it("the runner acts alone, a Pair's signer through the Pair, anyone else not at all", () => {
    const alone = parsedExample();
    expect(runnerRole(alone, FOUNDER_EVM)).toEqual({ kind: "alone" });
    expect(runnerRole(alone, BACKER_EVM)).toEqual({ kind: "none" });
    expect(runnerRole(alone, null)).toEqual({ kind: "none" });
    const pair = pairRun();
    expect(runnerRole(pair, BACKER_EVM)).toEqual({
      kind: "signer",
      pair: PAIR,
    });
    expect(runnerRole(pair, STRANGER_EVM)).toEqual({ kind: "none" });
    // The Pair's own address is not a person who can send.
    expect(runnerRole(pair, PAIR)).toEqual({ kind: "alone" });
  });

  it("nobody checks in on a wound-down project", () => {
    const wound = {
      ...parsedExample(),
      windDown: { kind: 1 as const, at: 1 },
    };
    expect(runnerRole(wound, FOUNDER_EVM)).toEqual({ kind: "none" });
    expect(mayCheckIn(wound, FOUNDER_EVM)).toBe(false);
    expect(checkInFor(wound, FOUNDER_EVM, HASH)).toBeNull();
  });

  it("a check-in goes to the Treasury for the runner and to the Pair for its signer, with the record's hash", () => {
    const alone = checkInFor(parsedExample(), FOUNDER_EVM, HASH);
    expect(alone?.to).toBe(parsedExample().contracts.treasury);
    expect(decodeCall(TREASURY_ABI, alone?.data ?? "")).toMatchObject({
      name: "checkIn",
      args: [HASH],
    });
    const viaPair = checkInFor(pairRun(), BACKER_EVM, HASH);
    expect(viaPair?.to).toBe(PAIR);
    expect(decodeCall(PAIR_ABI, viaPair?.data ?? "")).toMatchObject({
      name: "checkIn",
      args: [HASH],
    });
    expect(checkInFor(parsedExample(), BACKER_EVM, HASH)).toBeNull();
    expect(mayCheckIn(parsedExample(), FOUNDER_EVM)).toBe(true);
    expect(mayCheckIn(parsedExample(), BACKER_EVM)).toBe(false);
  });

  it("a runner-only call is sent straight by the runner, proposed by a Pair's signer, and refused to anyone else", () => {
    const treasury = parsedExample().contracts.treasury;
    const inner = drawCall({ treasury, to: STRANGER_EVM, amount: 1_000_000n });
    expect(asRunner(parsedExample(), FOUNDER_EVM, inner)).toEqual({
      call: inner,
      through: "alone",
    });
    const proposed = asRunner(pairRun(), FOUNDER_EVM, inner);
    expect(proposed?.through).toBe("pair");
    expect(proposed?.call.to).toBe(PAIR);
    expect(decodeCall(PAIR_ABI, proposed?.call.data ?? "")).toMatchObject({
      name: "propose",
      args: [treasury, inner.data],
    });
    expect(asRunner(parsedExample(), STRANGER_EVM, inner)).toBeNull();
    expect(asRunner(pairRun(), STRANGER_EVM, inner)).toBeNull();
  });
});

describe("a Council seat's runner-only call", () => {
  /** The example run by a Council of five accounts (milestone 9), read through the lazy parser. */
  const councilRun = () => {
    const numbers = councilRecord("voting");
    if (!numbers.council) throw new Error("the record has no Council");
    return numbers;
  };

  it("is a proposal to the other seats, sent to the Council, and nobody who holds no seat gets one", () => {
    const numbers = councilRun();
    const council = numbers.council;
    if (!council) throw new Error("no Council");
    const inner = drawCall({
      treasury: numbers.contracts.treasury,
      to: STRANGER_EVM,
      amount: 1_000_000n,
    });
    const seat = council.seats[1]?.account;
    if (!seat) throw new Error("the second seat is open");
    const sent = asSeat(numbers, seat, inner);
    expect(sent?.through).toBe("council");
    expect(sent?.call.to).toBe(council.contract);
    expect(decodeCall(COUNCIL_ABI, sent?.call.data ?? "")).toMatchObject({
      name: "propose",
      args: [numbers.contracts.treasury, inner.data],
    });
    // A stranger, and the Council's own address (a contract, not a seat holder), send nothing.
    expect(
      asSeat(numbers, "0x000000000000000000000000000000000000dead", inner),
    ).toBeNull();
    expect(asSeat(numbers, council.contract, inner)).toBeNull();
    expect(asSeat(numbers, null, inner)).toBeNull();
    // A Council seat is not the runner: it never signs alone.
    expect(runnerRole(numbers, seat)).toEqual({ kind: "none" });
    expect(asRunner(numbers, seat, inner)).toBeNull();
  });

  it("nothing is proposed on a project that has wound down", () => {
    const numbers = councilRun();
    const seat = numbers.council?.seats[1]?.account;
    if (!seat) throw new Error("the second seat is open");
    const wound = { ...numbers, windDown: { kind: 1 as const, at: 1 } };
    expect(
      asSeat(
        wound,
        seat,
        drawCall({
          treasury: numbers.contracts.treasury,
          to: STRANGER_EVM,
          amount: 1n,
        }),
      ),
    ).toBeNull();
  });
});

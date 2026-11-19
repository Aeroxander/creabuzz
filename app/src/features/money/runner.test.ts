import { decodeCall } from "@creaton/core/pot/abi-codec.ts";
import { PAIR_ABI, TREASURY_ABI } from "@creaton/core/pot/abis.generated.ts";
import { drawCall } from "@creaton/core/pot/pot-calls.ts";
import { describe, expect, it } from "vitest";
import {
  BACKER_EVM,
  FOUNDER_EVM,
  STRANGER_EVM,
} from "../../../tests/helpers/numbers-v2-fixture";
import { parsedExample } from "../../../tests/helpers/numbers-v2-parse";
import type { ProjectNumbers } from "./numbers";
import { asRunner, checkInFor, mayCheckIn, runnerRole } from "./runner";

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

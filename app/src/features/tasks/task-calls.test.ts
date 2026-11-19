import { describe, expect, it } from "vitest";
import {
  AGENT_DOLLARS_MAX,
  pairSpendCall,
  rawDollars,
  revokeAgentCall,
  setAgentCall,
  treasurySpendCall,
} from "./task-calls";

const TREASURY = "0x20b6000000000000000000000000000000000906";
const PAIR = "0x9a0000000000000000000000000000000000a1b2";
const PAYEE = "0x00000000000000000000000000000000000000cd";
const AGENT = "0x00000000000000000000000000000000000000ab";

// Each pinned against `cast calldata` for the same arguments.
const SPEND_40 =
  "0xaf7d6ca300000000000000000000000000000000000000000000000000000000000000cd0000000000000000000000000000000000000000000000000000000002625a00";
const SET_AGENT_25_5 =
  "0xc4946cf500000000000000000000000000000000000000000000000000000000000000ab00000000000000000000000000000000000000000000000000000000017d78400000000000000000000000000000000000000000000000004563918244f40000";
const REVOKE =
  "0x7da6ac0d00000000000000000000000000000000000000000000000000000000000000ab";

describe("task calls", () => {
  it("pays from the Treasury, or from one Pair signer alone, with the same call", () => {
    expect(treasurySpendCall(TREASURY, PAYEE, 40)).toEqual({
      to: TREASURY,
      data: SPEND_40,
      value: "0x0",
    });
    expect(pairSpendCall(PAIR, PAYEE, 40)).toEqual({
      to: PAIR,
      data: SPEND_40,
      value: "0x0",
    });
    expect(rawDollars(40)).toBe(40_000_000n);
  });

  it("sets an agent's daily limits and switches it off", () => {
    expect(setAgentCall(TREASURY, AGENT, 25, 5n * 10n ** 18n).data).toBe(
      SET_AGENT_25_5,
    );
    expect(revokeAgentCall(TREASURY, AGENT)).toEqual({
      to: TREASURY,
      data: REVOKE,
      value: "0x0",
    });
  });
});

describe("amounts that cannot be sent", () => {
  it("refuses a fraction, a negative and a number too big to count exactly", () => {
    for (const bad of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e20])
      expect(() => rawDollars(bad)).toThrow(RangeError);
    expect(rawDollars(AGENT_DOLLARS_MAX)).toBe(1_000_000_000_000n);
    expect(rawDollars(0)).toBe(0n);
  });
});

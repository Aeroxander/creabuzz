import { describe, expect, it } from "vitest";
import {
  backCalls,
  backingSplit,
  checkInCall,
  claimHeldCall,
  DEFAULT_SHARES_PER_RAW_DOLLAR,
  openBackingCall,
  parseDollars,
  QUOTE_CALL_DATA,
  refundCall,
} from "./calls-v1";

// Addresses in the shape of milestone 5's anvil run; every expected value below is `cast calldata` output.
const ROUNDS = "0x39920000000000000000000000000000000c9ba0";
const QUOTE = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const VESTER = "0x2787000000000000000000000000000000ccb78b";
const TREASURY = "0x20b6000000000000000000000000000000000906";
const LAUNCHER = "0x0165878a594ca255338adfa4d48449f69242eb8f";
const KEY =
  "0x23ae9e81940f353d5fc623414c6b2604fdffc87ac3d53e7f45aa2fbef7804db3";
const BACKER = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";

describe("money calls", () => {
  it("backs a round with approve then ask, in that order", () => {
    const calls = backCalls({
      quote: QUOTE,
      rounds: ROUNDS,
      round: 1,
      amount: 25_000_000n,
    });
    expect(calls).toEqual([
      {
        to: QUOTE,
        value: "0x0",
        data: "0x095ea7b300000000000000000000000039920000000000000000000000000000000c9ba000000000000000000000000000000000000000000000000000000000017d7840",
      },
      {
        to: ROUNDS,
        value: "0x0",
        data: "0x6f941083000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000017d7840",
      },
    ]);
  });

  it("builds refund, take out, check in and the quote read", () => {
    expect(refundCall(ROUNDS, 1).data).toBe(
      "0x278ecde10000000000000000000000000000000000000000000000000000000000000001",
    );
    expect(claimHeldCall(VESTER, 1, BACKER)).toEqual({
      to: VESTER,
      value: "0x0",
      data: "0x299c6b9900000000000000000000000000000000000000000000000000000000000000010000000000000000000000003c44cdddb6a900fa2b585dd299e03d12fa4293bc",
    });
    expect(checkInCall(TREASURY)).toEqual({
      to: TREASURY,
      value: "0x0",
      data: "0x183ff085",
    });
    expect(QUOTE_CALL_DATA).toBe("0x999b93af");
  });

  it("opens backing at exactly 3e15 by default", () => {
    expect(DEFAULT_SHARES_PER_RAW_DOLLAR).toBe(3_000_000_000_000_000n);
    expect(openBackingCall(LAUNCHER, KEY)).toEqual({
      to: LAUNCHER,
      value: "0x0",
      data: "0x6cd5141d23ae9e81940f353d5fc623414c6b2604fdffc87ac3d53e7f45aa2fbef7804db3000000000000000000000000000000000000000000000000000aa87bee538000",
    });
  });

  it("reads typed dollars to 6 decimals, from 1 dollar", () => {
    expect(parseDollars("25")).toEqual({ ok: true, raw: 25_000_000n });
    expect(parseDollars("$1,000.5")).toEqual({ ok: true, raw: 1_000_500_000n });
    expect(parseDollars("0.000001")).toEqual({ ok: false, reason: "small" });
    expect(parseDollars("1.0000001")).toEqual({ ok: false, reason: "format" });
    expect(parseDollars("ten")).toEqual({ ok: false, reason: "format" });
    expect(parseDollars(" ")).toEqual({ ok: false, reason: "empty" });
    expect(parseDollars("0.99")).toEqual({ ok: false, reason: "small" });
    expect(parseDollars("20000")).toEqual({ ok: true, raw: 20_000_000_000n });
  });

  it("splits each 100 into 3, 15 and 82", () => {
    expect(backingSplit(100_000_000n)).toEqual({
      platform: 3_000_000n,
      now: 15_000_000n,
      later: 82_000_000n,
    });
  });
});

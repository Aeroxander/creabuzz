// What people type and what the chain logs, read strictly: a rate in percent a day, a count of Shares, and a Pair's
// `Proposed` log. Anything that is not exactly one of them is nothing, never a guess.
import { encodeParameters } from "@creaton/core/launchpad/evmAbi.ts";
import { topicOf } from "@creaton/core/launchpad/work.ts";
import { describe, expect, it } from "vitest";
import { S } from "../../../tests/helpers/pot-harness";
import { parseRate } from "./AllowanceSheets";
import { parseShares } from "./GrantSheet";
import { proposalOf } from "./use-pair-waiting";

describe("a rate typed as a percent a day", () => {
  it("reads in parts per million", () => {
    expect(parseRate("0.10")).toBe(1_000);
    expect(parseRate("0.1")).toBe(1_000);
    expect(parseRate("0.2%")).toBe(2_000);
    expect(parseRate("1")).toBe(10_000);
    expect(parseRate("0")).toBe(0);
    expect(parseRate("0.0001")).toBe(1);
  });
  it("is nothing when it is not a rate", () => {
    for (const text of [
      "",
      "abc",
      "-1",
      "0.00001",
      "1,5",
      "1e3",
      "0.1.2",
      "1000",
    ])
      expect(parseRate(text), text).toBeNull();
  });
});

describe("Shares typed by a person", () => {
  it("reads whole and part Shares in raw units", () => {
    expect(parseShares("1,500")).toBe(1_500n * S);
    expect(parseShares("0.5")).toBe(S / 2n);
    expect(parseShares("12.000000000000000001")).toBe(12n * S + 1n);
  });
  it("is nothing when it is not a number of Shares", () => {
    for (const text of ["", "x", "-1", "1.0000000000000000001", "1e3", "1..2"])
      expect(parseShares(text), text).toBeNull();
  });
});

describe("a Pair's Proposed log", () => {
  const PAIR = "0x00000000000000000000000000000000000000a1";
  const topic = topicOf("Proposed(bytes32,address,address,bytes,uint256)");
  const id = `0x${"11".repeat(32)}`;
  const by = `0x${"0".repeat(24)}${"22".repeat(20)}`;
  const log = (over: Record<string, unknown> = {}) => ({
    address: PAIR,
    topics: [topic, id, by],
    data: encodeParameters(
      ["address", "bytes", "uint256"],
      [`0x${"33".repeat(20)}`, "0xdeadbeef", 5n],
    ),
    blockNumber: "0x10",
    ...over,
  });
  it("is read into the exact target, data and number that confirming needs", () => {
    expect(proposalOf(log(), PAIR)).toEqual({
      id,
      by: `0x${"22".repeat(20)}`,
      target: `0x${"33".repeat(20)}`,
      data: "0xdeadbeef",
      nonce: 5n,
    });
  });
  it("is nothing for another Pair, another event, or data that does not decode", () => {
    expect(
      proposalOf(log({ address: `0x${"44".repeat(20)}` }), PAIR),
    ).toBeNull();
    expect(proposalOf(log({ topics: [id, id, by] }), PAIR)).toBeNull();
    expect(proposalOf(log({ topics: [topic, "0x12", by] }), PAIR)).toBeNull();
    expect(proposalOf(log({ data: "0x1234" }), PAIR)).toBeNull();
  });
});

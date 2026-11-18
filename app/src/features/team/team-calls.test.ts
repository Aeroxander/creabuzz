import { encodeParameters } from "@creaton/core/launchpad/evmAbi.ts";
import { describe, expect, it } from "vitest";
import { describeProposal, PROPOSED_TOPIC, proposalOf } from "./pair";
import {
  asRunner,
  giveSharesData,
  handOverData,
  LAUNCHER_READS,
  launchCall,
  makePairCall,
  openAuctionData,
  pairCancelCall,
  pairCheckInCall,
  pairConfirmCall,
  pairProposeCall,
  pairSpendCall,
  takeSeatCall,
  windDownData,
} from "./team-calls";

// Every expected value below is `cast calldata` output for the same arguments.
const KEY =
  "0x23ae9e81940f353d5fc623414c6b2604fdffc87ac3d53e7f45aa2fbef7804db3";
const PROJECT_ID =
  "0x5c186cdb2fc8a83f07601478d83a41afffaef603bbff5494414b6fd2cbfa481d";
const FOUNDER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const SECOND = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const TREASURY = "0x20b6000000000000000000000000000000000906";
const LAUNCHER = "0x0165878a594ca255338adfa4d48449f69242eb8f";
const PAIR = "0x9a0000000000000000000000000000000000a1b2";
const GIFT =
  "0x2355183b0000000000000000000000003c44cdddb6a900fa2b585dd299e03d12fa4293bc00000000000000000000000000000000000000000000152d02c7e14af6800000";

describe("team calls", () => {
  it("launches with the project id, name, symbol and the hash the founder read", () => {
    expect(
      launchCall({
        launcher: LAUNCHER,
        projectId: PROJECT_ID,
        name: "Lantern",
        symbol: "LANTERN",
        settingsHash: KEY,
      }).data,
    ).toBe(
      "0x37c625155c186cdb2fc8a83f07601478d83a41afffaef603bbff5494414b6fd2cbfa481d000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000c023ae9e81940f353d5fc623414c6b2604fdffc87ac3d53e7f45aa2fbef7804db300000000000000000000000000000000000000000000000000000000000000074c616e7465726e0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000074c414e5445524e00000000000000000000000000000000000000000000000000",
    );
  });

  it("builds the second seat: offer, accept, and the Pair's address read", () => {
    expect(handOverData(SECOND, true)).toBe(
      "0x9ade9fd30000000000000000000000003c44cdddb6a900fa2b585dd299e03d12fa4293bc0000000000000000000000000000000000000000000000000000000000000001",
    );
    expect(makePairCall(LAUNCHER, KEY, FOUNDER)).toEqual({
      to: LAUNCHER,
      value: "0x0",
      data: "0x18cd62e323ae9e81940f353d5fc623414c6b2604fdffc87ac3d53e7f45aa2fbef7804db300000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c8",
    });
    expect(LAUNCHER_READS.pairAddress(KEY, FOUNDER, SECOND)).toBe(
      "0x8e1bb00823ae9e81940f353d5fc623414c6b2604fdffc87ac3d53e7f45aa2fbef7804db300000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c80000000000000000000000003c44cdddb6a900fa2b585dd299e03d12fa4293bc",
    );
    expect(takeSeatCall(TREASURY).data).toBe("0x3d39ffcf");
  });

  it("builds Give Shares, wind down and the auction's opening", () => {
    expect(giveSharesData(SECOND, 100_000n * 10n ** 18n)).toBe(GIFT);
    expect(windDownData(KEY)).toBe(
      "0xa824057a23ae9e81940f353d5fc623414c6b2604fdffc87ac3d53e7f45aa2fbef7804db3",
    );
    expect(openAuctionData(KEY, 31_691_265_005_800n)).toBe(
      "0xb045c1de23ae9e81940f353d5fc623414c6b2604fdffc87ac3d53e7f45aa2fbef7804db300000000000000000000000000000000000000000000000000001cd2b297d8e8",
    );
  });

  it("builds the Pair's calls: propose, confirm, withdraw, spend alone, check in", () => {
    expect(pairProposeCall(PAIR, TREASURY, GIFT).data).toBe(
      "0x9d48184800000000000000000000000020b6000000000000000000000000000000000906000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000442355183b0000000000000000000000003c44cdddb6a900fa2b585dd299e03d12fa4293bc00000000000000000000000000000000000000000000152d02c7e14af680000000000000000000000000000000000000000000000000000000000000",
    );
    expect(pairConfirmCall(PAIR, TREASURY, GIFT, 3n).data).toBe(
      "0xd868598500000000000000000000000020b60000000000000000000000000000000009060000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000000000442355183b0000000000000000000000003c44cdddb6a900fa2b585dd299e03d12fa4293bc00000000000000000000000000000000000000000000152d02c7e14af680000000000000000000000000000000000000000000000000000000000000",
    );
    expect(pairCancelCall(PAIR, KEY).data).toBe(
      "0xc4d252f523ae9e81940f353d5fc623414c6b2604fdffc87ac3d53e7f45aa2fbef7804db3",
    );
    expect(pairSpendCall(PAIR, SECOND, 500_000_000n).data).toBe(
      "0xaf7d6ca30000000000000000000000003c44cdddb6a900fa2b585dd299e03d12fa4293bc000000000000000000000000000000000000000000000000000000001dcd6500",
    );
    expect(pairCheckInCall(PAIR).data).toBe("0x183ff085");
  });

  it("sends a runner's call straight, a signer's through the Pair, and nobody else's at all", () => {
    const pair = { address: PAIR, first: FOUNDER, second: SECOND };
    const direct = asRunner({
      runner: FOUNDER,
      pair: null,
      me: FOUNDER.toUpperCase().replace("0X", "0x"),
      target: TREASURY,
      data: GIFT,
    });
    expect(direct).toEqual({
      through: "alone",
      call: { to: TREASURY, data: GIFT, value: "0x0" },
    });
    const proposed = asRunner({
      runner: PAIR,
      pair,
      me: SECOND,
      target: TREASURY,
      data: GIFT,
    });
    expect(proposed?.through).toBe("pair");
    expect(proposed?.call).toEqual(pairProposeCall(PAIR, TREASURY, GIFT));
    // A stranger, a signer of a Pair that is not the runner, and no wallet: nothing to send.
    expect(
      asRunner({
        runner: PAIR,
        pair,
        me: TREASURY,
        target: TREASURY,
        data: GIFT,
      }),
    ).toBeNull();
    expect(
      asRunner({
        runner: FOUNDER,
        pair,
        me: SECOND,
        target: TREASURY,
        data: GIFT,
      }),
    ).toBeNull();
    expect(
      asRunner({ runner: PAIR, pair, me: null, target: TREASURY, data: GIFT }),
    ).toBeNull();
  });
});

describe("a Pair's waiting calls", () => {
  const log = (overrides: Partial<Parameters<typeof proposalOf>[0]> = {}) => ({
    address: PAIR,
    topics: [PROPOSED_TOPIC, KEY, `0x${"0".repeat(24)}${FOUNDER.slice(2)}`],
    data: encodeParameters(
      ["address", "bytes", "uint256"],
      [TREASURY, GIFT, 3n],
    ),
    blockNumber: "0x1f",
    ...overrides,
  });

  it("reads the exact target, data and nonce a confirm needs", () => {
    expect(proposalOf(log(), PAIR)).toEqual({
      id: KEY,
      by: FOUNDER,
      target: TREASURY,
      data: GIFT,
      nonce: 3n,
      block: 31,
    });
  });

  it("ignores another contract's logs, other events and broken data", () => {
    expect(proposalOf(log({ address: TREASURY }), PAIR)).toBeNull();
    expect(proposalOf(log({ topics: [KEY, KEY, KEY] }), PAIR)).toBeNull();
    expect(proposalOf(log({ data: "0x1234" }), PAIR)).toBeNull();
  });

  it("names each call it knows and refuses to guess the rest", () => {
    const names = (a: string) => (a === SECOND ? "Sam Second" : "someone");
    expect(describeProposal(GIFT, names)).toEqual({
      kind: "give-shares",
      words: "Give 100,000 Shares to Sam Second",
      names: SECOND,
    });
    expect(describeProposal(windDownData(KEY), names).kind).toBe("wind-down");
    expect(describeProposal(handOverData(SECOND, false), names).words).toBe(
      "Offer the runner seat to Sam Second",
    );
    expect(describeProposal("0xdeadbeef", names).kind).toBe("other");
    // A known selector with arguments that do not read is not described as that call.
    expect(describeProposal("0x2355183b00", names).kind).toBe("other");
  });
});

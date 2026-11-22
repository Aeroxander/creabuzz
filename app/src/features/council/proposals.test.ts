/**
 * The Council's waiting actions: the same `Proposed` log a Pair writes, decoded to its exact target, data and nonce, named
 * in plain words, and filtered by the Council's own `Agreed`, `Withdrawn`, `Executed` and `Cancelled` logs. Nothing here
 * shows a selector, a byte or a contract name.
 */
import { describe, expect, it } from "vitest";
import { encodeCall } from "@creaton/core/pot/abi-codec.ts";
import {
  TREASURY_ABI,
  LAUNCHER_ABI,
} from "@creaton/core/pot/abis.generated.ts";
import { encodeParameters } from "@creaton/core/launchpad/evmAbi.ts";
import { topicOf } from "@creaton/core/launchpad/work.ts";
import type { ChainLog } from "../money/wallet";
import * as proposals from "./proposals";

const COUNCIL = "0xa513e6e4b8a2f1c6c1f0e0e5b9b0a5b8de9c2b41";
const OTHER = "0x0165878a594ca255338adfa4d48449f69242eb8f";
const ME = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const YOU = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const TREASURY = "0x75537828f2ce51be7289709686a69cbfdbb714f1";
const HASH = `0x${"ab".repeat(32)}`;
const KEY = `0x${"11".repeat(32)}`;
const NOBODY = `0x${"00".repeat(20)}`;
const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const nameOf = (address: string) => `name-${address.slice(2, 6)}`;

function proposalLog(
  proposalId: string,
  target: string,
  data: string,
  nonce = 0n,
  address = COUNCIL,
  block = 1,
): ChainLog {
  return {
    address,
    topics: [
      topicOf("Proposed(bytes32,address,address,bytes,uint256)"),
      proposalId,
      `0x${"0".repeat(24)}${ME.slice(2)}`,
    ],
    data: encodeParameters(
      ["address", "bytes", "uint256"],
      [target, data, nonce],
    ),
    blockNumber: `0x${block.toString(16)}`,
  };
}

const stateLog = (
  name: string,
  proposalId: string,
  count: number | null,
): ChainLog => ({
  address: COUNCIL,
  topics: [
    topicOf(
      name === "Executed"
        ? "Executed(bytes32,address)"
        : `${name}(bytes32,address,uint8)`,
    ),
    proposalId,
    `0x${"0".repeat(24)}${ME.slice(2)}`,
  ],
  data:
    count === null
      ? "0x"
      : encodeParameters(["uint8"], [BigInt(count)]).toString(),
  blockNumber: "0x2",
});

const cancelled = (proposalId: string): ChainLog => ({
  address: COUNCIL,
  topics: [topicOf("Cancelled(bytes32)"), proposalId],
  data: "0x",
  blockNumber: "0x2",
});

describe("a proposed Council call is named in plain words", () => {
  const cases: Array<[string, string, string, string]> = [
    [
      "draw",
      encodeCall(TREASURY_ABI, "draw", [YOU, 5_000_000n]),
      "draw",
      `Draw 5 dollars from the allowance to name-3c44`,
    ],
    [
      "check in",
      encodeCall(TREASURY_ABI, "checkIn", [HASH]),
      "checkIn",
      "Check in for the project",
    ],
    [
      "the rate",
      encodeCall(TREASURY_ABI, "setRate", [1_000n]),
      "rate",
      "Change the allowance to 0.1% of the project's money a day",
    ],
    [
      "an announced rate",
      encodeCall(TREASURY_ABI, "proposeRate", [2_500n]),
      "rate",
      "Announce a higher allowance: 0.25% of the project's money a day, from one time unit later",
    ],
    [
      "the door",
      encodeCall(TREASURY_ABI, "setDoor", [false]),
      "door",
      "Shut the door to new backers",
    ],
    [
      "a task",
      encodeCall(TREASURY_ABI, "announceTask", [
        HASH,
        NOBODY,
        1_000_000n,
        200n,
      ]),
      "plan",
      "Plan a task that may cost up to 1 dollars",
    ],
    [
      "a task for one person",
      encodeCall(TREASURY_ABI, "announceTask", [HASH, YOU, 1_000_000n, 200n]),
      "plan",
      "Plan a task that may cost up to 1 dollars, for name-3c44 only",
    ],
    [
      "paying a task",
      encodeCall(TREASURY_ABI, "acceptTask", [3n, 5_000_000n]),
      "accept",
      "Accept task 3 and pay 5 dollars",
    ],
    [
      "a task's money back",
      encodeCall(TREASURY_ABI, "rejectTask", [3n]),
      "reject",
      "Send task 3's money back, paying nobody",
    ],
    [
      "a planned task",
      encodeCall(TREASURY_ABI, "cancelTask", [3n]),
      "cancel",
      "Cancel planned task 3",
    ],
    [
      "a grant",
      encodeCall(TREASURY_ABI, "grantTeam", [YOU, 2n * 10n ** 18n]),
      "grant",
      "Grant 2 Team Shares to name-3c44",
    ],
    [
      "a helper",
      encodeCall(TREASURY_ABI, "authoriseAgent", [YOU]),
      "helper",
      "Let name-3c44 act as a helper",
    ],
    [
      "a helper off",
      encodeCall(TREASURY_ABI, "revokeAgent", [YOU]),
      "helper",
      "Switch name-3c44 off as a helper",
    ],
    [
      "a helper's limits",
      encodeCall(TREASURY_ABI, "setAgent", [YOU, 7_000_000n, 3n * 10n ** 18n]),
      "helper",
      "Set name-3c44's daily limits: 7 dollars and 3 Team Shares",
    ],
  ];

  it("names each action with its own words, never a selector", () => {
    for (const [why, data, kind, sentence] of cases) {
      const described = proposals.councilProposalWords(data, nameOf);
      expect(described.kind, why).toBe(kind);
      expect(described.words, why).toBe(sentence);
    }
    for (const [, data] of cases)
      expect(proposals.actionOf(data)).not.toBe("other");
  });

  it("the Pair's own sentences serve the Council too: the hand-over and the wind-down", () => {
    const handOver = proposals.councilProposalWords(
      encodeCall(TREASURY_ABI, "handOver", [YOU, false]),
      nameOf,
    );
    expect(handOver.kind).toBe("handOver");
    expect(handOver.words).toBe("Offer the runner seat to name-3c44");
    expect(handOver.names).toBe(YOU);
    const windDown = proposals.councilProposalWords(
      encodeCall(LAUNCHER_ABI, "windDown", [KEY]),
      nameOf,
    );
    expect(windDown.kind).toBe("windDown");
    expect(windDown.words).toBe("Wind the project down, for good");
  });

  it("a call it cannot read is named as unknown, never guessed", () => {
    const unknown = proposals.councilProposalWords("0xdeadbeef", nameOf);
    expect(unknown.kind).toBe("other");
    expect(unknown.words).toContain("A call this app cannot describe.");
    // A known selector with unreadable arguments is unknown too.
    const broken = proposals.councilProposalWords(
      `${encodeCall(TREASURY_ABI, "draw", [YOU, 1n]).slice(0, 10)}00`,
      nameOf,
    );
    expect(broken.kind).toBe("other");
  });
});

describe("the waiting list: what the events say still waits", () => {
  const draw = encodeCall(TREASURY_ABI, "draw", [YOU, 5_000_000n]);
  const grant = encodeCall(TREASURY_ABI, "grantTeam", [YOU, 10n ** 18n]);
  const logs = [
    proposalLog(id(1), TREASURY, draw, 0n, COUNCIL, 1),
    proposalLog(id(2), TREASURY, grant, 0n, COUNCIL, 2),
    proposalLog(id(3), TREASURY, draw, 0n, COUNCIL, 3),
    proposalLog(id(4), TREASURY, grant, 0n, COUNCIL, 4),
    // Proposal 1 has two seats' agreement, proposal 2 one, 3 is executed, 4 taken back to nothing.
    stateLog("Agreed", id(1), 1),
    stateLog("Agreed", id(1), 2),
    stateLog("Agreed", id(2), 1),
    stateLog("Agreed", id(3), 2),
    stateLog("Agreed", id(4), 1),
    stateLog("Executed", id(3), null),
    stateLog("Withdrawn", id(4), 0),
    // A proposal from another contract, and a topic that is not a proposal: both ignored.
    proposalLog(id(9), TREASURY, draw, 0n, OTHER),
  ];

  it("lists what still waits, with how many seats agreed, newest first", () => {
    const waiting = proposals.waitingActions({
      logs,
      council: COUNCIL,
      nameOf,
    });
    expect(waiting.map((action) => action.id)).toEqual([id(2), id(1)]);
    expect(waiting.map((action) => action.agreed)).toEqual([1, 2]);
    expect(waiting.map((action) => action.kind)).toEqual(["grant", "draw"]);
    expect(waiting[1]?.words).toBe(
      "Draw 5 dollars from the allowance to name-3c44",
    );
  });

  it("a cancelled proposal leaves the list, and the list is capped at the record's count", () => {
    const withCancel = [...logs, cancelled(id(2))];
    expect(
      proposals
        .waitingActions({ logs: withCancel, council: COUNCIL, nameOf })
        .map((action) => action.id),
    ).toEqual([id(1)]);
    // The record's own waiting count caps the list (a screen shows no more than the server counted).
    expect(
      proposals.waitingActions({ logs, council: COUNCIL, nameOf, limit: 1 }),
    ).toHaveLength(1);
  });

  it("all proposals of the Council are read, newest first, with their exact target, data and nonce", () => {
    const all = proposals.councilProposals(logs, COUNCIL);
    expect(all.map((proposal) => proposal.id)).toEqual([
      id(4),
      id(3),
      id(2),
      id(1),
    ]);
    expect(all[0]).toEqual({
      id: id(4),
      by: ME,
      target: TREASURY,
      data: grant,
      nonce: 0n,
      block: 4,
    });
  });
});

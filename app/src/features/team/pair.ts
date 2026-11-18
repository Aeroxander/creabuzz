/**
 * A Pair's waiting calls, read from the chain (the record of numbers does not carry them): each `Proposed` log decoded
 * into its exact (target, data, nonce), which `confirm` needs, and the inner call described in plain words. Pure.
 */
import {
  decodeParameters,
  selectorOf,
} from "@creaton/core/launchpad/evmAbi.ts";
import { topicOf } from "@creaton/core/launchpad/work.ts";
import { dollarsText, sharesText } from "../money/numbers";
import type { ChainLog } from "../money/wallet";

/** `Proposed(bytes32 indexed id, address indexed by, address target, bytes data, uint256 nonce)`'s topic. */
export const PROPOSED_TOPIC = topicOf(
  "Proposed(bytes32,address,address,bytes,uint256)",
);

export interface Proposal {
  id: string;
  by: string;
  target: string;
  data: string;
  nonce: bigint;
  block: number;
}

const HEX32 = /^0x[0-9a-f]{64}$/;

/** A `Proposed` log as a proposal, or null when it is not one this Pair wrote. */
export function proposalOf(log: ChainLog, pair: string): Proposal | null {
  if (log.address.toLowerCase() !== pair.toLowerCase()) return null;
  const [topic, id, by] = log.topics.map((t) => t.toLowerCase());
  if (topic !== PROPOSED_TOPIC || !id || !by) return null;
  if (!HEX32.test(id) || !HEX32.test(by)) return null;
  try {
    const [target, data, nonce] = decodeParameters(
      ["address", "bytes", "uint256"],
      log.data,
    );
    if (typeof target !== "string" || typeof data !== "string") return null;
    if (typeof nonce !== "bigint") return null;
    return {
      id,
      by: `0x${by.slice(26)}`,
      target: target.toLowerCase(),
      data: data.toLowerCase(),
      nonce,
      block: Number.parseInt(log.blockNumber, 16) || 0,
    };
  } catch {
    return null;
  }
}

/** The kinds of call a Pair may propose that the app knows how to name. */
export type ProposalKind =
  | "open-round"
  | "open-auction"
  | "give-shares"
  | "spend"
  | "hand-over"
  | "wind-down"
  | "other";

const KINDS: Record<string, ProposalKind> = {
  [selectorOf("openRound(bytes32,uint256)")]: "open-round",
  [selectorOf("openAuction(bytes32,uint256)")]: "open-auction",
  [selectorOf("giveShares(address,uint256)")]: "give-shares",
  [selectorOf("spend(address,uint256)")]: "spend",
  [selectorOf("handOver(address,bool)")]: "hand-over",
  [selectorOf("windDown(bytes32)")]: "wind-down",
};

/** What a proposed call does, in a sentence a person can say yes to, and who it names when it names someone. */
export function describeProposal(
  data: string,
  nameOf: (address: string) => string,
): { kind: ProposalKind; words: string; names: string | null } {
  const kind = KINDS[data.slice(0, 10).toLowerCase()] ?? "other";
  const args = `0x${data.slice(10)}`;
  try {
    if (kind === "open-round")
      return { kind, words: "Open a backing round", names: null };
    if (kind === "open-auction")
      return { kind, words: "Open the auction", names: null };
    if (kind === "wind-down")
      return {
        kind,
        words: "Wind the project down, for good",
        names: null,
      };
    if (kind === "give-shares" || kind === "spend") {
      const [to, amount] = decodeParameters(["address", "uint256"], args);
      const who = nameOf(String(to).toLowerCase());
      const howMuch =
        kind === "give-shares"
          ? `${sharesText(amount as bigint)} Shares`
          : `${dollarsText(amount as bigint)} dollars`;
      return {
        kind,
        words: `${kind === "give-shares" ? "Give" : "Pay"} ${howMuch} to ${who}`,
        names: String(to).toLowerCase(),
      };
    }
    if (kind === "hand-over") {
      const [next, leaves] = decodeParameters(["address", "bool"], args);
      const who = nameOf(String(next).toLowerCase());
      return {
        kind,
        words: `Offer the runner seat to ${who}${leaves ? ", and the founder leaves" : ""}`,
        names: String(next).toLowerCase(),
      };
    }
  } catch {
    // A call whose arguments do not read as expected is named as unknown, never guessed.
  }
  return {
    kind: "other",
    words:
      "A call this app cannot describe. Look at it in a block explorer before confirming.",
    names: null,
  };
}

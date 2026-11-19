/**
 * A Pair's waiting calls, read from the chain (the record of numbers does not carry them): each `Proposed` log decoded
 * into its exact (target, data, nonce), which `confirm` needs, and the inner call described in plain words. Pure.
 */
import {
  decodeParameters,
  selectorOf,
} from "@creaton/core/launchpad/evmAbi.ts";
import { topicOf } from "@creaton/core/launchpad/work.ts";
import { DEFAULT_SHARES_PER_RAW_DOLLAR } from "../money/calls-v1";
import { dollarsText, sharesText } from "../money/numbers-v1";
import { priceText, sharePriceFromQ96 } from "../market/market-math";
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

/** The starting price every auction opens at unless a project chose another (`Launcher.salePrices`), in dollars a Share. */
const USUAL_START = 0.0004;

/**
 * The terms of a round or an auction in the sentence the second signer confirms: the price in it is the call's own, and a
 * price other than the usual one is said so, because those terms cannot be changed once the round or auction is open.
 */
function termsOf(kind: "open-round" | "open-auction", args: string): string {
  const [, value] = decodeParameters(["bytes32", "uint256"], args);
  if (typeof value !== "bigint") throw new Error("No terms.");
  if (kind === "open-round") {
    // Raw Shares a raw dollar: 1e12 of them is one Share a dollar.
    const perDollar = Number(value) / 1e12;
    const said = `Open a backing round: 1 dollar buys ${perDollar.toLocaleString("en-US", { maximumFractionDigits: 2 })} Shares`;
    return value === DEFAULT_SHARES_PER_RAW_DOLLAR
      ? said
      : `${said}. This is NOT the usual 3,000 a dollar`;
  }
  const start = sharePriceFromQ96(value);
  const said = `Open the auction starting at ${priceText(start)} dollars a Share`;
  return Math.abs(start - USUAL_START) / USUAL_START < 0.001
    ? said
    : `${said}. This is NOT the usual ${USUAL_START}`;
}

/** What a proposed call does, in a sentence a person can say yes to, and who it names when it names someone. */
export function describeProposal(
  data: string,
  nameOf: (address: string) => string,
): { kind: ProposalKind; words: string; names: string | null } {
  const kind = KINDS[data.slice(0, 10).toLowerCase()] ?? "other";
  const args = `0x${data.slice(10)}`;
  try {
    if (kind === "open-round" || kind === "open-auction")
      return { kind, words: termsOf(kind, args), names: null };
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

/**
 * Reading a deployed `ProposalVault` (`contracts/src/ProposalVault.sol`).
 *
 * The vault keeps no enumerable list of proposals, so the ids come from its
 * `ProposalOpened` events and the rest from `eth_call`. Everything here is
 * pure: `use-proposal-vault.ts` supplies the raw hex, this file says what it
 * means. The decoders are pinned against the contract's ABI shapes in
 * `proposal-vault-read.test.mjs`.
 */

import type { FundingProposal } from "./proposal-funding";

/** `ProposalOpened(bytes32,uint256,uint256,uint64,bytes32)` */
export const TOPIC_PROPOSAL_OPENED =
  "0x9cd43d4d54206b1db39be13b99e79d30c3b6a18061b91c473f095755bb76418a";

const WORD = /^[0-9a-fA-F]{64}$/;

/** One 32-byte ABI word. */
function word(hex: string, index: number, what: string): string {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  const slice = body.slice(index * 64, index * 64 + 64);
  if (!WORD.test(slice)) {
    throw new Error(`${what}: expected a 32-byte word at index ${index}`);
  }
  return `0x${slice.toLowerCase()}`;
}

function quantity(hex: string, index: number, what: string): bigint {
  return BigInt(word(hex, index, what));
}

/**
 * A `ProposalOpened` log: the id is topic 1, the four parameters are the data
 * words in declaration order.
 */
export function parseProposalOpened(log: {
  topics: readonly string[];
  data: string;
}): {
  proposalId: string;
  minAmount: string;
  maxAmount: string;
  deadline: number;
  checkHash: string;
} | null {
  if (log.topics.length < 2) return null;
  if (log.topics[0].toLowerCase() !== TOPIC_PROPOSAL_OPENED) return null;
  const proposalId = `0x${log.topics[1].slice(2).toLowerCase()}`;
  try {
    return {
      proposalId,
      minAmount: quantity(log.data, 0, "minAmount").toString(),
      maxAmount: quantity(log.data, 1, "maxAmount").toString(),
      deadline: Number(quantity(log.data, 2, "deadline")),
      checkHash: word(log.data, 3, "checkHash"),
    };
  } catch {
    return null;
  }
}

/**
 * `proposals(bytes32)` returns the struct's fields as separate words:
 * `minAmount, maxAmount, deadline, checkHash, reserved, escrowed, state`.
 *
 * A state outside the enum is refused rather than read as "open": "open" is
 * the one state where a backer may still commit money, so guessing it from
 * garbage data is how a UI invites a deposit it cannot honour.
 */
export function decodeProposal(
  proposalId: string,
  returnData: string,
): FundingProposal {
  const state = quantity(returnData, 6, "state");
  if (state > 2n) {
    throw new Error(`proposal state: not a ProposalState: ${state}`);
  }
  return {
    id: proposalId,
    checkHash: word(returnData, 3, "checkHash"),
    minAmount: quantity(returnData, 0, "minAmount").toString(),
    maxAmount: quantity(returnData, 1, "maxAmount").toString(),
    deadline: Number(quantity(returnData, 2, "deadline")),
    reserved: quantity(returnData, 4, "reserved").toString(),
    state: state === 1n ? "verified" : state === 2n ? "failed" : "open",
  };
}

/** A single-word uint read: `vouchers(address)`, `tokensAtRisk(address)`. */
export function decodeAmount(returnData: string): string {
  return BigInt(word(returnData, 0, "amount")).toString();
}

/** `backingWeightAt(bytes32,address,uint48)` is a single word too. */
export function decodeWeight(returnData: string): string {
  return decodeAmount(returnData);
}

/** The launch's vault is live when it parses as an address. */
export function isAddress(value: string | null | undefined): boolean {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

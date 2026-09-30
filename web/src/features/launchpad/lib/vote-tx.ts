/**
 * Unsigned majeur governance calldata — the decision-routing spine's
 * mechanics (`docs/agentic-governance-design.md` section 4, S1).
 *
 * The chain is the ledger; this module is the composer. Majeur proposals are
 * ID-HASHED OPERATIONS (Safe-style): the proposal identity is
 * `uint256(keccak256(abi.encode(dao, op, to, value, keccak256(data), nonce,
 * config)))` — which is also how `bumpConfig` invalidates every open
 * proposal and permit at once (the config counter is part of the id).
 *
 * Lifecycle: `openProposal(id)` (N-1 snapshot) -> `castVote(id, support)` ->
 * `state(id)` gates (absolute + bps quorum, minYes floor, FOR > AGAINST) ->
 * `queue(id)` (timelock) -> `executeByVotes(...)`. First votes auto-open.
 *
 * Selectors pinned to `cast sig` (goldens in `vote-tx.test.mjs`); the same
 * pins bind `contracts/script/JourneyGov.s.sol`, which executes this exact
 * flow against a live chain. Nothing here signs — sending stays in the wallet
 * or an agent's key (the `SenderCall` seam).
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

// openProposal(uint256)
export const SELECTOR_OPEN_PROPOSAL = "0x31288f40";
// castVote(uint256,uint8)
export const SELECTOR_CAST_VOTE = "0x56781388";
// queue(uint256)
export const SELECTOR_QUEUE = "0xddf0b009";
// executeByVotes(uint8,address,uint256,bytes,bytes32)
export const SELECTOR_EXECUTE_BY_VOTES = "0xee5b2895";
// proposalId(uint8,address,uint256,bytes,bytes32) — the id view
export const SELECTOR_PROPOSAL_ID = "0x997506ba";
// state(uint256)
export const SELECTOR_STATE = "0x3e4f49e6";
// tallies(uint256) — (forVotes, againstVotes, abstainVotes) (cast sig)
export const SELECTOR_TALLIES = "0x1a32b237";
// delegate(address) on the Shares token — voting-power delegation (A2)
export const SELECTOR_DELEGATE = "0x5c19a95c";
// delegates(address) — who casts this account's votes (defaults to self)
export const SELECTOR_DELEGATES = "0x587cde1e";

/** `castVote` support words (majeur's tally: 1 = for, 0 = against, 2 = abstain). */
export const VOTE_AGAINST = 0;
export const VOTE_FOR = 1;
export const VOTE_ABSTAIN = 2;

/** `ProposalState` in majeur's declaration order — the D6 panel labels. */
export const PROPOSAL_STATES = [
  "Unopened",
  "Active",
  "Queued",
  "Succeeded",
  "Defeated",
  "Expired",
  "Executed",
] as const;

/** One proposal: a hashed operation (op 0 = call, 1 = delegatecall). */
export interface ProposalIntent {
  op: 0 | 1;
  to: string;
  value: bigint | string;
  /** 0x-prefixed calldata of the operation. */
  data: string;
  /** 0x + 64 hex — caller-chosen; part of the id. */
  nonce: string;
}

const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function addressWord(value: string, name: string): string {
  if (!ADDRESS_RE.test(value)) {
    throw new Error(`${name} must be 0x + 40 hex: ${JSON.stringify(value)}`);
  }
  return value.slice(2).toLowerCase().padStart(64, "0");
}

function bytes32Word(value: string, name: string): string {
  if (!BYTES32_RE.test(value)) {
    throw new Error(`${name} must be 0x + 64 hex: ${JSON.stringify(value)}`);
  }
  return value.slice(2).toLowerCase();
}

function uintWord(value: bigint | string | number, name: string): string {
  const n = typeof value === "bigint" ? value : BigInt(value);
  if (n < 0n || n >= 1n << 256n) {
    throw new Error(`${name} must be a uint256: ${value}`);
  }
  return n.toString(16).padStart(64, "0");
}

function dataBytes(value: string): Uint8Array {
  const trimmed = value.trim();
  const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error(`data must be even-length hex: ${JSON.stringify(value)}`);
  }
  return hex.length ? hexToBytes(hex) : new Uint8Array(0);
}

/**
 * The proposal id, computed offline exactly as
 * `Moloch._intentHashId` computes it onchain — including `config`, the bump
 * counter `bumpConfig` increments to invalidate every open proposal at once.
 */
export function computeProposalId(
  dao: string,
  intent: ProposalIntent,
  config: bigint | string,
): string {
  const words =
    addressWord(dao, "dao") +
    uintWord(intent.op, "op") +
    addressWord(intent.to, "to") +
    uintWord(intent.value, "value") +
    bytes32Word(
      `0x${bytesToHex(keccak_256(dataBytes(intent.data)))}`,
      "dataHash",
    ) +
    bytes32Word(intent.nonce, "nonce") +
    uintWord(config, "config");
  return `0x${bytesToHex(keccak_256(hexToBytes(words)))}`;
}

/**
 * The shared `(op, to, value, data, nonce)` argument layout — identical for
 * `proposalId(...)` and `executeByVotes(...)` (both take the same five).
 * Head: op, to, value, offset=0xa0, nonce; tail: data length + padded bytes.
 */
function encodeIntentArgs(intent: ProposalIntent): string {
  const data = dataBytes(intent.data);
  const padded =
    bytesToHex(data) + "0".repeat((64 - ((data.length * 2) % 64)) % 64);
  return (
    uintWord(intent.op, "op") +
    addressWord(intent.to, "to") +
    uintWord(intent.value, "value") +
    "00000000000000000000000000000000000000000000000000000000000000a0" +
    bytes32Word(intent.nonce, "nonce") +
    uintWord(BigInt(data.length), "dataLength") +
    padded
  );
}

/** `openProposal(id)` — fixes the N-1 snapshot and registers the proposal. */
export function encodeOpenProposal(id: bigint | string): string {
  return SELECTOR_OPEN_PROPOSAL + uintWord(id, "id");
}

/** `castVote(id, support)` — 1 for, 0 against, 2 abstain. */
export function encodeCastVote(id: bigint | string, support: number): string {
  if (
    support !== VOTE_AGAINST &&
    support !== VOTE_FOR &&
    support !== VOTE_ABSTAIN
  ) {
    throw new Error(`support must be 0, 1, or 2: ${support}`);
  }
  return SELECTOR_CAST_VOTE + uintWord(id, "id") + uintWord(support, "support");
}

/** `queue(id)` — starts the timelock countdown for a Succeeded proposal. */
export function encodeQueue(id: bigint | string): string {
  return SELECTOR_QUEUE + uintWord(id, "id");
}

/** `executeByVotes(op, to, value, data, nonce)` — execute after votes+timelock. */
export function encodeExecuteByVotes(intent: ProposalIntent): string {
  return SELECTOR_EXECUTE_BY_VOTES + encodeIntentArgs(intent);
}

/** `proposalId(op, to, value, data, nonce)` as an `eth_call` (the view
 *  is authoritative when config is not known offline). */
export function encodeProposalIdView(intent: ProposalIntent): string {
  return SELECTOR_PROPOSAL_ID + encodeIntentArgs(intent);
}

/** `state(id)` as an `eth_call`; decode with `PROPOSAL_STATES[word]`. */
export function encodeStateView(id: bigint | string): string {
  return SELECTOR_STATE + uintWord(id, "id");
}

/** `tallies(id)` as an `eth_call` — the A5 quorum watch's raw votes. */
export function encodeTalliesView(id: bigint | string): string {
  return SELECTOR_TALLIES + uintWord(id, "id");
}

/**
 * `delegate(delegatee)` on the DAO's Shares token (A2 — the delegation
 * surface). Voting power follows the delegate until re-delegated: the
 * delegator can always reclaim by delegating to themselves (majeur's
 * `delegates()` defaults to self), so delegation is REVOCABLE BY DESIGN.
 * Plain delegation only — the vendored majeur has no split delegation.
 */
export function encodeDelegate(delegatee: string): string {
  return SELECTOR_DELEGATE + addressWord(delegatee, "delegatee");
}

/** `delegates(account)` as an `eth_call` — the current delegate (self by default). */
export function encodeDelegatesView(account: string): string {
  return SELECTOR_DELEGATES + addressWord(account, "account");
}

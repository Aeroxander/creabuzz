/**
 * Unsigned majeur governance calldata — the decision-routing spine's
 * mechanics (`docs/agentic-governance-design.md` §4 S1/S2). Desktop copy of
 * `web/src/features/launchpad/lib/vote-tx.ts`, with the same goldens
 * (`voteTx.test.mjs` vectors copied from web's `vote-tx.test.mjs`).
 *
 * The chain is the ledger; this module is the composer. Majeur proposals are
 * ID-HASHED OPERATIONS (Safe-style): the proposal identity is
 * `uint256(keccak256(abi.encode(dao, op, to, value, keccak256(data), nonce,
 * config)))` — which is also how `bumpConfig` invalidates every open
 * proposal and permit at once (the config counter is part of the id).
 *
 * Lifecycle: `openProposal(id)` (N-1 snapshot) -> `castVote(id, support)` ->
 * `state(id)` gates (absolute + bps quorum, minYes floor, FOR > AGAINST) ->
 * `queue(id)` (timelock) -> `executeByVotes(...)`. First votes auto-open
 * (`Moloch.sol:347-352`).
 *
 * Selectors are derived from the canonical signatures via `lib/evmCalls.ts`
 * (the desktop convention — `lib/royalty.ts`) and pinned to `cast sig` in the
 * tests: openProposal `0x31288f40`, castVote `0x56781388`, queue `0xddf0b009`,
 * executeByVotes `0xee5b2895`, proposalId `0x997506ba`, state `0x3e4f49e6`.
 * Nothing here signs — sending stays in the wallet (the `evm_send_transaction`
 * seam).
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import { decodeUint256 } from "@/features/launchpad/lib/chainRpc";
import {
  encodeFunctionData,
  encodeParameters,
  selectorOf,
  type EvmCall,
} from "@/features/launchpad/lib/evmCalls";

// ---------------------------------------------------------------------------
// Canonical signatures and selectors (cross-checked with `cast sig`)
// ---------------------------------------------------------------------------

/** `openProposal(uint256)` — fixes the N-1 snapshot and registers. */
export const SIGNATURE_OPEN_PROPOSAL = "openProposal(uint256)";
/** `castVote(uint256,uint8)` — 1 for, 0 against, 2 abstain. */
export const SIGNATURE_CAST_VOTE = "castVote(uint256,uint8)";
/** `queue(uint256)` — starts the timelock countdown for a Succeeded one. */
export const SIGNATURE_QUEUE = "queue(uint256)";
/** `executeByVotes(uint8,address,uint256,bytes,bytes32)` — post-votes exec. */
export const SIGNATURE_EXECUTE_BY_VOTES =
  "executeByVotes(uint8,address,uint256,bytes,bytes32)";
/** `proposalId(uint8,address,uint256,bytes,bytes32)` — the id view. */
export const SIGNATURE_PROPOSAL_ID =
  "proposalId(uint8,address,uint256,bytes,bytes32)";
/** `state(uint256)` — the ProposalState view that gates every action. */
export const SIGNATURE_STATE = "state(uint256)";

/** Selector of {@link SIGNATURE_OPEN_PROPOSAL} (`cast`: `0x31288f40`). */
export const SELECTOR_OPEN_PROPOSAL = selectorOf(SIGNATURE_OPEN_PROPOSAL);
/** Selector of {@link SIGNATURE_CAST_VOTE} (`cast`: `0x56781388`). */
export const SELECTOR_CAST_VOTE = selectorOf(SIGNATURE_CAST_VOTE);
/** Selector of {@link SIGNATURE_QUEUE} (`cast`: `0xddf0b009`). */
export const SELECTOR_QUEUE = selectorOf(SIGNATURE_QUEUE);
/** Selector of {@link SIGNATURE_EXECUTE_BY_VOTES} (`cast`: `0xee5b2895`). */
export const SELECTOR_EXECUTE_BY_VOTES = selectorOf(SIGNATURE_EXECUTE_BY_VOTES);
/** Selector of {@link SIGNATURE_PROPOSAL_ID} (`cast`: `0x997506ba`). */
export const SELECTOR_PROPOSAL_ID = selectorOf(SIGNATURE_PROPOSAL_ID);
/** Selector of {@link SIGNATURE_STATE} (`cast`: `0x3e4f49e6`). */
export const SELECTOR_STATE = selectorOf(SIGNATURE_STATE);
/** `delegate(address)` on the Shares token — voting-power delegation (A2). */
const SIGNATURE_DELEGATE = "delegate(address)";
/** Selector of {@link SIGNATURE_DELEGATE} (`cast`: `0x5c19a95c`). */
export const SELECTOR_DELEGATE = selectorOf(SIGNATURE_DELEGATE);
/** `delegates(address)` — who casts this account's votes (self by default). */
const SIGNATURE_DELEGATES = "delegates(address)";
/** Selector of {@link SIGNATURE_DELEGATES} (`cast`: `0x587cde1e`). */
export const SELECTOR_DELEGATES = selectorOf(SIGNATURE_DELEGATES);
/** `tallies(uint256)` — (forVotes, againstVotes, abstainVotes) (A5 watch). */
const SIGNATURE_TALLIES = "tallies(uint256)";
/** Selector of {@link SIGNATURE_TALLIES} (`cast`: `0x1a32b237`). */
export const SELECTOR_TALLIES = selectorOf(SIGNATURE_TALLIES);

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

/** One majeur `ProposalState` label. */
export type ProposalState = (typeof PROPOSAL_STATES)[number];

// ---------------------------------------------------------------------------
// Intent validation (shared by the composers and the 47004 record parser)
// ---------------------------------------------------------------------------

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

function requireAddress(value: string, name: string): string {
  if (!ADDRESS_RE.test(value)) {
    throw new Error(`${name} must be 0x + 40 hex: ${JSON.stringify(value)}`);
  }
  return value;
}

function requireBytes32(value: string, name: string): string {
  if (!BYTES32_RE.test(value)) {
    throw new Error(`${name} must be 0x + 64 hex: ${JSON.stringify(value)}`);
  }
  return value;
}

function requireUint(value: bigint | string | number, name: string): bigint {
  const n = typeof value === "bigint" ? value : BigInt(value);
  if (n < 0n || n >= 1n << 256n) {
    throw new Error(`${name} must be a uint256: ${value}`);
  }
  return n;
}

function requireData(value: string): string {
  const trimmed = value.trim();
  const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error(`data must be even-length hex: ${JSON.stringify(value)}`);
  }
  return `0x${hex.toLowerCase()}`;
}

const INTENT_TYPES = [
  "uint8",
  "address",
  "uint256",
  "bytes",
  "bytes32",
] as const;

function intentArgs(
  intent: ProposalIntent,
): [bigint, string, bigint, string, string] {
  return [
    requireUint(intent.op, "op"),
    requireAddress(intent.to, "to"),
    requireUint(intent.value, "value"),
    requireData(intent.data),
    requireBytes32(intent.nonce, "nonce"),
  ];
}

/**
 * Parse and validate an operation shape (the `ProposalIntent` wire form a
 * 47004 record may carry in `content.intent`). Returns null for anything
 * malformed — records without it stay record-only (D8).
 */
export function parseProposalIntent(value: unknown): ProposalIntent | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.to !== "string" || typeof raw.nonce !== "string") return null;
  if (typeof raw.data !== "string") return null;
  if (raw.op !== 0 && raw.op !== 1) return null;
  const valueField = raw.value;
  if (typeof valueField !== "bigint" && typeof valueField !== "string") {
    return null;
  }
  const intent: ProposalIntent = {
    op: raw.op,
    to: raw.to,
    value: valueField,
    data: raw.data,
    nonce: raw.nonce,
  };
  try {
    intentArgs(intent);
  } catch {
    return null;
  }
  return intent;
}

// ---------------------------------------------------------------------------
// Calldata builders
// ---------------------------------------------------------------------------

/**
 * The proposal id, computed offline exactly as
 * `Moloch._intentHashId` computes it onchain — including `config`, the bump
 * counter `bumpConfig` increments to invalidate every open proposal at once.
 * The words are `abi.encode(dao, op, to, value, dataHash, nonce, config)`.
 */
export function computeProposalId(
  dao: string,
  intent: ProposalIntent,
  config: bigint | string,
): string {
  const [op, to, value, data, nonce] = intentArgs(intent);
  const dataHash = `0x${bytesToHex(keccak_256(hexToBytes(data.slice(2))))}`;
  const words = encodeParameters(
    ["address", "uint8", "address", "uint256", "bytes32", "bytes32", "uint64"],
    [
      requireAddress(dao, "dao"),
      op,
      to,
      value,
      dataHash,
      nonce,
      requireUint(config, "config"),
    ],
  );
  return `0x${bytesToHex(keccak_256(hexToBytes(words.slice(2))))}`;
}

/** `openProposal(id)` — fixes the N-1 snapshot and registers the proposal. */
export function encodeOpenProposal(id: bigint | string): string {
  return encodeFunctionData(
    SIGNATURE_OPEN_PROPOSAL,
    ["uint256"],
    [requireUint(id, "id")],
  );
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
  return encodeFunctionData(
    SIGNATURE_CAST_VOTE,
    ["uint256", "uint8"],
    [requireUint(id, "id"), BigInt(support)],
  );
}

/** `queue(id)` — starts the timelock countdown for a Succeeded proposal. */
export function encodeQueue(id: bigint | string): string {
  return encodeFunctionData(
    SIGNATURE_QUEUE,
    ["uint256"],
    [requireUint(id, "id")],
  );
}

/** `executeByVotes(op, to, value, data, nonce)` — execute after votes+timelock. */
export function encodeExecuteByVotes(intent: ProposalIntent): string {
  return encodeFunctionData(
    SIGNATURE_EXECUTE_BY_VOTES,
    INTENT_TYPES,
    intentArgs(intent),
  );
}

/**
 * `proposalId(op, to, value, data, nonce)` as an `eth_call` — shares
 * `executeByVotes`' five-argument layout; the view is authoritative when
 * `config` is not known offline.
 */
export function encodeProposalIdView(intent: ProposalIntent): string {
  return encodeFunctionData(
    SIGNATURE_PROPOSAL_ID,
    INTENT_TYPES,
    intentArgs(intent),
  );
}

/** `state(uint256)` as an `eth_call`; decode with {@link decodeProposalState}. */
export function encodeStateView(id: bigint | string): string {
  return encodeFunctionData(
    SIGNATURE_STATE,
    ["uint256"],
    [requireUint(id, "id")],
  );
}

/**
 * `delegate(delegatee)` on the DAO's Shares token — voting power follows the
 * delegate until re-delegated; the delegator reclaims by delegating to
 * themselves (majeur's `delegates()` defaults to self). Plain delegation
 * only — the vendored majeur has no split delegation.
 */
export function encodeDelegate(delegatee: string): string {
  return encodeFunctionData(
    SIGNATURE_DELEGATE,
    ["address"],
    [requireAddress(delegatee, "delegatee")],
  );
}

/** `delegates(account)` as an `eth_call` — the current delegate. */
export function encodeDelegatesView(account: string): string {
  return encodeFunctionData(
    SIGNATURE_DELEGATES,
    ["address"],
    [requireAddress(account, "account")],
  );
}

/** `tallies(id)` as an `eth_call` — the A5 quorum watch's raw votes. */
export function encodeTalliesView(id: bigint | string): string {
  return encodeFunctionData(
    SIGNATURE_TALLIES,
    ["uint256"],
    [requireUint(id, "id")],
  );
}

/** Decode a `state(id)` return word into its majeur label. */
export function decodeProposalState(returnData: string): ProposalState {
  const index = Number(decodeUint256(returnData));
  const label = PROPOSAL_STATES[index];
  if (label === undefined) {
    throw new Error(`unknown ProposalState word: ${returnData}`);
  }
  return label;
}

// ---------------------------------------------------------------------------
// Lifecycle call composition (the panel's action row)
// ---------------------------------------------------------------------------

/** The panel's onchain actions, in lifecycle order. */
export type ProposalAction =
  | "open"
  | "vote-for"
  | "vote-against"
  | "vote-abstain"
  | "queue"
  | "execute";

/**
 * Compose one lifecycle action as an unsigned call against the DAO.
 * `execute` needs the record to carry the operation (`content.intent`);
 * callers gate it with `state(id)` first (the panel's `renderedActions`).
 */
export function buildProposalActionCall(input: {
  /** The majeur DAO the proposal lives on. */
  dao: string;
  /** The onchain proposal id (decimal or 0x-hex integer string). */
  proposalId: string;
  action: ProposalAction;
  /** Required for `execute` — the recorded operation. */
  intent?: ProposalIntent | null;
}): EvmCall {
  const dao = requireAddress(input.dao, "dao");
  const { proposalId, action } = input;
  switch (action) {
    case "open":
      return { to: dao, data: encodeOpenProposal(proposalId), value: "0x0" };
    case "vote-for":
      return {
        to: dao,
        data: encodeCastVote(proposalId, VOTE_FOR),
        value: "0x0",
      };
    case "vote-against":
      return {
        to: dao,
        data: encodeCastVote(proposalId, VOTE_AGAINST),
        value: "0x0",
      };
    case "vote-abstain":
      return {
        to: dao,
        data: encodeCastVote(proposalId, VOTE_ABSTAIN),
        value: "0x0",
      };
    case "queue":
      return { to: dao, data: encodeQueue(proposalId), value: "0x0" };
    case "execute": {
      if (!input.intent) {
        throw new Error(
          "execute needs the recorded operation (content.intent)",
        );
      }
      return {
        to: dao,
        data: encodeExecuteByVotes(input.intent),
        value: "0x0",
      };
    }
  }
}

/**
 * A DAO's decisions, read from the chain: every proposal it has opened, where it stands, what it would do, and what
 * the wallet looking at it may do about it.
 *
 * The chain is the only source. A proposal the command line opened, an agent opened or a person opened in the app all
 * appear here the same way, because they all emit the same event; its action is read back from the transaction that
 * opened it and checked against the proposal's own id, so a decision is never shown with an action it does not have.
 * Every count is bounded (Review-Proven Rule 4): a DAO with more decisions than the bound shows the newest and says so.
 *
 * The chain is injected, so `decisions.test.mjs` runs the real reader against a fake one.
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import { decodeParameters, encodeFunctionData, selectorOf } from "./evmAbi.ts";
import {
  decodeVotingRules,
  decodeVotingSupport,
  encodeVotingRules,
  encodeVotingSupport,
  type VotingRules,
  type VotingSupport,
} from "./voting-allocation.ts";
import { decodeAddress, decodeWord, encodeCall0, SIGNATURES } from "./work.ts";
import type { WorkChain } from "./workRead.ts";

/** The newest decisions read in one go. */
export const MAX_DECISIONS = 30;
/** How many decisions are read at the same time, so a public RPC is not flooded. */
const READ_CONCURRENCY = 5;

export interface DecisionChain extends WorkChain {
  /** The calldata of the transaction with this hash, or null when the node does not know it. */
  input(txHash: string): Promise<string | null>;
}

/** `ProposalState` in the order the contract declares it. */
export const DECISION_STATES = [
  "Unopened",
  "Active",
  "Queued",
  "Succeeded",
  "Defeated",
  "Expired",
  "Executed",
] as const;
export type DecisionState = (typeof DECISION_STATES)[number];

/** The operation a proposal would carry out: a call (0) or delegatecall (1) with a nonce that makes its id unique. */
export interface DecisionIntent {
  op: 0 | 1;
  to: string;
  value: bigint;
  data: string;
  nonce: string;
}

export interface Decision {
  /** The proposal id: `0x` + 64 hex. */
  id: string;
  state: DecisionState;
  proposer: string;
  /** Unix seconds the proposal was opened. */
  openedAt: number;
  /** Unix seconds it was queued, or 0 when it has not been. */
  queuedAt: number;
  rules: VotingRules | null;
  support: VotingSupport;
  /** What it would do, read back from its opening transaction and verified against its id; null when unavailable. */
  action: DecisionIntent | null;
  openedBy: string | null;
}

export interface DecisionsSnapshot {
  dao: string;
  /** The chain's own clock when this was read. */
  chainTime: number;
  /** The voting policy contract. */
  policy: string;
  /** Shares of voting capacity needed to open a decision. */
  proposalThreshold: bigint;
  /** The connected wallet's voting capacity, or null with no wallet. */
  walletCapacity: bigint | null;
  /** Newest first. */
  decisions: Decision[];
  /** How many decisions the DAO has opened in all. */
  total: number;
  truncated: boolean;
}

export const SIGNATURES_DECISIONS = {
  count: "getProposalCount()",
  idAt: "proposalIds(uint256)",
  state: "state(uint256)",
  proposer: "proposerOf(uint256)",
  createdAt: "createdAt(uint256)",
  queuedAt: "queuedAt(uint256)",
  threshold: "proposalThreshold()",
  capacity: "capacity(address)",
  proposalId: "proposalId(uint8,address,uint256,bytes,bytes32)",
  open: "openProposalWithAction(uint8,address,uint256,bytes,bytes32)",
  opened: "Opened(uint256,uint48,uint256)",
} as const;

const word = (value: bigint) => value.toString(16).padStart(64, "0");
const idTopic = (id: bigint) => `0x${word(id)}`;

/** The event topic of `Opened(uint256 indexed id, uint48, uint256)`. */
export const TOPIC_OPENED = `0x${bytesToHex(keccak_256(utf8ToBytes(SIGNATURES_DECISIONS.opened)))}`;

function call1(signature: string, id: bigint): string {
  return `${selectorOf(signature)}${word(id)}`;
}

/** Candidate actions in an opening transaction's calldata: the proposal call may be inside a wallet's own wrapper. */
export function openedIntentsIn(input: string): DecisionIntent[] {
  const hex = input.replace(/^0x/, "").toLowerCase();
  const selector = selectorOf(SIGNATURES_DECISIONS.open).slice(2).toLowerCase();
  const found: DecisionIntent[] = [];
  for (
    let at = hex.indexOf(selector);
    at !== -1 && found.length < 4;
    at = hex.indexOf(selector, at + 1)
  ) {
    if (at % 2 !== 0) continue;
    try {
      const [op, to, value, data, nonce] = decodeParameters(
        ["uint8", "address", "uint256", "bytes", "bytes32"],
        `0x${hex.slice(at + selector.length)}`,
      ) as [bigint, string, bigint, string, string];
      if (op > 1n) continue;
      found.push({ op: Number(op) as 0 | 1, to, value, data, nonce });
    } catch {
      // Not an encoding of the call after all: keep looking.
    }
  }
  return found;
}

/** The DAO call that answers a decision's id for an intent, so a record can name a vote before it is opened. */
export function proposalIdCall(intent: DecisionIntent): string {
  return encodeFunctionData(
    SIGNATURES_DECISIONS.proposalId,
    ["uint8", "address", "uint256", "bytes", "bytes32"],
    [BigInt(intent.op), intent.to, intent.value, intent.data, intent.nonce],
  );
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index] as T);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return out;
}

const SUPPORT_NONE: VotingSupport = {
  yes: 0n,
  no: 0n,
  abstain: 0n,
  qualifiedSince: 0n,
};

/** The opening log of a proposal, as far as a decision read needs it. */
type OpenedLog = { transactionHash?: unknown };

/**
 * Every proposal's opening log in one query, by proposal id. Asking once per decision made a DAO with thirty decisions
 * thirty log queries (each of them paged on a node that caps the block range), which is what made the list slow to
 * appear on a public node. Null when the one query fails: each decision then asks for its own, as it always did.
 */
async function readOpenedLogs(
  chain: DecisionChain,
  dao: string,
): Promise<Map<string, OpenedLog> | null> {
  try {
    const logs = await chain.logs({ address: dao, topics: [TOPIC_OPENED] });
    const byId = new Map<string, OpenedLog>();
    for (const log of logs as (OpenedLog & { topics?: string[] })[]) {
      const id = log.topics?.[1];
      if (typeof id === "string") byId.set(id.toLowerCase(), log);
    }
    return byId;
  } catch {
    return null;
  }
}

async function readDecision(
  chain: DecisionChain,
  dao: string,
  id: bigint,
  opened: Map<string, OpenedLog> | null,
): Promise<Decision> {
  const idHex = `0x${word(id)}`;
  const [
    stateHex,
    proposerHex,
    createdHex,
    queuedHex,
    rulesHex,
    supportHex,
    logs,
  ] = await Promise.all([
    chain.call(dao, call1(SIGNATURES_DECISIONS.state, id)),
    chain.call(dao, call1(SIGNATURES_DECISIONS.proposer, id)),
    chain.call(dao, call1(SIGNATURES_DECISIONS.createdAt, id)),
    chain.call(dao, call1(SIGNATURES_DECISIONS.queuedAt, id)),
    chain.call(dao, encodeVotingRules(idHex)),
    chain.call(dao, encodeVotingSupport(idHex)),
    opened
      ? Promise.resolve([opened.get(idHex.toLowerCase())].filter(Boolean))
      : chain.logs({ address: dao, topics: [TOPIC_OPENED, idTopic(id)] }),
  ]);
  const state = DECISION_STATES[Number(decodeWord(stateHex))] ?? "Unopened";

  let action: DecisionIntent | null = null;
  let openedBy: string | null = null;
  const log = logs[0] as { transactionHash?: unknown } | undefined;
  if (typeof log?.transactionHash === "string") {
    openedBy = log.transactionHash;
    const input = await chain.input(log.transactionHash);
    if (input) {
      for (const candidate of openedIntentsIn(input)) {
        // The proposal's own id is the proof: an action that does not hash to it is not this proposal's.
        const computed = decodeWord(
          await chain.call(dao, proposalIdCall(candidate)),
        );
        if (computed === id) {
          action = candidate;
          break;
        }
      }
    }
  }
  return {
    id: idHex,
    state,
    proposer: decodeAddress(proposerHex),
    openedAt: Number(decodeWord(createdHex)),
    queuedAt: Number(decodeWord(queuedHex)),
    rules: decodeVotingRules(rulesHex),
    support:
      supportHex.length > 2 ? decodeVotingSupport(supportHex) : SUPPORT_NONE,
    action,
    openedBy,
  };
}

/** A DAO's decisions, newest first, and what the connected wallet may do about them. */
export async function readDecisions(
  chain: DecisionChain,
  dao: string,
  wallet: string | null,
): Promise<DecisionsSnapshot> {
  const [chainTime, policyHex, thresholdHex, countHex] = await Promise.all([
    chain.now(),
    chain.call(dao, encodeCall0(SIGNATURES.policy)),
    chain.call(dao, encodeCall0(SIGNATURES_DECISIONS.threshold)),
    chain.call(dao, encodeCall0(SIGNATURES_DECISIONS.count)),
  ]);
  const policy = decodeAddress(policyHex);
  const total = Number(decodeWord(countHex));
  const first = Math.max(0, total - MAX_DECISIONS);
  const indexes = Array.from(
    { length: total - first },
    (_, i) => total - 1 - i,
  );
  const ids = await mapLimit(indexes, READ_CONCURRENCY, async (index) =>
    decodeWord(
      await chain.call(dao, call1(SIGNATURES_DECISIONS.idAt, BigInt(index))),
    ),
  );
  const opened = ids.length > 0 ? await readOpenedLogs(chain, dao) : null;
  const decisions = await mapLimit(ids, READ_CONCURRENCY, (id) =>
    readDecision(chain, dao, id, opened),
  );
  const walletCapacity = wallet
    ? decodeWord(
        await chain.call(
          policy,
          encodeFunctionData(
            SIGNATURES_DECISIONS.capacity,
            ["address"],
            [wallet],
          ),
        ),
      )
    : null;
  return {
    dao,
    chainTime,
    policy,
    proposalThreshold: decodeWord(thresholdHex),
    walletCapacity,
    decisions,
    total,
    truncated: total > MAX_DECISIONS,
  };
}

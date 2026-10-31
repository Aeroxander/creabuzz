/**
 * Outside money behind a work area (N1, `contracts/src/WorkAreaBounty.sol`): what a bounty looks like on chain, where it
 * stands, and the calls that open, fund, settle and refund it.
 *
 * A bounty pays its whole pot to the contributor of the first submission that settles: one bound to the work area,
 * released by the reviewers between the bounty's opening and its deadline, still approved (or paid) once its challenge
 * window is over. If nothing settles before `refundsFrom`, each funder takes back their own money.
 *
 * Pure apart from the reader, whose chain is injected (`workBounty.test.mjs` runs it against a fake one). The encoders
 * are pinned against `cast calldata` in the same test.
 */

import { encodeFunctionData } from "./evmAbi.ts";
import {
  type ClaimView,
  addressTopic,
  decodeWord,
  encodeCall0,
  topicOf,
} from "./work.ts";
import { readCurrency, type WorkChain } from "./workRead.ts";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const WORD_RE = /^0x[0-9a-fA-F]{64}$/;

/** At most this many bounties are read for one DAO; more are reported as truncated, never silently cut. */
export const MAX_BOUNTIES = 50;

export const BOUNTY_SIGNATURES = {
  open: "open(address,bytes32,uint64,uint256)",
  fund: "fund(uint256,uint256)",
  settle: "settle(uint256,bytes32)",
  refund: "refund(uint256,address)",
  bounties: "bounties(uint256)",
  fundedBy: "fundedBy(uint256,address)",
  currency: "currency()",
  approve: "approve(address,uint256)",
  allowance: "allowance(address,address)",
  balanceOf: "balanceOf(address)",
} as const;

export const TOPIC_BOUNTY_OPENED = topicOf(
  "BountyOpened(uint256,address,bytes32,address,uint64,uint64)",
);
export const TOPIC_BOUNTY_FUNDED = topicOf(
  "Funded(uint256,address,uint256,uint256)",
);

function assertAddress(value: string, what: string): void {
  if (!ADDRESS_RE.test(value)) throw new Error(`not an address (${what})`);
}

function assertWord(value: string, what: string): void {
  if (!WORD_RE.test(value)) throw new Error(`not a 32-byte word (${what})`);
}

function assertAmount(value: bigint): void {
  if (value <= 0n || value >= 1n << 128n) {
    throw new Error("the amount must be above zero");
  }
}

// ---- calls ---------------------------------------------------------------------------------

/** Open a bounty on work area `projectId` of work budget `mandate`, paying a submission released by `deadline`. */
export function encodeOpenBounty(
  mandate: string,
  projectId: string,
  deadline: number,
  amount: bigint,
): string {
  assertAddress(mandate, "work budget");
  assertWord(projectId, "work area");
  if (!Number.isSafeInteger(deadline) || deadline <= 0) {
    throw new Error("the deadline must be a time in seconds");
  }
  assertAmount(amount);
  return encodeFunctionData(
    BOUNTY_SIGNATURES.open,
    ["address", "bytes32", "uint64", "uint256"],
    [mandate, projectId, BigInt(deadline), amount],
  );
}

export function encodeFundBounty(id: bigint, amount: bigint): string {
  assertAmount(amount);
  return encodeFunctionData(
    BOUNTY_SIGNATURES.fund,
    ["uint256", "uint256"],
    [id, amount],
  );
}

export function encodeSettleBounty(id: bigint, claimId: string): string {
  assertWord(claimId, "submission");
  return encodeFunctionData(
    BOUNTY_SIGNATURES.settle,
    ["uint256", "bytes32"],
    [id, claimId],
  );
}

export function encodeRefundBounty(id: bigint, funder: string): string {
  assertAddress(funder, "funder");
  return encodeFunctionData(
    BOUNTY_SIGNATURES.refund,
    ["uint256", "address"],
    [id, funder],
  );
}

/** Let the bounty contract take `amount` of the currency from the sender, the step before opening or funding. */
export function encodeApproveBounty(spender: string, amount: bigint): string {
  assertAddress(spender, "bounty contract");
  return encodeFunctionData(
    BOUNTY_SIGNATURES.approve,
    ["address", "uint256"],
    [spender, amount],
  );
}

export function encodeAllowance(owner: string, spender: string): string {
  assertAddress(owner, "owner");
  assertAddress(spender, "spender");
  return encodeFunctionData(
    BOUNTY_SIGNATURES.allowance,
    ["address", "address"],
    [owner, spender],
  );
}

export function encodeBalanceOf(owner: string): string {
  assertAddress(owner, "owner");
  return encodeFunctionData(BOUNTY_SIGNATURES.balanceOf, ["address"], [owner]);
}

// ---- reads, decoded --------------------------------------------------------------------------

export interface BountyRecord {
  mandate: string;
  openedAt: number;
  deadline: number;
  projectId: string;
  /** The work budget's challenge window when the bounty opened, in seconds. */
  window: number;
  refundsFrom: number;
  total: bigint;
  refunded: bigint;
  /** The submission that was paid, or null. */
  paidClaim: string | null;
  contributor: string | null;
}

const wordsOf = (hex: string): bigint[] => {
  const body = hex.replace(/^0x/, "");
  const out: bigint[] = [];
  for (let i = 0; i + 64 <= body.length; i += 64) {
    out.push(BigInt(`0x${body.slice(i, i + 64)}`));
  }
  return out;
};
const addressOf = (word: bigint): string =>
  `0x${word.toString(16).padStart(40, "0")}`;
const bytes32Of = (word: bigint): string =>
  `0x${word.toString(16).padStart(64, "0")}`;
const idTopic = (id: bigint): string => bytes32Of(id);

/** `bounties(uint256)`: ten words. Null for a bounty that does not exist or a reply that is not one. */
export function decodeBounty(hex: string): BountyRecord | null {
  const w = wordsOf(hex);
  if (w.length < 10 || w[0] === 0n) return null;
  return {
    mandate: addressOf(w[0]),
    openedAt: Number(w[1]),
    deadline: Number(w[2]),
    projectId: bytes32Of(w[3]),
    window: Number(w[4]),
    refundsFrom: Number(w[5]),
    total: w[6],
    refunded: w[7],
    paidClaim: w[8] === 0n ? null : bytes32Of(w[8]),
    contributor: w[9] === 0n ? null : addressOf(w[9]),
  };
}

interface LogLike {
  topics?: unknown;
  data?: unknown;
}

interface BountyOpened {
  id: bigint;
  mandate: string;
  projectId: string;
  opener: string;
}

function decodeBountyOpened(log: LogLike): BountyOpened | null {
  const t = Array.isArray(log.topics) ? (log.topics as unknown[]) : [];
  if (
    t.length !== 4 ||
    t[0] !== TOPIC_BOUNTY_OPENED ||
    t.some((x) => typeof x !== "string") ||
    typeof log.data !== "string"
  ) {
    return null;
  }
  const w = wordsOf(log.data);
  if (w.length < 3) return null;
  return {
    id: BigInt(t[1] as string),
    mandate: addressOf(BigInt(t[2] as string)),
    projectId: bytes32Of(BigInt(t[3] as string)),
    opener: addressOf(w[0]),
  };
}

/** The funder of one `Funded` log, or null for a log that is not one. */
function decodeFundedFunder(log: LogLike): string | null {
  const t = Array.isArray(log.topics) ? (log.topics as unknown[]) : [];
  if (
    t.length !== 3 ||
    t[0] !== TOPIC_BOUNTY_FUNDED ||
    typeof t[2] !== "string"
  ) {
    return null;
  }
  return addressOf(BigInt(t[2]));
}

// ---- where a bounty stands ---------------------------------------------------------------------

export type BountyStage =
  /** It paid `contributor` for `claimId`. */
  | { kind: "paid"; claimId: string; contributor: string }
  /** Nothing settled in time: each funder can take back their own money. */
  | { kind: "refunds" }
  /** A submission qualifies now: anyone can pay it the pot. */
  | { kind: "payable"; claimId: string; contributor: string }
  /** A submission was released and is waiting out its challenge window, until `payableAt`. */
  | {
      kind: "in-window";
      claimId: string;
      contributor: string;
      payableAt: number;
    }
  /** Still taking money, and nothing has been released for it yet. */
  | { kind: "open" }
  /** The deadline passed with nothing released in time: refunds open at `refundsFrom`. */
  | { kind: "waiting"; refundsFrom: number };

/** A submission the bounty would pay once its window is over: bound to its work area, released while it was open, accepted. */
function counts(bounty: BountyRecord, claim: ClaimView): boolean {
  const { status, releasedAt } = claim.record;
  return (
    claim.project !== null &&
    claim.project.toLowerCase() === bounty.projectId.toLowerCase() &&
    (status === "Approved" || status === "Paid") &&
    releasedAt > 0 &&
    releasedAt >= bounty.openedAt &&
    releasedAt <= bounty.deadline
  );
}

/**
 * Where `bounty` stands at chain time `now`, given the submissions of its work budget. It follows the contract's own
 * order: a paid bounty stays paid; at `refundsFrom` refunds open and nothing can be settled any more; before that the
 * earliest qualifying submission is payable once its window is over.
 */
export function bountyStage(
  bounty: BountyRecord,
  claims: readonly ClaimView[],
  now: number,
): BountyStage {
  if (bounty.paidClaim !== null) {
    return {
      kind: "paid",
      claimId: bounty.paidClaim,
      contributor: bounty.contributor ?? "",
    };
  }
  if (now >= bounty.refundsFrom) return { kind: "refunds" };
  const candidates = claims
    .filter((claim) => counts(bounty, claim))
    .sort((a, b) => a.record.releasedAt - b.record.releasedAt);
  const ready = candidates.find(
    (claim) => now >= claim.record.releasedAt + bounty.window,
  );
  if (ready) {
    return {
      kind: "payable",
      claimId: ready.id,
      contributor: ready.record.contributor,
    };
  }
  const first = candidates[0];
  if (first) {
    return {
      kind: "in-window",
      claimId: first.id,
      contributor: first.record.contributor,
      payableAt: first.record.releasedAt + bounty.window,
    };
  }
  if (now < bounty.deadline) return { kind: "open" };
  return { kind: "waiting", refundsFrom: bounty.refundsFrom };
}

/** Whether `bounty` still takes money at chain time `now`: before its deadline and before it paid. */
export function bountyTakesMoney(bounty: BountyRecord, now: number): boolean {
  return bounty.paidClaim === null && now < bounty.deadline;
}

// ---- the reader ---------------------------------------------------------------------------------

export interface BountyView {
  id: bigint;
  record: BountyRecord;
  opener: string;
  /** How many different wallets put money in. */
  funders: number;
  /** What the connected wallet put in and has not taken back (0 without a wallet). */
  walletFunded: bigint;
}

export interface WorkBounties {
  /** The bounty contract read. */
  contract: string;
  currency: {
    address: string;
    symbol: string;
    decimals: number;
    decimalsKnown: boolean;
  };
  bounties: BountyView[];
  /** The connected wallet's balance of the currency; null without a wallet. */
  walletBalance: bigint | null;
  truncated: boolean;
}

/** Every bounty on the work budgets `mandates`, newest last, bounded by `MAX_BOUNTIES`. */
export async function readWorkBounties(
  chain: WorkChain,
  contract: string,
  mandates: readonly string[],
  wallet: string | null,
): Promise<WorkBounties> {
  const currencyAddress = addressOf(
    decodeWord(
      await chain.call(contract, encodeCall0(BOUNTY_SIGNATURES.currency)),
    ),
  );
  const [currency, walletBalance, openedLogs] = await Promise.all([
    readCurrency(chain, currencyAddress),
    wallet
      ? chain
          .call(currencyAddress, encodeBalanceOf(wallet))
          .then((hex) => decodeWord(hex))
      : Promise.resolve(null),
    Promise.all(
      mandates.map((mandate) =>
        chain.logs({
          address: contract,
          topics: [TOPIC_BOUNTY_OPENED, null, addressTopic(mandate)],
        }),
      ),
    ),
  ]);
  const opened = openedLogs
    .flat()
    .flatMap((log) => {
      const decoded = decodeBountyOpened(log as LogLike);
      return decoded ? [decoded] : [];
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const truncated = opened.length > MAX_BOUNTIES;
  const bounties = (
    await Promise.all(
      opened.slice(-MAX_BOUNTIES).map(async (o): Promise<BountyView | null> => {
        const [recordHex, fundedLogs, walletHex] = await Promise.all([
          chain.call(
            contract,
            encodeFunctionData(BOUNTY_SIGNATURES.bounties, ["uint256"], [o.id]),
          ),
          chain.logs({
            address: contract,
            topics: [TOPIC_BOUNTY_FUNDED, idTopic(o.id)],
          }),
          wallet
            ? chain.call(
                contract,
                encodeFunctionData(
                  BOUNTY_SIGNATURES.fundedBy,
                  ["uint256", "address"],
                  [o.id, wallet],
                ),
              )
            : Promise.resolve("0x0"),
        ]);
        const record = decodeBounty(recordHex);
        if (!record) return null;
        const funders = new Set(
          fundedLogs.flatMap((log) => {
            const funder = decodeFundedFunder(log as LogLike);
            return funder ? [funder.toLowerCase()] : [];
          }),
        );
        return {
          id: o.id,
          record,
          opener: o.opener,
          funders: funders.size,
          walletFunded: decodeWord(walletHex),
        };
      }),
    )
  ).flatMap((b) => (b ? [b] : []));
  return {
    contract,
    currency: { address: currencyAddress, ...currency },
    bounties,
    walletBalance,
    truncated,
  };
}

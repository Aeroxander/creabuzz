/**
 * Bounties on posts (N2, `contracts/src/OpenBounty.sol`, specified in docs/v3-review/OPEN-BOUNTY-STATES.md): what a
 * bounty looks like on chain, where it stands, what the connected wallet can do with it, and the calls that do it.
 *
 * Pure apart from the reader, whose chain is injected (`openBounty.test.mjs` runs it against a fake one). The encoders
 * are pinned against `cast calldata` in the same test.
 */

import { decodeParameters, encodeFunctionData } from "./evmAbi.ts";
import { decodeWord, encodeCall0, topicOf } from "./work.ts";
import { encodeBalanceOf } from "./workBounty.ts";
import { readCurrency, type WorkChain } from "./workRead.ts";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const WORD_RE = /^0x[0-9a-fA-F]{64}$/;

/** How long a claim must keep its majority before it can be paid. */
export const RUN = 9 * 86_400;
/** The first part of a run, worded "agreeing". */
export const AGREE = 2 * 86_400;
/** How long after the latest a run could be paid it can still be paid. */
export const PAY_GRACE = 14 * 86_400;
/** The furthest a deadline can be from opening. */
export const MAX_LENGTH = 365 * 86_400;
/** The longest words or evidence, in bytes. */
export const MAX_TEXT = 1000;
/** At most this many bounties are read for one post, and this many claims for one bounty; more are reported. */
export const MAX_POST_BOUNTIES = 10;
export const MAX_POST_CLAIMS = 200;

export const OPEN_BOUNTY_SIGNATURES = {
  open: "open(bytes32,string,uint64,uint256)",
  fund: "fund(uint256,uint256)",
  fileClaim: "fileClaim(uint256,string)",
  withdrawClaim: "withdrawClaim(uint256)",
  back: "back(uint256,uint32)",
  unback: "unback(uint256)",
  start: "start(uint256,uint32)",
  pay: "pay(uint256)",
  refund: "refund(uint256,address)",
  bounties: "bounties(uint256)",
  claims: "claims(uint256,uint32)",
  funded: "funded(uint256,address)",
  backs: "backs(uint256,address)",
  openClaim: "openClaim(uint256,address)",
  currency: "currency()",
} as const;

export const TOPIC_POST_BOUNTY_OPENED = topicOf(
  "BountyOpened(uint256,bytes32,address,bytes32,uint64,uint64,string)",
);
export const TOPIC_POST_CLAIM_FILED = topicOf(
  "ClaimFiled(uint256,uint32,address,bytes32,string)",
);
export const TOPIC_POST_BOUNTY_FUNDED = topicOf(
  "Funded(uint256,address,uint256,uint256)",
);

const bytesOf = (text: string): number => new TextEncoder().encode(text).length;

function assertText(text: string, what: string): void {
  const n = bytesOf(text);
  if (n === 0 || n > MAX_TEXT) {
    throw new Error(`${what} must be 1 to ${MAX_TEXT} bytes long`);
  }
}

function assertAmount(value: bigint): void {
  if (value <= 0n || value >= 1n << 128n) {
    throw new Error("the amount must be above zero");
  }
}

function assertClaim(claim: number): void {
  if (!Number.isInteger(claim) || claim <= 0 || claim >= 2 ** 32) {
    throw new Error("not a claim number");
  }
}

// ---- calls ---------------------------------------------------------------------------------

/** Open a bounty on post `post` (its event id) with `words`, a `deadline` in seconds and `amount` of the currency. */
export function encodeOpenPostBounty(
  post: string,
  words: string,
  deadline: number,
  amount: bigint,
): string {
  if (!WORD_RE.test(post)) throw new Error("not a post id");
  assertText(words, "The words");
  if (!Number.isSafeInteger(deadline) || deadline <= 0) {
    throw new Error("the deadline must be a time in seconds");
  }
  assertAmount(amount);
  return encodeFunctionData(
    OPEN_BOUNTY_SIGNATURES.open,
    ["bytes32", "string", "uint64", "uint256"],
    [post, words, BigInt(deadline), amount],
  );
}

export function encodeFundPostBounty(id: bigint, amount: bigint): string {
  assertAmount(amount);
  return encodeFunctionData(
    OPEN_BOUNTY_SIGNATURES.fund,
    ["uint256", "uint256"],
    [id, amount],
  );
}

export function encodeFileClaim(id: bigint, evidence: string): string {
  assertText(evidence, "The evidence");
  return encodeFunctionData(
    OPEN_BOUNTY_SIGNATURES.fileClaim,
    ["uint256", "string"],
    [id, evidence],
  );
}

export function encodeWithdrawClaim(id: bigint): string {
  return encodeFunctionData(
    OPEN_BOUNTY_SIGNATURES.withdrawClaim,
    ["uint256"],
    [id],
  );
}

export function encodeBackClaim(id: bigint, claim: number): string {
  assertClaim(claim);
  return encodeFunctionData(
    OPEN_BOUNTY_SIGNATURES.back,
    ["uint256", "uint32"],
    [id, BigInt(claim)],
  );
}

export function encodeUnback(id: bigint): string {
  return encodeFunctionData(OPEN_BOUNTY_SIGNATURES.unback, ["uint256"], [id]);
}

export function encodeStartRun(id: bigint, claim: number): string {
  assertClaim(claim);
  return encodeFunctionData(
    OPEN_BOUNTY_SIGNATURES.start,
    ["uint256", "uint32"],
    [id, BigInt(claim)],
  );
}

export function encodePayPostBounty(id: bigint): string {
  return encodeFunctionData(OPEN_BOUNTY_SIGNATURES.pay, ["uint256"], [id]);
}

export function encodeRefundPostBounty(id: bigint, funder: string): string {
  if (!ADDRESS_RE.test(funder)) throw new Error("not an address (funder)");
  return encodeFunctionData(
    OPEN_BOUNTY_SIGNATURES.refund,
    ["uint256", "address"],
    [id, funder],
  );
}

// ---- reads, decoded --------------------------------------------------------------------------

export interface PostBountyRecord {
  creator: string;
  openedAt: number;
  deadline: number;
  refundsFrom: number;
  post: string;
  wordsHash: string;
  total: bigint;
  refunded: bigint;
  /** What funders with no open claim put in and have not taken back. */
  counting: bigint;
  claimCount: number;
  /** The claim whose run is on, or 0. */
  runClaim: number;
  runSince: number;
  /** The claim that was paid, or 0. */
  paidClaim: number;
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

/** `bounties(uint256)`: thirteen words. Null for a bounty that does not exist or a reply that is not one. */
export function decodePostBounty(hex: string): PostBountyRecord | null {
  const w = wordsOf(hex);
  if (w.length < 13 || w[0] === 0n) return null;
  return {
    creator: addressOf(w[0]),
    openedAt: Number(w[1]),
    deadline: Number(w[2]),
    refundsFrom: Number(w[3]),
    post: bytes32Of(w[4]),
    wordsHash: bytes32Of(w[5]),
    total: w[6],
    refunded: w[7],
    counting: w[8],
    claimCount: Number(w[9]),
    runClaim: Number(w[10]),
    runSince: Number(w[11]),
    paidClaim: Number(w[12]),
  };
}

/** `claims(uint256,uint32)`: claimant, open, backing, evidence hash. Null for a claim that does not exist. */
export function decodePostClaim(hex: string): {
  claimant: string;
  open: boolean;
  backing: bigint;
} | null {
  const w = wordsOf(hex);
  if (w.length < 4 || w[0] === 0n) return null;
  return { claimant: addressOf(w[0]), open: w[1] !== 0n, backing: w[2] };
}

interface LogLike {
  topics?: unknown;
  data?: unknown;
}

function topicsOf(
  log: LogLike,
  topic0: string,
  count: number,
): string[] | null {
  const t = Array.isArray(log.topics) ? (log.topics as unknown[]) : [];
  if (
    t.length !== count ||
    t[0] !== topic0 ||
    t.some((x) => typeof x !== "string") ||
    typeof log.data !== "string"
  ) {
    return null;
  }
  return t as string[];
}

export interface PostBountyOpened {
  id: bigint;
  post: string;
  creator: string;
  words: string;
}

export function decodePostBountyOpened(log: LogLike): PostBountyOpened | null {
  const t = topicsOf(log, TOPIC_POST_BOUNTY_OPENED, 4);
  if (!t) return null;
  try {
    const [, , , words] = decodeParameters(
      ["bytes32", "uint64", "uint64", "string"],
      log.data as string,
    );
    return {
      id: BigInt(t[1]),
      post: bytes32Of(BigInt(t[2])),
      creator: addressOf(BigInt(t[3])),
      words: String(words),
    };
  } catch {
    return null;
  }
}

export interface PostClaimFiled {
  claim: number;
  claimant: string;
  evidence: string;
}

export function decodePostClaimFiled(log: LogLike): PostClaimFiled | null {
  const t = topicsOf(log, TOPIC_POST_CLAIM_FILED, 4);
  if (!t) return null;
  try {
    const [, evidence] = decodeParameters(
      ["bytes32", "string"],
      log.data as string,
    );
    return {
      claim: Number(BigInt(t[2])),
      claimant: addressOf(BigInt(t[3])),
      evidence: String(evidence),
    };
  } catch {
    return null;
  }
}

// ---- where a bounty stands -------------------------------------------------------------------------

export type PostBountyStage =
  /** It paid the claim `claim`. */
  | { kind: "paid"; claim: number }
  /** Funders can take their money back. */
  | { kind: "refunds" }
  /** A run is on and old enough: anyone can pay it. */
  | { kind: "payable"; claim: number }
  /** A run is on, in its first two days. */
  | { kind: "agreeing"; claim: number; payableAt: number }
  /** A run is on, past its first two days. */
  | { kind: "holding"; claim: number; payableAt: number }
  /** Taking money and claims, no run on. */
  | { kind: "open" };

/** Whether funders can take their money back at `now`: the contract's own rule. */
export function postRefundsOpen(b: PostBountyRecord, now: number): boolean {
  return (
    b.paidClaim === 0 &&
    (now >= b.refundsFrom || (now >= b.deadline && b.runClaim === 0))
  );
}

/** Where `b` stands at chain time `now`, in the contract's own order. */
export function postBountyStage(
  b: PostBountyRecord,
  now: number,
): PostBountyStage {
  if (b.paidClaim !== 0) return { kind: "paid", claim: b.paidClaim };
  if (postRefundsOpen(b, now)) return { kind: "refunds" };
  if (b.runClaim !== 0) {
    const payableAt = b.runSince + RUN;
    if (now >= payableAt) return { kind: "payable", claim: b.runClaim };
    return now < b.runSince + AGREE
      ? { kind: "agreeing", claim: b.runClaim, payableAt }
      : { kind: "holding", claim: b.runClaim, payableAt };
  }
  return { kind: "open" };
}

/** Whether a claim with this `backing` has more than half of the counting money behind it. */
export function hasMajority(backing: bigint, counting: bigint): boolean {
  return backing * 2n > counting;
}

/** The share of the counting money behind a claim, in whole percent (0 when nothing counts). */
export function backingPercent(backing: bigint, counting: bigint): number {
  return counting === 0n ? 0 : Number((backing * 100n) / counting);
}

export interface PostClaimView {
  claim: number;
  claimant: string;
  evidence: string;
  open: boolean;
  backing: bigint;
}

export interface WalletPosition {
  /** What the wallet put in and has not taken back. */
  funded: bigint;
  /** The claim it backs, or 0. */
  backs: number;
  /** Its open claim, or 0. */
  openClaim: number;
}

/** What the connected wallet can do with a bounty at `now`, each the contract's own condition. */
export function walletCan(
  b: PostBountyRecord,
  me: WalletPosition,
  now: number,
): {
  fund: boolean;
  file: boolean;
  back: (claim: PostClaimView) => boolean;
  unback: boolean;
  withdrawClaim: boolean;
  refund: boolean;
  /** A claim with a majority that no run started yet: anyone can start its run. */
  start: (claims: readonly PostClaimView[]) => PostClaimView | null;
} {
  const unpaid = b.paidClaim === 0;
  const before = now < b.deadline;
  return {
    fund: unpaid && before && b.runClaim === 0,
    file: unpaid && before && me.openClaim === 0,
    back: (c) =>
      unpaid &&
      before &&
      c.open &&
      me.funded > 0n &&
      me.openClaim === 0 &&
      me.backs !== c.claim,
    unback: unpaid && me.backs !== 0,
    withdrawClaim: unpaid && me.openClaim !== 0,
    refund: postRefundsOpen(b, now) && me.funded > 0n,
    start: (claims) =>
      unpaid && before && b.runClaim === 0
        ? (claims.find((c) => c.open && hasMajority(c.backing, b.counting)) ??
          null)
        : null,
  };
}

// ---- the reader ---------------------------------------------------------------------------------

export interface PostBountyView {
  id: bigint;
  record: PostBountyRecord;
  /** The words, read from the opening event; null when they do not hash to the record's `wordsHash`. */
  words: string | null;
  claims: PostClaimView[];
  claimsTruncated: boolean;
  /** How many different wallets put money in. */
  funders: number;
  wallet: WalletPosition;
}

export interface PostBounties {
  contract: string;
  currency: {
    address: string;
    symbol: string;
    decimals: number;
    decimalsKnown: boolean;
  };
  bounties: PostBountyView[];
  /** The connected wallet's balance of the currency; null without a wallet. */
  walletBalance: bigint | null;
  truncated: boolean;
}

const idTopic = (id: bigint): string => bytes32Of(id);
const NO_POSITION: WalletPosition = { funded: 0n, backs: 0, openClaim: 0 };

/** Every bounty on post `post`, newest last, bounded by `MAX_POST_BOUNTIES`. `keccak` hashes the words to check them. */
export async function readPostBounties(
  chain: WorkChain,
  contract: string,
  post: string,
  wallet: string | null,
  keccak: (text: string) => string,
): Promise<PostBounties> {
  const currencyAddress = addressOf(
    decodeWord(
      await chain.call(contract, encodeCall0(OPEN_BOUNTY_SIGNATURES.currency)),
    ),
  );
  const [currency, walletBalance, openedLogs] = await Promise.all([
    readCurrency(chain, currencyAddress),
    wallet
      ? chain
          .call(currencyAddress, encodeBalanceOf(wallet))
          .then((hex) => decodeWord(hex))
      : Promise.resolve(null),
    chain.logs({
      address: contract,
      topics: [TOPIC_POST_BOUNTY_OPENED, null, postTopic(post)],
    }),
  ]);
  const opened = openedLogs
    .flatMap((log) => {
      const decoded = decodePostBountyOpened(log as LogLike);
      return decoded ? [decoded] : [];
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const bounties = (
    await Promise.all(
      opened
        .slice(-MAX_POST_BOUNTIES)
        .map(async (o): Promise<PostBountyView | null> => {
          const [recordHex, claimLogs, fundedLogs, position] =
            await Promise.all([
              chain.call(
                contract,
                encodeFunctionData(
                  OPEN_BOUNTY_SIGNATURES.bounties,
                  ["uint256"],
                  [o.id],
                ),
              ),
              chain.logs({
                address: contract,
                topics: [TOPIC_POST_CLAIM_FILED, idTopic(o.id)],
              }),
              chain.logs({
                address: contract,
                topics: [TOPIC_POST_BOUNTY_FUNDED, idTopic(o.id)],
              }),
              wallet
                ? readPosition(chain, contract, o.id, wallet)
                : Promise.resolve(NO_POSITION),
            ]);
          const record = decodePostBounty(recordHex);
          if (!record) return null;
          const filed = claimLogs.flatMap((log) => {
            const decoded = decodePostClaimFiled(log as LogLike);
            return decoded ? [decoded] : [];
          });
          const claims = (
            await Promise.all(
              filed.slice(-MAX_POST_CLAIMS).map(async (f) => {
                const state = decodePostClaim(
                  await chain.call(
                    contract,
                    encodeFunctionData(
                      OPEN_BOUNTY_SIGNATURES.claims,
                      ["uint256", "uint32"],
                      [o.id, BigInt(f.claim)],
                    ),
                  ),
                );
                return state ? [{ ...f, ...state }] : [];
              }),
            )
          ).flat();
          const funders = new Set(
            fundedLogs.flatMap((log) => {
              const t = Array.isArray((log as LogLike).topics)
                ? ((log as LogLike).topics as string[])
                : [];
              return t.length === 3 && t[0] === TOPIC_POST_BOUNTY_FUNDED
                ? [t[2].toLowerCase()]
                : [];
            }),
          );
          return {
            id: o.id,
            record,
            words:
              keccak(o.words).toLowerCase() === record.wordsHash.toLowerCase()
                ? o.words
                : null,
            claims,
            claimsTruncated: filed.length > MAX_POST_CLAIMS,
            funders: funders.size,
            wallet: position,
          };
        }),
    )
  ).flatMap((b) => (b ? [b] : []));
  return {
    contract,
    currency: { address: currencyAddress, ...currency },
    bounties,
    walletBalance,
    truncated: opened.length > MAX_POST_BOUNTIES,
  };
}

async function readPosition(
  chain: WorkChain,
  contract: string,
  id: bigint,
  wallet: string,
): Promise<WalletPosition> {
  const call = (signature: string) =>
    chain.call(
      contract,
      encodeFunctionData(signature, ["uint256", "address"], [id, wallet]),
    );
  const [funded, backs, openClaim] = await Promise.all([
    call(OPEN_BOUNTY_SIGNATURES.funded),
    call(OPEN_BOUNTY_SIGNATURES.backs),
    call(OPEN_BOUNTY_SIGNATURES.openClaim),
  ]);
  return {
    funded: decodeWord(funded),
    backs: Number(decodeWord(backs)),
    openClaim: Number(decodeWord(openClaim)),
  };
}

/** The topic a post's event id is filtered by (it is already 32 bytes). */
export function postTopic(post: string): string {
  if (!WORD_RE.test(post)) throw new Error("not a post id");
  return post.toLowerCase();
}

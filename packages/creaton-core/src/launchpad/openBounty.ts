/**
 * Bounties on posts (N2, `contracts/src/OpenBounty.sol`, specified in docs/v3-review/OPEN-BOUNTY-STATES.md): what a
 * bounty looks like on chain, where it stands, what the connected wallet can do with it, and the calls that do it.
 *
 * Appeals (N7): when the bounty names a court, a claimant can take their claim to it after the deadline, within
 * `APPEAL_WINDOW`; refunds wait for that window and for any open appeal, and an upheld claim is paid the whole pot.
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
const PAY_GRACE = 14 * 86_400;
/** The furthest a deadline can be from opening. */
export const MAX_LENGTH = 365 * 86_400;
/** The longest words or evidence, in bytes. */
export const MAX_TEXT = 1000;
/** How long after the deadline (or a run that ended after it) a claimant can appeal, before refunds open. */
export const APPEAL_WINDOW = 3 * 86_400;
/** At most this many bounties are read for one post, and this many claims for one bounty; more are reported. */
const MAX_POST_BOUNTIES = 10;
const MAX_POST_CLAIMS = 200;

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
  appeal: "appeal(uint256)",
  appeals: "appeals(uint256)",
  court: "court()",
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
export const TOPIC_POST_RUN_STARTED = topicOf(
  "RunStarted(uint256,uint32,uint64)",
);
export const TOPIC_POST_APPEALED = topicOf(
  "Appealed(uint256,uint32,address,uint256)",
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

/** Take your claim to the court (the bounty pulls the court's fee from you first). */
export function encodeAppealPostBounty(id: bigint): string {
  return encodeFunctionData(OPEN_BOUNTY_SIGNATURES.appeal, ["uint256"], [id]);
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
  /** Whether the bounty names a court its claimants can appeal to (N7). */
  court: boolean;
  appeal: PostAppeal;
}

/** An appeal to the court (N7), from `appeals(uint256)`. */
export interface PostAppeal {
  state: "none" | "open" | "upheld" | "refused";
  /** The appealed claim, or 0. */
  claim: number;
  /** When the court ruled (Unix seconds), or 0. */
  ruledAt: number;
  /** When the bounty's last run ended, or 0: an appeal window can follow a run that ended after the deadline. */
  runEndedAt: number;
  /** The court's case number, or null before an appeal (read from the bounty's `Appealed` event). */
  dispute: bigint | null;
}

export const NO_APPEAL: PostAppeal = {
  state: "none",
  claim: 0,
  ruledAt: 0,
  runEndedAt: 0,
  dispute: null,
};

const APPEAL_STATES = ["none", "open", "upheld", "refused"] as const;

/** `appeals(uint256)`: when the last run ended, the state, the claim, when it was ruled. */
export function decodePostAppeal(hex: string): PostAppeal {
  const w = wordsOf(hex);
  if (w.length < 4) return NO_APPEAL;
  return {
    runEndedAt: Number(w[0]),
    state: APPEAL_STATES[Number(w[1])] ?? "none",
    claim: Number(w[2]),
    ruledAt: Number(w[3]),
    dispute: null,
  };
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
    court: false,
    appeal: NO_APPEAL,
  };
}

/** `claims(uint256,uint32)`: claimant, open, backing, evidence hash. Null for a claim that does not exist. */
function decodePostClaim(hex: string): {
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
  /** The court upheld claim `claim`: anyone can pay it until `payUntil`. */
  | { kind: "upheld"; claim: number; payUntil: number }
  /** Claim `claim` is with the court. */
  | { kind: "appealing"; claim: number; dispute: bigint | null }
  /** The deadline passed with nothing paid: a claimant can still appeal until `until`, when refunds open. */
  | { kind: "window"; until: number }
  /** A run is on and old enough: anyone can pay it. */
  | { kind: "payable"; claim: number }
  /** A run is on, in its first two days. */
  | { kind: "agreeing"; claim: number; payableAt: number }
  /** A run is on, past its first two days. */
  | { kind: "holding"; claim: number; payableAt: number }
  /** Taking money and claims, no run on. */
  | { kind: "open" };

/** Since when the bounty has had no run after its deadline: the deadline, or a run that ended after it. */
function quietSince(b: PostBountyRecord): number {
  return b.appeal.runEndedAt > b.deadline ? b.appeal.runEndedAt : b.deadline;
}

/** Whether funders can take their money back at `now`: the contract's own rule. */
export function postRefundsOpen(b: PostBountyRecord, now: number): boolean {
  if (b.paidClaim !== 0) return false;
  const a = b.appeal;
  if (a.state === "open") return false;
  if (a.state === "upheld") return now >= a.ruledAt + PAY_GRACE;
  if (now >= b.refundsFrom) return true;
  if (now < b.deadline || b.runClaim !== 0) return false;
  return (
    !b.court ||
    b.claimCount === 0 ||
    a.state === "refused" ||
    now >= quietSince(b) + APPEAL_WINDOW
  );
}

/** Whether a claimant can appeal now (they also need an open claim): the contract's own rule. */
export function postAppealOpen(b: PostBountyRecord, now: number): boolean {
  return (
    b.court &&
    b.paidClaim === 0 &&
    b.appeal.state === "none" &&
    b.runClaim === 0 &&
    b.refunded === 0n &&
    now >= b.deadline &&
    now < quietSince(b) + APPEAL_WINDOW &&
    now < b.refundsFrom
  );
}

/** Where `b` stands at chain time `now`, in the contract's own order. */
export function postBountyStage(
  b: PostBountyRecord,
  now: number,
): PostBountyStage {
  if (b.paidClaim !== 0) return { kind: "paid", claim: b.paidClaim };
  if (postRefundsOpen(b, now)) return { kind: "refunds" };
  if (b.appeal.state === "upheld") {
    return {
      kind: "upheld",
      claim: b.appeal.claim,
      payUntil: b.appeal.ruledAt + PAY_GRACE,
    };
  }
  if (b.appeal.state === "open") {
    return {
      kind: "appealing",
      claim: b.appeal.claim,
      dispute: b.appeal.dispute,
    };
  }
  if (b.runClaim !== 0) {
    const payableAt = b.runSince + RUN;
    if (now >= payableAt) return { kind: "payable", claim: b.runClaim };
    return now < b.runSince + AGREE
      ? { kind: "agreeing", claim: b.runClaim, payableAt }
      : { kind: "holding", claim: b.runClaim, payableAt };
  }
  if (b.court && now >= b.deadline && b.appeal.state === "none") {
    return { kind: "window", until: quietSince(b) + APPEAL_WINDOW };
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
  /** Take its open claim to the court. */
  appeal: boolean;
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
    withdrawClaim:
      unpaid &&
      me.openClaim !== 0 &&
      !(b.appeal.state === "open" && b.appeal.claim === me.openClaim),
    refund: postRefundsOpen(b, now) && me.funded > 0n,
    appeal: me.openClaim !== 0 && postAppealOpen(b, now),
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
  /** When its first run started (Unix seconds), or null when none has: where its forecasts close. */
  firstRunSince: number | null;
  wallet: WalletPosition;
}

export interface PostBounties {
  contract: string;
  /** The court claimants appeal to, and what an appeal costs in its fee token; null when the bounty names none. */
  court: { address: string; feeToken: string; fee: bigint } | null;
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
  const [currency, walletBalance, openedLogs, court] = await Promise.all([
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
    readPostCourt(chain, contract),
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
          const [recordHex, claimLogs, fundedLogs, runLogs, position] =
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
              chain.logs({
                address: contract,
                topics: [TOPIC_POST_RUN_STARTED, idTopic(o.id)],
              }),
              wallet
                ? readPosition(chain, contract, o.id, wallet)
                : Promise.resolve(NO_POSITION),
            ]);
          const decoded = decodePostBounty(recordHex);
          if (!decoded) return null;
          const record: PostBountyRecord = {
            ...decoded,
            court: court !== null,
            appeal: court
              ? await readPostAppeal(chain, contract, o.id)
              : NO_APPEAL,
          };
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
          const starts = runLogs.flatMap((log) => {
            const data = (log as LogLike).data;
            return typeof data === "string" ? [Number(decodeWord(data))] : [];
          });
          return {
            id: o.id,
            record,
            firstRunSince: starts.length > 0 ? Math.min(...starts) : null,
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
    court,
    currency: { address: currencyAddress, ...currency },
    bounties,
    walletBalance,
    truncated: opened.length > MAX_POST_BOUNTIES,
  };
}

/** At most this many bounties, the newest, are read for a timeline's money chips. */
const MAX_INDEXED_BOUNTIES = 50;

/**
 * What is behind one post, over all its bounties, kept apart: what was paid to work, and what unpaid bounties still hold
 * (less what funders took back). A post can have both: one bounty paid, a later one still open.
 */
export interface PostMoney {
  paid: bigint;
  held: bigint;
  bounties: number;
}

/**
 * The money behind every post that has a bounty (N2), for chips in a timeline: one log read finds each bounty's post,
 * one call per bounty reads what it holds now, for the newest `max`. Posts are keyed by their 32-byte word, lower case.
 */
export async function readPostBountyIndex(
  chain: WorkChain,
  contract: string,
  max = MAX_INDEXED_BOUNTIES,
): Promise<{
  currency: { symbol: string; decimals: number; decimalsKnown: boolean };
  posts: Map<string, PostMoney>;
  truncated: boolean;
}> {
  const currencyAddress = addressOf(
    decodeWord(
      await chain.call(contract, encodeCall0(OPEN_BOUNTY_SIGNATURES.currency)),
    ),
  );
  const [currency, openedLogs] = await Promise.all([
    readCurrency(chain, currencyAddress),
    chain.logs({ address: contract, topics: [TOPIC_POST_BOUNTY_OPENED] }),
  ]);
  const opened = openedLogs
    .flatMap((log) => {
      const decoded = decodePostBountyOpened(log as LogLike);
      return decoded ? [decoded] : [];
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const newest = opened.slice(-max);
  const records = await Promise.all(
    newest.map(async (o) => ({
      post: o.post.toLowerCase(),
      record: decodePostBounty(
        await chain.call(
          contract,
          encodeFunctionData(
            OPEN_BOUNTY_SIGNATURES.bounties,
            ["uint256"],
            [o.id],
          ),
        ),
      ),
    })),
  );
  const posts = new Map<string, PostMoney>();
  for (const { post, record } of records) {
    if (!record) continue;
    const paid = record.paidClaim !== 0;
    const was = posts.get(post) ?? { paid: 0n, held: 0n, bounties: 0 };
    posts.set(post, {
      paid: was.paid + (paid ? record.total : 0n),
      held: was.held + (paid ? 0n : record.total - record.refunded),
      bounties: was.bounties + 1,
    });
  }
  return { currency, posts, truncated: opened.length > newest.length };
}

/** What a court case about a bounty is judged against: the post, its words, and the appealed claim's evidence. */
export interface PostBountyCase {
  post: string;
  words: string | null;
  claimant: string | null;
  evidence: string | null;
}

/** Read the words and one claim's evidence of bounty `id` from its events. */
export async function readPostBountyCase(
  chain: WorkChain,
  contract: string,
  id: bigint,
  claim: number,
): Promise<PostBountyCase> {
  const [opened, filed] = await Promise.all([
    chain.logs({
      address: contract,
      topics: [TOPIC_POST_BOUNTY_OPENED, idTopic(id)],
    }),
    chain.logs({
      address: contract,
      topics: [TOPIC_POST_CLAIM_FILED, idTopic(id), idTopic(BigInt(claim))],
    }),
  ]);
  const o = opened.flatMap((log) => {
    const d = decodePostBountyOpened(log as LogLike);
    return d && d.id === id ? [d] : [];
  })[0];
  const f = filed.flatMap((log) => {
    const d = decodePostClaimFiled(log as LogLike);
    return d && d.claim === claim ? [d] : [];
  })[0];
  return {
    post: o?.post ?? "",
    words: o?.words ?? null,
    claimant: f?.claimant ?? null,
    evidence: f?.evidence ?? null,
  };
}

/** The contract's own refusal: the function is not there. Never a node's failure. */
const refused = (error: unknown): boolean =>
  error instanceof Error && /revert/i.test(error.message);

/**
 * The court a bounty contract names and what an appeal costs.
 *
 * Null only when the bounty genuinely names none: its own refusal (a contract
 * made before appeals has no `court()`) or the zero address. A node that did not
 * answer — a timeout, an unreachable or busy node, a reply that is not a 32-byte
 * word — is passed on, so a failed read can never hide the appeal path by
 * looking like a bounty that named no court (Review-Proven Rule 1).
 */
export async function readPostCourt(
  chain: WorkChain,
  contract: string,
): Promise<PostBounties["court"]> {
  let answer: string;
  try {
    answer = await chain.call(
      contract,
      encodeCall0(OPEN_BOUNTY_SIGNATURES.court),
    );
  } catch (error) {
    if (refused(error)) return null;
    throw error;
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(answer)) {
    throw new Error(
      `the bounty answered ${answer} for court(), which is not a 32-byte word`,
    );
  }
  const address = addressOf(decodeWord(answer));
  if (/^0x0{40}$/.test(address)) return null;
  const [feeToken, fee] = await Promise.all([
    chain.call(address, encodeCall0("feeToken()")),
    chain.call(address, encodeCall0("arbitrationCost()")),
  ]);
  return {
    address,
    feeToken: addressOf(decodeWord(feeToken)),
    fee: decodeWord(fee),
  };
}

/** A bounty's appeal, with the court's case number from its `Appealed` event once there is one. */
export async function readPostAppeal(
  chain: WorkChain,
  contract: string,
  id: bigint,
): Promise<PostAppeal> {
  const appeal = decodePostAppeal(
    await chain.call(
      contract,
      encodeFunctionData(OPEN_BOUNTY_SIGNATURES.appeals, ["uint256"], [id]),
    ),
  );
  if (appeal.state === "none") return appeal;
  const logs = await chain.logs({
    address: contract,
    topics: [TOPIC_POST_APPEALED, idTopic(id)],
  });
  const data = (logs[0] as LogLike | undefined)?.data;
  return {
    ...appeal,
    dispute: typeof data === "string" ? decodeWord(data) : null,
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
function postTopic(post: string): string {
  if (!WORD_RE.test(post)) throw new Error("not a post id");
  return post.toLowerCase();
}

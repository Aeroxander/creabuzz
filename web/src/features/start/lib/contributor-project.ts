/**
 * A contributor project, as data: a DAO made with no sale at all, whose Shares are earned only for accepted work.
 *
 * What the founder fills in becomes three things, in order:
 *
 * 1. one transaction to the DAO maker (`OrgBinding.summonAndBind`), which makes the DAO with the founder as its only
 *    holder and production voting settings it checks and reads back. It makes no sale and takes no money;
 * 2. the project's public record, which names that DAO and says "contributors only";
 * 3. the first decision of the DAO: a work budget that pays in Shares only, opened for the founder to back.
 *
 * The DAO maker files each DAO under a 32-byte key. The key here is derived from the founder and the project's id, so
 * a reload can ask the chain whether this project's DAO already exists instead of making a second one.
 *
 * Alias-free on purpose: `contributor-project.test.mjs` drives it under `node --test`.
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import {
  type AbiType,
  encodeFunctionData,
} from "@creaton/core/launchpad/evmAbi.ts";
import {
  type DecisionDraft,
  DecisionInputError,
  mandateDecision,
} from "@creaton/core/launchpad/daoActions.ts";
import type { CreateLaunchInput } from "../../launchpad/use-launches.ts";
import { suggestSymbol } from "../../launchpad/models.ts";
import { slugFromName } from "../../launchpad/lib/wizard.ts";

export const NAME_MAX = 60;
export const PITCH_MAX = 140;
/** Whole Shares are what people type; the token has 18 decimals like every DAO's Shares here. */
export const SHARE_UNIT = 10n ** 18n;
/** A ceiling for what one form may create: a billion Shares. */
export const MAX_WHOLE_SHARES = 1_000_000_000n;
export const MAX_REVIEWERS = 32;
/** How long the first work budget stays open, in days. */
export const BUDGET_DAYS = 90;

/** The voting settings every contributor project's DAO is born with (the DAO maker refuses weaker ones). */
export const GOVERNANCE = {
  /** 5% of the Shares must take part in a vote. */
  quorumBps: 500,
  /** A holder can leave with their part of whatever the treasury holds (nothing, unless someone gives it money). */
  ragequittable: true,
  /** A decision lapses after 14 days. */
  proposalTTL: 14n * 86_400n,
  /** An approved decision waits one day before it can run. */
  timelockDelay: 86_400n,
} as const;

/** What the form starts with. */
export const CONTRIBUTOR_DEFAULTS = {
  founderShares: "100000",
  budgetShares: "100000",
  projectCap: "25000",
} as const;

export interface ContributorDraft {
  name: string;
  pitch: string;
  symbol: string;
  /** Whole Shares the founder starts with, so they can open and back the first votes. */
  founderShares: string;
  /** Whole Shares the first work budget may award in all. */
  budgetShares: string;
  /** Whole Shares any one project inside that budget may award. */
  projectCap: string;
  /** One wallet address per line (commas and spaces work too). */
  reviewers: string;
  /** How many reviewers must agree; empty for a simple majority. */
  quorum: string;
}

export class ContributorInputError extends Error {
  readonly field: keyof ContributorDraft;
  constructor(field: keyof ContributorDraft, message: string) {
    super(message);
    this.name = "ContributorInputError";
    this.field = field;
  }
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SYMBOL_RE = /^[A-Z0-9]{2,8}$/;
const ZERO = `0x${"0".repeat(40)}`;

function fail(field: keyof ContributorDraft, message: string): never {
  throw new ContributorInputError(field, message);
}

/** The short name the form suggests for a project name, never empty. */
export function contributorSymbol(name: string): string {
  const suggested = suggestSymbol(name);
  return suggested.length >= 2 ? suggested : "SHR";
}

function wholeShares(
  value: string,
  field: keyof ContributorDraft,
  what: string,
): bigint {
  const text = value.trim().replace(/[,_\s]/g, "");
  if (!/^\d+$/.test(text)) fail(field, `${what}: use a whole number.`);
  const n = BigInt(text);
  if (n === 0n) fail(field, `${what} must be more than 0.`);
  if (n > MAX_WHOLE_SHARES)
    fail(field, `${what} can be at most 1,000,000,000.`);
  return n;
}

/** The reviewer addresses in a text box: one per line, or separated by commas or spaces. */
export function reviewerList(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export interface ContributorTerms {
  name: string;
  pitch: string;
  symbol: string;
  /** In whole Shares. */
  founderWhole: bigint;
  budgetWhole: bigint;
  capWhole: bigint;
  reviewers: string[];
  quorum: number;
  /** Basis points of all Shares the contributors would hold if the whole first budget were awarded. */
  contributorsAtFullBudgetBps: number;
}

/**
 * The founder's answers, checked: every refusal names the field and says what to change. `founderWallet` is the
 * connected wallet when there is one.
 */
export function contributorTerms(
  draft: ContributorDraft,
  founderWallet: string | null = null,
): ContributorTerms {
  const name = draft.name.trim();
  if (name.length < 2) fail("name", "Give the project a name.");
  if (name.length > NAME_MAX)
    fail("name", `Keep the name under ${NAME_MAX} characters.`);
  if (slugFromName(name) === "")
    fail("name", "Use at least one letter or number in the name.");
  const pitch = draft.pitch.trim();
  if (pitch.length < 10) fail("pitch", "Say what it is in a sentence.");
  if (pitch.length > PITCH_MAX)
    fail("pitch", `Keep the one-liner under ${PITCH_MAX} characters.`);
  const symbol = draft.symbol.trim().toUpperCase();
  if (!SYMBOL_RE.test(symbol))
    fail("symbol", "The short name is 2 to 8 letters or numbers.");

  const founderWhole = wholeShares(
    draft.founderShares,
    "founderShares",
    "Your starting Shares",
  );
  const budgetWhole = wholeShares(
    draft.budgetShares,
    "budgetShares",
    "The Shares to earn",
  );
  const capWhole = wholeShares(
    draft.projectCap,
    "projectCap",
    "The most for one project",
  );
  if (capWhole > budgetWhole)
    fail(
      "projectCap",
      "One project cannot earn more than the whole budget holds.",
    );

  const reviewers = reviewerList(draft.reviewers);
  if (reviewers.length === 0)
    fail(
      "reviewers",
      "Name at least one reviewer: the people who check work before Shares are awarded.",
    );
  if (reviewers.length > MAX_REVIEWERS)
    fail("reviewers", `Name at most ${MAX_REVIEWERS} reviewers.`);
  for (const reviewer of reviewers) {
    if (!ADDRESS_RE.test(reviewer))
      fail(
        "reviewers",
        `"${reviewer.slice(0, 20)}" is not a wallet address (0x and 40 letters or numbers).`,
      );
    if (reviewer.toLowerCase() === ZERO)
      fail("reviewers", "A reviewer cannot be the empty address.");
  }
  const lower = reviewers.map((r) => r.toLowerCase());
  if (new Set(lower).size !== lower.length)
    fail("reviewers", "A reviewer is named twice.");

  const quorumText = draft.quorum.trim();
  const quorum = quorumText
    ? Number(quorumText)
    : Math.floor(reviewers.length / 2) + 1;
  if (!Number.isInteger(quorum) || quorum < 1 || quorum > reviewers.length)
    fail(
      "quorum",
      `How many reviewers must agree: a whole number from 1 to ${reviewers.length}.`,
    );
  // The founder may sit on the panel, but never be the only judge of work: one approval from them would be enough.
  if (
    founderWallet &&
    quorum === 1 &&
    lower.includes(founderWallet.toLowerCase())
  )
    fail(
      "quorum",
      "You are a reviewer and one approval is enough, so you could approve work alone. Ask for 2 or more, or leave yourself out.",
    );

  const total = founderWhole + budgetWhole;
  const contributorsAtFullBudgetBps = Number((budgetWhole * 10_000n) / total);
  return {
    name,
    pitch,
    symbol,
    founderWhole,
    budgetWhole,
    capWhole,
    reviewers,
    quorum,
    contributorsAtFullBudgetBps,
  };
}

/**
 * Who would hold what if the whole first budget were awarded, from the three Share fields alone, so the founder sees it
 * before the rest of the form is filled in. Null while those fields do not make sense.
 */
export function sharePreview(
  draft: Pick<
    ContributorDraft,
    "founderShares" | "budgetShares" | "projectCap"
  >,
): {
  founderWhole: bigint;
  budgetWhole: bigint;
  contributorsBps: number;
} | null {
  try {
    const founderWhole = wholeShares(draft.founderShares, "founderShares", "");
    const budgetWhole = wholeShares(draft.budgetShares, "budgetShares", "");
    const capWhole = wholeShares(draft.projectCap, "projectCap", "");
    if (capWhole > budgetWhole) return null;
    return {
      founderWhole,
      budgetWhole,
      contributorsBps: Number(
        (budgetWhole * 10_000n) / (founderWhole + budgetWhole),
      ),
    };
  } catch {
    return null;
  }
}

/** The first refusal for a draft, or null when it can be started. */
export function contributorIssue(
  draft: ContributorDraft,
  founderWallet: string | null = null,
): { field: keyof ContributorDraft; message: string } | null {
  try {
    contributorTerms(draft, founderWallet);
    return null;
  } catch (error) {
    if (error instanceof ContributorInputError)
      return { field: error.field, message: error.message };
    throw error;
  }
}

/** A whole number with thousands separators. */
export function formatWhole(n: bigint): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Basis points as a percent with at most one decimal ("33.3%", "50%"). */
export function formatBps(bps: number): string {
  const tenths = Math.round(bps / 10);
  return `${tenths % 10 === 0 ? tenths / 10 : (tenths / 10).toFixed(1)}%`;
}

// ---- the key the DAO maker files the DAO under -------------------------------------------------

/**
 * The 32-byte key for one project: the founder's public key and the project's id, under a fixed label. The same project
 * always maps to the same key, so the chain can say whether its DAO was made already.
 */
export function contributorRootId(author: string, launchId: string): string {
  return `0x${bytesToHex(
    keccak_256(
      utf8ToBytes(`creaton:contributor-project:37001:${author}:${launchId}`),
    ),
  )}`;
}

// ---- the DAO maker's calls ----------------------------------------------------------------------

/** `OrgBinding.summonAndBind(bytes32, SummonParams)`, with the struct spelled out as the ABI sees it. */
export const SUMMON_AND_BIND_SIGNATURE =
  "summonAndBind(bytes32,(string,string,string,uint16,bool,uint96,uint64,uint64,address,bytes32,address[],uint256[]))";

const SUMMON_PARAMS: AbiType = {
  tuple: [
    "string",
    "string",
    "string",
    "uint16",
    "bool",
    "uint96",
    "uint64",
    "uint64",
    "address",
    "bytes32",
    { array: "address" },
    { array: "uint256" },
  ],
};

export interface SummonCall {
  rootId: string;
  name: string;
  symbol: string;
  /** The DAO code the DAO maker's factory copies (read from the chain, never typed). */
  molochImpl: string;
  founder: string;
  /** In whole Shares. */
  founderWhole: bigint;
}

/** The smallest number of Shares that may open a decision: 1% of the starting Shares, at least one unit. */
export function proposalThreshold(founderWhole: bigint): bigint {
  const total = founderWhole * SHARE_UNIT;
  return total / 100n === 0n ? 1n : total / 100n;
}

/** The one transaction that makes the DAO: the founder its only holder, the voting settings above, no sale. */
export function encodeSummonAndBind(call: SummonCall): string {
  for (const [value, what] of [
    [call.molochImpl, "implementation"],
    [call.founder, "founder"],
  ] as const) {
    if (!ADDRESS_RE.test(value)) throw new Error(`invalid ${what} address`);
  }
  if (!/^0x[0-9a-f]{64}$/.test(call.rootId))
    throw new Error("invalid project key");
  return encodeFunctionData(
    SUMMON_AND_BIND_SIGNATURE,
    ["bytes32", SUMMON_PARAMS],
    [
      call.rootId,
      [
        call.name,
        call.symbol,
        "",
        BigInt(GOVERNANCE.quorumBps),
        GOVERNANCE.ragequittable,
        proposalThreshold(call.founderWhole),
        GOVERNANCE.proposalTTL,
        GOVERNANCE.timelockDelay,
        call.molochImpl,
        call.rootId,
        [call.founder],
        [call.founderWhole * SHARE_UNIT],
      ],
    ],
  );
}

/** `bindingOf(bytes32)`: the DAO already filed under a key (zero when none), and when. */
export function encodeBindingOf(rootId: string): string {
  return encodeFunctionData("bindingOf(bytes32)", ["bytes32"], [rootId]);
}

/** `binderOf(bytes32)`: who filed it. */
export function encodeBinderOf(rootId: string): string {
  return encodeFunctionData("binderOf(bytes32)", ["bytes32"], [rootId]);
}

export const CALL_SUMMONER = encodeFunctionData("summoner()", [], []);
export const CALL_GET_IMPLEMENTATION = encodeFunctionData(
  "getImplementation()",
  [],
  [],
);
export const CALL_SHARES = encodeFunctionData("shares()", [], []);
export const CALL_VOTING_WEIGHT = encodeFunctionData("votingWeight()", [], []);
export const CALL_MANDATE_FACTORY = encodeFunctionData(
  "mandateFactory()",
  [],
  [],
);
export const CALL_DECIMALS = encodeFunctionData("decimals()", [], []);

/** `DaoBound(bytes32 indexed rootId, address indexed dao, uint64 boundAt, string uri)`. */
export const TOPIC_DAO_BOUND = `0x${bytesToHex(
  keccak_256(utf8ToBytes("DaoBound(bytes32,address,uint64,string)")),
)}`;

/** The address in the last 20 bytes of the first 32-byte word of an answer or a log topic. */
export function wordAddress(word: string): string {
  const hex = word.replace(/^0x/, "");
  if (hex.length < 64) throw new Error("the answer is not a word");
  return `0x${hex.slice(24, 64).toLowerCase()}`;
}

export const ZERO_ADDRESS = ZERO;

/** The DAO the DAO maker's receipt names for this key, or null when no log in it does. */
export function daoFromReceiptLogs(
  logs: readonly { address?: string; topics?: readonly string[] }[],
  binding: string,
  rootId: string,
): string | null {
  for (const log of logs) {
    const topics = log.topics ?? [];
    if (
      log.address?.toLowerCase() === binding.toLowerCase() &&
      topics[0]?.toLowerCase() === TOPIC_DAO_BOUND &&
      topics[1]?.toLowerCase() === rootId.toLowerCase() &&
      topics[2]
    )
      return wordAddress(topics[2]);
  }
  return null;
}

// ---- the first decision -------------------------------------------------------------------------

/**
 * The DAO's first decision: a work budget that pays in Shares only. Claims under it still name a currency for any
 * deposit a contributor chooses to put up, so it needs one that exists on this network.
 */
export function firstBudgetDecision(input: {
  terms: Pick<
    ContributorTerms,
    "budgetWhole" | "capWhole" | "reviewers" | "quorum"
  >;
  dao: string;
  factory: string;
  currency: string;
  currencyDecimals: number;
  /** The chain's clock, in seconds. */
  now: number;
}): DecisionDraft {
  try {
    return mandateDecision({
      dao: input.dao,
      factory: input.factory,
      currency: input.currency,
      currencyDecimals: input.currencyDecimals,
      budget: 0n,
      cap: 0n,
      shareBudget: input.terms.budgetWhole * SHARE_UNIT,
      shareCap: input.terms.capWhole * SHARE_UNIT,
      expiresAt: input.now + BUDGET_DAYS * 86_400,
      reviewers: input.terms.reviewers,
      quorum: input.terms.quorum,
      reviewerBond: 0n,
      now: input.now,
    });
  } catch (error) {
    if (error instanceof DecisionInputError)
      throw new ContributorInputError("reviewers", error.message);
    throw error;
  }
}

/** A fixed nonce for the first decision, so sending it twice names the same decision rather than a second one. */
export function firstBudgetNonce(rootId: string): string {
  return `0x${bytesToHex(keccak_256(utf8ToBytes(`${rootId}:first-work-budget`)))}`;
}

// ---- the public record --------------------------------------------------------------------------

/** What the project publishes once its DAO exists: contributors only, the DAO's own Shares, nothing for sale. */
export function contributorRecordInput(input: {
  launchId: string;
  terms: Pick<ContributorTerms, "name" | "pitch" | "symbol" | "founderWhole">;
  chainId: number;
  dao: string;
  shares: string;
  currency: string;
}): CreateLaunchInput {
  return {
    id: input.launchId,
    name: input.terms.name,
    pitch: input.terms.pitch,
    // Its DAO exists from the first day: the stage a DAO has. `isContributorProject` keeps it from reading as a sale.
    stage: "graduated",
    funding: {
      stance: "not-raising",
      seeking: ["contributors"],
      path: "contributors",
      opensAt: null,
      note: null,
    },
    chainId: String(input.chainId),
    currency: input.currency,
    floorPrice: "",
    tickSpacing: "",
    requiredRaised: "",
    auction: "",
    token: input.shares,
    treasury: input.dao,
    admission: "community",
    channels: [],
    tokenPlan: {
      mode: "dao",
      name: input.terms.name,
      symbol: input.terms.symbol,
      supply: input.terms.founderWhole.toString(),
    },
  };
}

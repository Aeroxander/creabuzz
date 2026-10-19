/**
 * A contributor project, as data: a DAO made with no sale at all, whose Shares are earned only for accepted work.
 *
 * What the founder fills in becomes two things, in order:
 *
 * 1. one transaction to the contributor kit (`ContributorKit.launch`), which makes, at once: the DAO with the founder as
 *    its only holder and no sale; its first work budget, paying in Shares only, with the reviewers the founder named; the
 *    first project inside it, managed by the founder; and a lock that keeps Shares from being sent between wallets. The
 *    kit reads all of it back and makes nothing unless all of it came out as asked. So people can claim work the same
 *    day, with no vote first: until anyone else holds Shares, a vote would protect nobody
 *    (docs/v3-review/CONTRIBUTOR-KIT.md);
 * 2. the project's public record, which names that DAO and says "contributors only".
 *
 * The DAO's address follows from the founder and a salt derived from the project, so a reload can ask the chain whether
 * this project's DAO already exists instead of making a second one.
 *
 * Alias-free on purpose: `contributor-project.test.mjs` drives it under `node --test`.
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

import {
  type AbiType,
  encodeFunctionData,
} from "@creaton/core/launchpad/evmAbi.ts";
import { hashText, idWord } from "@creaton/core/launchpad/work.ts";
import type { CreateLaunchInput } from "../../launchpad/use-launches.ts";
import { suggestSymbol } from "../../launchpad/models.ts";
import { slugFromName } from "../../launchpad/lib/wizard.ts";

export const NAME_MAX = 60;
export const PITCH_MAX = 140;
/** A project name is a label of up to 32 bytes, as the work budget stores it. */
export const PROJECT_NAME_MAX = 32;
export const CHECK_MAX = 280;
/** Whole Shares are what people type; the token has 18 decimals like every DAO's Shares here. */
export const SHARE_UNIT = 10n ** 18n;
/** A ceiling for what one form may create: a billion Shares. */
export const MAX_WHOLE_SHARES = 1_000_000_000n;
export const MAX_REVIEWERS = 32;
/** How long the first work budget, and the first project in it, stay open, in days. */
export const BUDGET_DAYS = 90;

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
  /** Whole Shares the founder starts with, so they can open and back the project's votes. */
  founderShares: string;
  /** Whole Shares the first work budget may award in all. */
  budgetShares: string;
  /** Whole Shares any one project inside that budget may award; the first project gets this much. */
  projectCap: string;
  /** One wallet address per line (commas and spaces work too). */
  reviewers: string;
  /** How many reviewers must agree; empty for a simple majority. */
  quorum: string;
  /** The first project's short name ("docs"). */
  projectName: string;
  /** What finished work in it looks like, in a sentence: every claim states it, and the reviewers judge against it. */
  projectCheck: string;
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
  projectName: string;
  projectCheck: string;
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

  const projectName = draft.projectName.trim();
  if (projectName.length === 0)
    fail("projectName", "Name the first project, in a word or two.");
  if (utf8ToBytes(projectName).length > PROJECT_NAME_MAX)
    fail(
      "projectName",
      `Keep the project's name to ${PROJECT_NAME_MAX} letters.`,
    );
  if (projectName.startsWith("0x"))
    fail("projectName", "Start the project's name with a letter.");
  const projectCheck = draft.projectCheck.trim();
  if (projectCheck.length < 5)
    fail(
      "projectCheck",
      "Say what finished work looks like, so reviewers know what to check.",
    );
  if (projectCheck.length > CHECK_MAX)
    fail("projectCheck", `Keep it under ${CHECK_MAX} characters.`);

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
    projectName,
    projectCheck,
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

// ---- the salt the DAO's address follows from ---------------------------------------------------

/**
 * The 32-byte salt for one project: the founder's public key and the project's id, under a fixed label. The kit scopes
 * it to the sending wallet too, so the same project from the same wallet always maps to the same DAO address.
 */
export function contributorSalt(author: string, launchId: string): string {
  return `0x${bytesToHex(
    keccak_256(
      utf8ToBytes(`creaton:contributor-project:37001:${author}:${launchId}`),
    ),
  )}`;
}

// ---- the work budget's address --------------------------------------------------------------------

function rlpNonce(nonce: bigint): Uint8Array {
  if (nonce === 0n) return Uint8Array.of(0x80);
  if (nonce < 0x80n) return Uint8Array.of(Number(nonce));
  const hex = nonce.toString(16);
  const bytes = hexToBytes(hex.length % 2 ? `0${hex}` : hex);
  return Uint8Array.of(0x80 + bytes.length, ...bytes);
}

/**
 * Where a contract makes its next contract with a plain CREATE: `keccak256(rlp([sender, nonce]))`, last 20 bytes. The
 * work budget factory makes budgets this way, so the kit is told where the next one will be.
 */
export function createAddress(sender: string, nonce: bigint): string {
  if (!ADDRESS_RE.test(sender)) throw new Error("invalid sender address");
  if (nonce < 0n) throw new Error("invalid nonce");
  const nonceBytes = rlpNonce(nonce);
  const payload = Uint8Array.of(
    0x94,
    ...hexToBytes(sender.slice(2).toLowerCase()),
    ...nonceBytes,
  );
  const encoded = Uint8Array.of(0xc0 + payload.length, ...payload);
  return `0x${bytesToHex(keccak_256(encoded)).slice(24)}`;
}

// ---- the kit's calls ----------------------------------------------------------------------------

/** `ContributorKit.launch(Params)`, with the struct spelled out as the ABI sees it. */
export const KIT_LAUNCH_SIGNATURE =
  "launch((string,string,uint256,bytes32,address,uint128,uint128,uint64,address[],uint256,address,bytes32,address,uint128,uint64,bytes32))";

const KIT_PARAMS: AbiType = {
  tuple: [
    "string",
    "string",
    "uint256",
    "bytes32",
    "address",
    "uint128",
    "uint128",
    "uint64",
    { array: "address" },
    "uint256",
    "address",
    "bytes32",
    "address",
    "uint128",
    "uint64",
    "bytes32",
  ],
};

export interface KitLaunch {
  terms: ContributorTerms;
  salt: string;
  /** The founder's wallet: the only holder, and the first project's manager. */
  founder: string;
  /** The token claims name for an optional deposit (the network's USDC). */
  currency: string;
  /** Where the work budget factory's next budget will be (`createAddress(factory, nonce)`). */
  predictedBudget: string;
  /** The chain's clock, in seconds. */
  now: number;
}

/** The one transaction that makes the whole project: DAO, budget, first project, transfer lock. No sale. */
export function encodeKitLaunch(launch: KitLaunch): string {
  for (const [value, what] of [
    [launch.founder, "founder"],
    [launch.currency, "currency"],
    [launch.predictedBudget, "budget"],
  ] as const) {
    if (!ADDRESS_RE.test(value)) throw new Error(`invalid ${what} address`);
  }
  if (!/^0x[0-9a-f]{64}$/.test(launch.salt))
    throw new Error("invalid project salt");
  const { terms } = launch;
  const expires = BigInt(launch.now + BUDGET_DAYS * 86_400);
  return encodeFunctionData(
    KIT_LAUNCH_SIGNATURE,
    [KIT_PARAMS],
    [
      [
        terms.name,
        terms.symbol,
        terms.founderWhole * SHARE_UNIT,
        launch.salt,
        launch.currency,
        terms.budgetWhole * SHARE_UNIT,
        terms.capWhole * SHARE_UNIT,
        expires,
        terms.reviewers,
        BigInt(terms.quorum),
        launch.predictedBudget,
        idWord(terms.projectName),
        launch.founder,
        terms.capWhole * SHARE_UNIT,
        expires,
        hashText(terms.projectCheck),
      ],
    ],
  );
}

/** `predictDao(founder, founderShares, salt)`: where this project's DAO is, or will be. */
export function encodePredictDao(
  founder: string,
  founderWhole: bigint,
  salt: string,
): string {
  return encodeFunctionData(
    "predictDao(address,uint256,bytes32)",
    ["address", "uint256", "bytes32"],
    [founder, founderWhole * SHARE_UNIT, salt],
  );
}

export const CALL_SUMMONER = encodeFunctionData("summoner()", [], []);
export const CALL_BUDGET_FACTORY = encodeFunctionData(
  "budgetFactory()",
  [],
  [],
);
export const CALL_SHARES = encodeFunctionData("shares()", [], []);
export const CALL_DECIMALS = encodeFunctionData("decimals()", [], []);

/** The address in the last 20 bytes of the first 32-byte word of an answer or a log topic. */
export function wordAddress(word: string): string {
  const hex = word.replace(/^0x/, "");
  if (hex.length < 64) throw new Error("the answer is not a word");
  return `0x${hex.slice(24, 64).toLowerCase()}`;
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

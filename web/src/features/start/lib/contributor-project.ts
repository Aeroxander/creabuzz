/**
 * A contributor project, as data: a DAO made with no token sale, whose new Shares come only from awards for reviewed work.
 *
 * What the founder fills in becomes two things, in order:
 *
 * 1. one transaction to the contributor kit (`ContributorKit.launch`), which makes, at once: the DAO with the founder as
 *    its only holder and no sale; its first work budget, paying in Shares only, with the reviewers the founder named; up
 *    to eight first projects inside it (one per role, for a team from the Projects board, D84), managed by the founder;
 *    and a lock that keeps Shares from being sent between wallets. The
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
import {
  type BuiltOn,
  parseBuiltOn,
  REMIX_ASKS_MAX,
  type RemixTerms,
} from "../../launchpad/lib/remix.ts";

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
/** The most first projects the contributor kit makes in one launch (`ContributorKit.MAX_FIRST_PROJECTS`). */
export const MAX_FIRST_PROJECTS = 8;
/** How long the first work budget, and the first project in it, stay open, in days. */
export const BUDGET_DAYS = 90;

/** What the form starts with. */
export const CONTRIBUTOR_DEFAULTS = {
  founderShares: "100000",
  // Three times the founder's, the least the contributor kit accepts (D79): once it is all awarded, the people who did
  // the work hold three quarters.
  budgetShares: "300000",
  projectCap: "25000",
} as const;

/** One first project, as typed. */
export interface ProjectDraft {
  /** Its short name ("docs"). */
  name: string;
  /** What finished work in it looks like, in a sentence: every claim states it, and the reviewers judge against it. */
  check: string;
  /** Whole Shares it may award in all. */
  shares: string;
}

export interface ContributorDraft {
  name: string;
  pitch: string;
  symbol: string;
  /** Whole Shares the founder starts with, so they can open and back the project's votes. */
  founderShares: string;
  /** Whole Shares the first work budget may award in all. */
  budgetShares: string;
  /** Whole Shares any one project inside that budget may award. */
  projectCap: string;
  /** One wallet address per line (commas and spaces work too). */
  reviewers: string;
  /** How many reviewers must agree; empty for a simple majority. */
  quorum: string;
  /** The first projects, one to eight. */
  projects: ProjectDraft[];
  /** The project this one is built on, as "author:id" of its record, or empty (N11). Optional: older drafts lack it. */
  builtOn?: string;
  /** Whether others may build on this project (N11). */
  remixInvited?: boolean;
  /** What this project asks of projects built on it, in words (N11). */
  remixAsks?: string;
}

/** The draft's remix choices as record fields (N11): what it is built on, and whether others may build on it. */
export function remixFromDraft(
  draft: Pick<ContributorDraft, "builtOn" | "remixInvited" | "remixAsks">,
): { builtOn?: BuiltOn; remixTerms: RemixTerms } {
  const [author, id] = (draft.builtOn ?? "").split(":");
  const builtOn = parseBuiltOn({ author, id });
  return {
    ...(builtOn ? { builtOn } : {}),
    remixTerms: {
      invited: draft.remixInvited === true,
      asks: draft.remixInvited
        ? (draft.remixAsks ?? "").trim().slice(0, REMIX_ASKS_MAX)
        : "",
      offers: [],
    },
  };
}

/** A first project with nothing typed, sized at the per-project limit. */
export function emptyProject(cap: string): ProjectDraft {
  return { name: "", check: "", shares: cap };
}

/** Which box of a first work area a problem is about. */
export type ProjectPart = "name" | "check" | "shares";

export class ContributorInputError extends Error {
  readonly field: keyof ContributorDraft;
  /** For a first project's problem: which one (0-based). */
  readonly index: number | null;
  /** For a first project's problem: which of its boxes, so that box is marked and focused. */
  readonly part: ProjectPart | null;
  constructor(
    field: keyof ContributorDraft,
    message: string,
    index: number | null = null,
    part: ProjectPart | null = null,
  ) {
    super(message);
    this.name = "ContributorInputError";
    this.field = field;
    this.index = index;
    this.part = part;
  }
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SYMBOL_RE = /^[A-Z0-9]{2,8}$/;
const ZERO = `0x${"0".repeat(40)}`;

function fail(
  field: keyof ContributorDraft,
  message: string,
  index: number | null = null,
  part: ProjectPart | null = null,
): never {
  throw new ContributorInputError(field, message, index, part);
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
  index: number | null = null,
  part: ProjectPart | null = null,
): bigint {
  const text = value.trim().replace(/[,_\s]/g, "");
  if (!/^\d+$/.test(text))
    fail(field, `${what}: use a whole number.`, index, part);
  const n = BigInt(text);
  if (n === 0n) fail(field, `${what} must be more than 0.`, index, part);
  if (n > MAX_WHOLE_SHARES)
    fail(field, `${what} can be at most 1,000,000,000.`, index, part);
  return n;
}

/** How many of `count` reviewers must agree: the number typed, or more than half when the box is empty. */
export function reviewQuorum(count: number, quorumText: string): number {
  const typed = quorumText.trim();
  return typed ? Number(typed) : Math.floor(count / 2) + 1;
}

/**
 * Whether every reviewer named must agree (and there is more than one): then a split, or one reviewer who does not
 * answer, leaves a piece of work stuck until its deadline, which the form says before the project is made. Two
 * reviewers with the box left empty is the common case: more than half of two is both.
 */
export function everyReviewerMustAgree(
  count: number,
  quorumText: string,
): boolean {
  return count > 1 && reviewQuorum(count, quorumText) === count;
}

/**
 * What the form says about how reviewers decide, as `ClaimStake.settle` decides: anyone may settle a piece the moment
 * enough reviewers approved it, or enough turned it down (approvals are checked first). So with one needed, the first
 * answer decides, a turn-down as much as an approval; and with every reviewer needed, a split decides nothing.
 */
export function quorumSentence(count: number, mustAgree: number): string {
  if (count === 1) return "This reviewer decides on each piece of work alone.";
  if (mustAgree === 1) {
    return "The first answer decides: one approval approves it, one turn-down turns it down.";
  }
  if (mustAgree === count) {
    return count === 2
      ? "Both must agree: two approvals approve it, two turn-downs turn it down. If they split, nothing is decided."
      : `All ${count} must agree: ${count} approvals approve it, ${count} turn-downs turn it down. If they split, nothing is decided.`;
  }
  return `${mustAgree} of these ${count} decide: ${mustAgree} approvals approve it, ${mustAgree} turn-downs turn it down.`;
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
  projects: { name: string; check: string; sharesWhole: bigint }[];
  /** Basis points of all Shares the contributors would hold if the whole first budget were awarded. */
  contributorsAtFullBudgetBps: number;
}

/** The first projects, checked: one to eight, distinct names, each within the per-project limit, all within the budget. */
function checkProjects(
  drafts: readonly ProjectDraft[],
  capWhole: bigint,
  budgetWhole: bigint,
): ContributorTerms["projects"] {
  if (drafts.length === 0)
    fail("projects", "Add a first work area: something people can work on.");
  if (drafts.length > MAX_FIRST_PROJECTS)
    fail(
      "projects",
      `Start with at most ${MAX_FIRST_PROJECTS} work areas; the project can vote to add more later.`,
      null,
      "name",
    );
  const seen = new Set<string>();
  let total = 0n;
  const projects = drafts.map((draft, index) => {
    const name = draft.name.trim();
    // Each problem names the project it is about: by its name once it has one.
    const which = name
      ? `“${name}”`
      : drafts.length > 1
        ? `work area ${index + 1}`
        : "the first work area";
    const Which = which.charAt(0).toUpperCase() + which.slice(1);
    if (name.length === 0)
      fail("projects", `Name ${which}, in a word or two.`, index, "name");
    if (utf8ToBytes(name).length > PROJECT_NAME_MAX)
      fail(
        "projects",
        `Keep the name of ${which} to ${PROJECT_NAME_MAX} letters.`,
        index,
        "name",
      );
    if (name.startsWith("0x"))
      fail(
        "projects",
        `Start the name of ${which} with a letter.`,
        index,
        "name",
      );
    if (seen.has(name))
      fail(
        "projects",
        `Two work areas are called ${which}: give each its own name.`,
        index,
        "name",
      );
    seen.add(name);
    const check = draft.check.trim();
    if (check.length < 5)
      fail(
        "projects",
        `Say what finished work looks like for ${which}, so reviewers know what to check.`,
        index,
        "check",
      );
    if (check.length > CHECK_MAX)
      fail(
        "projects",
        `Keep what finished work looks like for ${which} under ${CHECK_MAX} characters.`,
        index,
        "check",
      );
    const sharesWhole = wholeShares(
      draft.shares,
      "projects",
      `The Shares for ${which}`,
      index,
      "shares",
    );
    if (sharesWhole > capWhole)
      fail(
        "projects",
        `${Which} can award at most ${formatWhole(capWhole)} Shares, the most for one work area.`,
        index,
        "shares",
      );
    total += sharesWhole;
    return { name, check, sharesWhole };
  });
  if (total > budgetWhole)
    fail(
      "projects",
      `Together the work areas award ${formatWhole(total)} Shares, more than the ${formatWhole(budgetWhole)} the budget holds.`,
      null,
      "shares",
    );
  return projects;
}

/**
 * The founder's answers, checked: every refusal names the field and says what to change. `founderWallet` is the account
 * the founder acts with when there is one, or every address known to be theirs (the acting account and any wallet their
 * name is linked to, D139): none of them may review.
 */
export function contributorTerms(
  draft: ContributorDraft,
  founderWallet: string | readonly string[] | null = null,
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
  // D79: the contributor kit refuses a founder stake above a third of the first budget.
  if (founderWhole * 3n > budgetWhole)
    fail(
      "founderShares",
      "Start with at most a third of the Shares the first budget can award, so the people who do the work can end up holding most of the project.",
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

  const quorum = reviewQuorum(reviewers.length, draft.quorum);
  if (!Number.isInteger(quorum) || quorum < 1 || quorum > reviewers.length)
    fail(
      "quorum",
      `How many reviewers must agree: a whole number from 1 to ${reviewers.length}.`,
    );
  // D79: the founder does not judge the first budget's work; the contributor kit refuses a panel with them on it.
  const founderAddresses = (
    typeof founderWallet === "string" ? [founderWallet] : (founderWallet ?? [])
  ).map((address) => address.toLowerCase());
  if (founderAddresses.some((address) => lower.includes(address)))
    fail(
      "reviewers",
      "You cannot review the first budget's work yourself. Name other people: they check everyone's work, yours too.",
    );

  const projects = checkProjects(draft.projects, capWhole, budgetWhole);

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
    projects,
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

/**
 * A warning while the founder types, before they press Start: their starting Shares are more than a third of the work
 * budget, so contributors could never end up holding most of the project (and the start would be refused, D79).
 */
export function founderShareWarning(preview: {
  founderWhole: bigint;
  budgetWhole: bigint;
}): string | null {
  if (preview.founderWhole * 3n <= preview.budgetWhole) return null;
  return `Your starting Shares are more than a third of the Shares for work, so the people who do the work could never hold most of the project. Start with at most ${formatWhole(preview.budgetWhole / 3n)}, or raise the Shares for work.`;
}

/** The first refusal for a draft, or null when it can be started. */
export function contributorIssue(
  draft: ContributorDraft,
  founderWallet: string | readonly string[] | null = null,
): {
  field: keyof ContributorDraft;
  message: string;
  /** Which first project, for a problem with one of them. */
  index: number | null;
  /** Which box of that work area (its name, what finished looks like, or its Shares). */
  part: ProjectPart | null;
} | null {
  try {
    contributorTerms(draft, founderWallet);
    return null;
  } catch (error) {
    if (error instanceof ContributorInputError)
      return {
        field: error.field,
        message: error.message,
        index: error.index,
        part: error.part,
      };
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
  // A share that rounds to nothing (or to everything) is not nothing: say so rather than print 0% or 100%.
  if (tenths === 0 && bps > 0) return "<0.1%";
  if (tenths === 1000 && bps < 10_000) return ">99.9%";
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
  "launch((string,string,uint256,bytes32,address,uint128,uint128,uint64,address[],uint256,address,(bytes32,address,uint128,uint64,bytes32)[]))";

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
    {
      array: { tuple: ["bytes32", "address", "uint128", "uint64", "bytes32"] },
    },
  ],
};

export interface KitLaunch {
  terms: ContributorTerms;
  salt: string;
  /** The founder's wallet: the only holder, and every first project's manager. */
  founder: string;
  /** The token claims name for an optional deposit (the network's USDC). */
  currency: string;
  /** Where the work budget factory's next budget will be (`createAddress(factory, nonce)`). */
  predictedBudget: string;
  /** The chain's clock, in seconds. */
  now: number;
}

/** The one transaction that makes the whole project: DAO, budget, first projects, transfer lock. No sale. */
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
        terms.projects.map((project) => [
          idWord(project.name),
          launch.founder,
          project.sharesWhole * SHARE_UNIT,
          expires,
          hashText(project.check),
        ]),
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
  terms: Pick<
    ContributorTerms,
    "name" | "pitch" | "symbol" | "founderWhole" | "projects"
  >;
  chainId: number;
  dao: string;
  shares: string;
  currency: string;
  /** What it is built on and its remix terms (N11). */
  remix?: { builtOn?: BuiltOn; remixTerms: RemixTerms };
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
    // The chain keeps only each first work area's hashed words; these let people read them (verified by the hash).
    workAreas: input.terms.projects.map((p) => ({
      name: p.name,
      check: p.check,
    })),
    ...(input.remix ?? {}),
  };
}

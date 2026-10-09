/**
 * What a DAO can decide to do, as calls (to compose a decision) and as words (to describe one somebody else
 * composed). Pure: inputs in, bytes or sentences out, with every encoding pinned to `cast` in `daoActions.test.mjs`.
 *
 * A decision is a proposal whose action is a single call from the DAO. Describing is the other half of composing:
 * a voter must be able to read what they are voting on, so every action this module can write it can also read back,
 * and anything it cannot read is shown as unknown rather than guessed at.
 */

import {
  type AbiType,
  decodeParameters,
  encodeFunctionData,
  selectorOf,
} from "./evmAbi.ts";
import { hashText, idLabel, idWord } from "./work.ts";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const MAX_REVIEWERS = 32;
const U128_MAX = (1n << 128n) - 1n;
const U96_MAX = (1n << 96n) - 1n;

export const ACTION_SIGNATURES = {
  batchCalls: "batchCalls((address,uint256,bytes)[])",
  approve: "approve(address,uint256)",
  createMandate:
    "create(address,uint128,uint128,uint128,uint128,uint64,address[],uint256)",
  approveProject:
    "approveProject(bytes32,address,uint128,uint128,uint64,bytes32)",
  award: "awardContribution(address,bytes32,uint96,bool)",
  collectFees: "collectHookFeesByToken(address,address,address,uint256)",
} as const;

const CALL_TYPE: AbiType = { tuple: ["address", "uint256", "bytes"] };

export type DecisionLane = "unrestricted" | "bounded";

/** A decision ready to be opened for a vote: the single call the DAO would make, and how to describe it. */
export interface DecisionDraft {
  /** What the DAO calls. */
  to: string;
  /** The calldata of that call. */
  data: string;
  /**
   * Which vote it takes: the full vote for anything that changes what the treasury can do, the lighter one for an
   * approval inside a budget the DAO already voted. The chain decides; this only tells the person.
   */
  lane: DecisionLane;
  title: string;
  lines: string[];
}

export class DecisionInputError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "DecisionInputError";
    this.field = field;
  }
}

function fail(field: string, message: string): never {
  throw new DecisionInputError(field, message);
}

function address(value: string, field: string, what: string): string {
  if (!ADDRESS_RE.test(value.trim())) fail(field, `${what} is not an address.`);
  return value.trim().toLowerCase();
}

/** Whole units with up to `decimals` fractional digits, as base units. */
export function parseUnits(
  value: string,
  decimals: number,
  field: string,
  what: string,
): bigint {
  const text = value.trim();
  const parts = text.split(".");
  if (
    parts.length > 2 ||
    !/^\d+$/.test(parts[0] ?? "") ||
    (parts[1] !== undefined && !/^\d+$/.test(parts[1])) ||
    (parts[1]?.length ?? 0) > decimals
  ) {
    fail(
      field,
      `${what} must be a number with at most ${decimals} decimal places.`,
    );
  }
  return (
    BigInt(parts[0]) * 10n ** BigInt(decimals) +
    BigInt((parts[1] ?? "").padEnd(decimals, "0") || "0")
  );
}

/** Base units as a readable number, trimming trailing zeros and capping the decimals shown. */
export function formatUnits(
  value: bigint,
  decimals: number,
  maxFraction = 2,
): string {
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale)
    .toString()
    .padStart(decimals, "0")
    .slice(0, maxFraction)
    .replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}

const shares = (v: bigint) => formatUnits(v, 18);

// ---- composing -------------------------------------------------------------------------------

export interface MandateInput {
  dao: string;
  /** The mandate factory the DAO's voting policy names. */
  factory: string;
  /** What claims are paid and staked in. A contract; a Shares-only budget still needs one that exists. */
  currency: string;
  currencyDecimals: number;
  /** Money the budget may spend in total, in base units (0 for none) and the most one project may hold. */
  budget: bigint;
  cap: bigint;
  /** Shares the budget may cause to be awarded in total (base units, 0 for none) and the most one project may award. */
  shareBudget: bigint;
  shareCap: bigint;
  /** Unix seconds. */
  expiresAt: number;
  reviewers: readonly string[];
  quorum: number;
  /** Unix seconds: "now" for the expiry check. */
  now: number;
}

/**
 * The vote that sets aside a work budget: a Shares-only budget moves no money, so the DAO calls the factory directly;
 * one with a money budget first approves the factory for exactly that amount and clears the approval after.
 */
export function mandateDecision(input: MandateInput): DecisionDraft {
  const dao = address(input.dao, "dao", "The DAO");
  const factory = address(input.factory, "factory", "The work budget factory");
  const currency = address(input.currency, "currency", "The currency");
  if (input.budget === 0n && input.shareBudget === 0n)
    fail("budget", "Set aside some Shares, some money, or both.");
  if ((input.budget === 0n) !== (input.cap === 0n))
    fail(
      "cap",
      "Money for work needs a limit per project, and a limit needs money.",
    );
  if (input.cap > input.budget)
    fail("cap", "The limit per project cannot be more than the whole budget.");
  if ((input.shareBudget === 0n) !== (input.shareCap === 0n))
    fail(
      "shareCap",
      "Shares for work need a limit per project, and a limit needs Shares.",
    );
  if (input.shareCap > input.shareBudget)
    fail(
      "shareCap",
      "The limit per project cannot be more than all the Shares set aside.",
    );
  for (const [v, field] of [
    [input.budget, "budget"],
    [input.cap, "cap"],
    [input.shareBudget, "shareBudget"],
    [input.shareCap, "shareCap"],
  ] as const) {
    if (v > U128_MAX) fail(field, "That amount is too large.");
  }
  if (!Number.isInteger(input.expiresAt) || input.expiresAt <= input.now)
    fail("expiresAt", "Pick an end date in the future.");
  const reviewers = input.reviewers.map((r) =>
    address(r, "reviewers", "A reviewer"),
  );
  if (reviewers.length === 0 || reviewers.length > MAX_REVIEWERS)
    fail("reviewers", `Name 1 to ${MAX_REVIEWERS} reviewers.`);
  if (new Set(reviewers).size !== reviewers.length)
    fail("reviewers", "A reviewer is named twice.");
  if (reviewers.includes(ZERO_ADDRESS))
    fail("reviewers", "A reviewer cannot be the empty address.");
  if (
    !Number.isInteger(input.quorum) ||
    input.quorum < 1 ||
    input.quorum > reviewers.length
  )
    fail("quorum", `How many reviewers must agree: 1 to ${reviewers.length}.`);

  const create = encodeFunctionData(
    ACTION_SIGNATURES.createMandate,
    [
      "address",
      "uint128",
      "uint128",
      "uint128",
      "uint128",
      "uint64",
      { array: "address" },
      "uint256",
    ],
    [
      currency,
      input.budget,
      input.cap,
      input.shareBudget,
      input.shareCap,
      BigInt(input.expiresAt),
      reviewers,
      BigInt(input.quorum),
    ],
  );
  const lines = [
    ...(input.shareBudget > 0n
      ? [
          `Shares for work: ${shares(input.shareBudget)} in all, at most ${shares(input.shareCap)} per project`,
        ]
      : []),
    ...(input.budget > 0n
      ? [
          `Money for work: ${formatUnits(input.budget, input.currencyDecimals)} in all, at most ${formatUnits(input.cap, input.currencyDecimals)} per project`,
        ]
      : []),
    `Open until ${new Date(input.expiresAt * 1000).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}`,
    `${reviewers.length} reviewer${reviewers.length === 1 ? "" : "s"}, ${input.quorum} must agree on each claim`,
  ];
  const base = {
    lane: "unrestricted" as const,
    title: "Set aside a work budget",
    lines,
  };
  if (input.budget === 0n) return { to: factory, data: create, ...base };
  const approve = (amount: bigint) =>
    encodeFunctionData(
      ACTION_SIGNATURES.approve,
      ["address", "uint256"],
      [factory, amount],
    );
  return {
    to: dao,
    data: encodeBatch([
      { to: currency, data: approve(input.budget) },
      { to: factory, data: create },
      { to: currency, data: approve(0n) },
    ]),
    ...base,
  };
}

/** `Moloch.batchCalls((target, value, data)[])`: the DAO makes several calls in one vote. */
export function encodeBatch(
  calls: readonly { to: string; data: string }[],
): string {
  return encodeFunctionData(
    ACTION_SIGNATURES.batchCalls,
    [{ array: CALL_TYPE }],
    [calls.map((c) => [c.to, 0n, c.data])],
  );
}

export interface ProjectInput {
  mandate: string;
  /** A short label (up to 32 bytes) or a 0x word. */
  id: string;
  manager: string;
  /** Money the project may hold (base units, 0 for none) and Shares it may award (base units, 0 for none). */
  amount: bigint;
  shares: bigint;
  expiresAt: number;
  /** The words the project's claims are judged by. */
  checkText: string;
  now: number;
  currencyDecimals: number;
}

/** The vote that approves a project inside a work budget the DAO already voted: the lighter vote. */
export function projectDecision(input: ProjectInput): DecisionDraft {
  const mandate = address(input.mandate, "mandate", "The work budget");
  const manager = address(input.manager, "manager", "The project manager");
  let id: string;
  try {
    id = idWord(input.id);
  } catch {
    return fail("id", "Give the project a short name (up to 32 letters).");
  }
  if (input.amount === 0n && input.shares === 0n)
    fail("amount", "A project needs some Shares, some money, or both.");
  if (input.amount > U128_MAX || input.shares > U128_MAX)
    fail("amount", "That amount is too large.");
  if (!Number.isInteger(input.expiresAt) || input.expiresAt <= input.now)
    fail("expiresAt", "Pick an end date in the future.");
  if (input.checkText.trim() === "")
    fail(
      "checkText",
      "Say how the work will be judged: the exact words reviewers check it against.",
    );
  const check = hashText(input.checkText);
  const data = encodeFunctionData(
    ACTION_SIGNATURES.approveProject,
    ["bytes32", "address", "uint128", "uint128", "uint64", "bytes32"],
    [id, manager, input.amount, input.shares, BigInt(input.expiresAt), check],
  );
  return {
    to: mandate,
    data,
    lane: "bounded",
    title: `Approve the project “${idLabel(id)}”`,
    lines: [
      `Managed by ${manager}`,
      ...(input.shares > 0n
        ? [`May award up to ${shares(input.shares)} Shares`]
        : []),
      ...(input.amount > 0n
        ? [
            `May hold up to ${formatUnits(input.amount, input.currencyDecimals)} of the budget's money`,
          ]
        : []),
      `Judged by: “${input.checkText.trim()}”`,
    ],
  };
}

export interface AwardInput {
  dao: string;
  mandate: string;
  claimId: string;
  shares: bigint;
}

/** The vote that awards Shares for a claim its reviewers approved: the lighter vote. */
export function awardDecision(input: AwardInput): DecisionDraft {
  const dao = address(input.dao, "dao", "The DAO");
  const mandate = address(input.mandate, "mandate", "The work budget");
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.claimId))
    fail("claimId", "Pick the claim to award.");
  if (input.shares === 0n)
    fail("shares", "An award of no Shares is not an award.");
  if (input.shares > U96_MAX) fail("shares", "That amount is too large.");
  return {
    to: dao,
    data: encodeFunctionData(
      ACTION_SIGNATURES.award,
      ["address", "bytes32", "uint96", "bool"],
      [mandate, input.claimId, input.shares, false],
    ),
    lane: "bounded",
    title: `Award ${shares(input.shares)} Shares for the claim “${idLabel(input.claimId)}”`,
    lines: [
      "The work budget refuses an award larger than the project has left, however the vote goes.",
    ],
  };
}

export interface CollectFeesInput {
  amm: string;
  sharesToken: string;
  currency: string;
  currencyDecimals: number;
  recipient: string;
  amount: bigint;
}

/** The vote that moves the trading fees the Shares' hook collected into the treasury. */
export function collectFeesDecision(input: CollectFeesInput): DecisionDraft {
  const amm = address(input.amm, "amm", "The exchange");
  if (input.amount === 0n)
    fail("amount", "No fees are owed yet: they build up as the Shares trade.");
  return {
    to: amm,
    data: encodeFunctionData(
      ACTION_SIGNATURES.collectFees,
      ["address", "address", "address", "uint256"],
      [
        address(input.sharesToken, "shares", "The Shares"),
        address(input.currency, "currency", "The currency"),
        address(input.recipient, "recipient", "The treasury"),
        input.amount,
      ],
    ),
    lane: "unrestricted",
    title: "Collect the trading fees",
    lines: [
      `Move ${formatUnits(input.amount, input.currencyDecimals, 4)} collected on trades into the treasury`,
    ],
  };
}

// ---- describing ------------------------------------------------------------------------------

/** What an action is, in words. `kind` is `unknown` for anything this module did not write. */
export interface ActionDescription {
  kind:
    | "work-budget"
    | "project"
    | "award"
    | "fees"
    | "market"
    | "batch"
    | "unknown";
  title: string;
  lines: string[];
}

export interface DescribeContext {
  /** Decimals of the sale currency, when known; amounts are otherwise shown in base units. */
  currencyDecimals?: number;
  /**
   * What the app knows to be this DAO's own: its address, its work budget factory, its work budgets, its exchange. When
   * given, an action is only described as (say) an award if it is aimed where a real award is aimed; a call with the
   * same selector sent anywhere else is described as unknown, so the words never claim more than the call does.
   */
  dao?: string;
  factory?: string;
  mandates?: readonly string[];
  amm?: string;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const selectorOfSig = (key: keyof typeof ACTION_SIGNATURES) =>
  selectorOf(ACTION_SIGNATURES[key]).toLowerCase();

function money(value: bigint, ctx: DescribeContext): string {
  return ctx.currencyDecimals === undefined
    ? `${value.toString()} base units`
    : formatUnits(value, ctx.currencyDecimals);
}

function date(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function describeCall(
  call: { to: string; data: string },
  ctx: DescribeContext,
): ActionDescription | null {
  const data = call.data.toLowerCase();
  const sel = data.slice(0, 10);
  const args = `0x${data.slice(10)}`;
  try {
    if (sel === selectorOfSig("createMandate")) {
      if (ctx.factory && !same(call.to, ctx.factory)) return null;
      const [, budget, cap, shareBudget, shareCap, expires, reviewers, quorum] =
        decodeParameters(
          [
            "address",
            "uint128",
            "uint128",
            "uint128",
            "uint128",
            "uint64",
            { array: "address" },
            "uint256",
          ],
          args,
        ) as [string, bigint, bigint, bigint, bigint, bigint, string[], bigint];
      return {
        kind: "work-budget",
        title: "Set aside a work budget",
        lines: [
          ...(shareBudget > 0n
            ? [
                `Shares for work: ${shares(shareBudget)} in all, at most ${shares(shareCap)} per project`,
              ]
            : []),
          ...(budget > 0n
            ? [
                `Money for work: ${money(budget, ctx)} in all, at most ${money(cap, ctx)} per project`,
              ]
            : []),
          `Open until ${date(expires)}`,
          `${reviewers.length} reviewer${reviewers.length === 1 ? "" : "s"}, ${quorum} must agree on each claim`,
        ],
      };
    }
    if (sel === selectorOfSig("approveProject")) {
      if (ctx.mandates && !ctx.mandates.some((m) => same(m, call.to)))
        return null;
      const [id, manager, amount, projectShares, expires, check] =
        decodeParameters(
          ["bytes32", "address", "uint128", "uint128", "uint64", "bytes32"],
          args,
        ) as [string, string, bigint, bigint, bigint, string];
      return {
        kind: "project",
        title: `Approve the project “${idLabel(id)}”`,
        lines: [
          `Managed by ${manager}`,
          ...(projectShares > 0n
            ? [`May award up to ${shares(projectShares)} Shares`]
            : []),
          ...(amount > 0n
            ? [`May hold up to ${money(amount, ctx)} of the budget's money`]
            : []),
          `Open until ${date(expires)}`,
          `Judged by the check ${check.slice(0, 10)}…`,
        ],
      };
    }
    if (sel === selectorOfSig("award")) {
      if (ctx.dao && !same(call.to, ctx.dao)) return null;
      const [mandate, claim, amount] = decodeParameters(
        ["address", "bytes32", "uint96", "bool"],
        args,
      ) as [string, string, bigint, boolean];
      return {
        kind: "award",
        title: `Award ${shares(amount)} Shares for the claim “${idLabel(claim)}”`,
        lines: [`In the work budget ${mandate}`],
      };
    }
    if (sel === selectorOfSig("collectFees")) {
      if (ctx.amm && !same(call.to, ctx.amm)) return null;
      const [, , recipient, amount] = decodeParameters(
        ["address", "address", "address", "uint256"],
        args,
      ) as [string, string, string, bigint];
      return {
        kind: "fees",
        title: "Collect the trading fees",
        lines: [
          `Move ${money(amount, ctx)} collected on trades to ${recipient}`,
        ],
      };
    }
  } catch {
    return null;
  }
  return null;
}

/** Whether the two approvals around a `create` are exactly the budget's: the factory, for the budget, then for nothing. */
function isBudgetApprovals(
  spend: { to: string; data: string },
  create: { to: string; data: string },
  clear: { to: string; data: string },
): boolean {
  try {
    const [currency, budget] = decodeParameters(
      ["address", "uint128"],
      `0x${create.data.slice(10)}`,
    ) as [string, bigint];
    const approval = (call: { to: string; data: string }) => {
      if (!call.data.toLowerCase().startsWith(selectorOfSig("approve")))
        return null;
      const [spender, amount] = decodeParameters(
        ["address", "uint256"],
        `0x${call.data.slice(10)}`,
      ) as [string, bigint];
      return {
        token: call.to.toLowerCase(),
        spender: spender.toLowerCase(),
        amount,
      };
    };
    const first = approval(spend);
    const last = approval(clear);
    const factory = create.to.toLowerCase();
    return (
      first !== null &&
      last !== null &&
      first.token === currency.toLowerCase() &&
      last.token === currency.toLowerCase() &&
      first.spender === factory &&
      last.spender === factory &&
      first.amount === budget &&
      last.amount === 0n
    );
  } catch {
    return false;
  }
}

/** Decode a `batchCalls` action into its calls, or null when it is not one. */
export function decodeBatch(
  data: string,
): { to: string; value: bigint; data: string }[] | null {
  const lower = data.toLowerCase();
  if (!lower.startsWith(selectorOfSig("batchCalls"))) return null;
  try {
    const [calls] = decodeParameters(
      [{ array: CALL_TYPE }],
      `0x${lower.slice(10)}`,
    ) as [[string, bigint, string][]];
    return calls.map(([to, value, callData]) => ({
      to,
      value,
      data: callData,
    }));
  } catch {
    return null;
  }
}

/**
 * Describe a proposal's action in plain words. Recognised actions get a real title and the facts a voter needs; a batch
 * of recognised steps is described by what it amounts to; anything else is said to be unknown, with its target.
 */
export function describeAction(
  action: { to: string; data: string },
  ctx: DescribeContext = {},
): ActionDescription {
  const single = describeCall(action, ctx);
  if (single) return single;
  const batch = decodeBatch(action.data);
  if (batch) {
    // A work budget with money: approve the factory for exactly the budget, create it, clear the approval. Only that
    // shape is described as a budget; a batch that looks like it but approves anyone or anything else is not.
    if (batch.length === 3) {
      const [spend, create, clear] = batch;
      const described = describeCall(create, ctx);
      if (
        described?.kind === "work-budget" &&
        isBudgetApprovals(spend, create, clear)
      ) {
        return described;
      }
    }
    const steps = batch.map((c) => describeCall(c, ctx));
    return {
      kind: "batch",
      title: `A set of ${batch.length} actions, done together`,
      lines: batch.map(
        (c, i) =>
          steps[i]?.title ?? `A call to ${c.to} (${c.data.slice(0, 10)})`,
      ),
    };
  }
  return {
    kind: "unknown",
    title: "An action this app does not know how to describe",
    lines: [
      `A call to ${action.to}, ${action.data.slice(0, 10)} (${Math.max(0, (action.data.length - 2) / 2)} bytes)`,
    ],
  };
}

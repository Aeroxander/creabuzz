/**
 * The DAO's own voting settings, in words, with a warning when one is out of the safe range (funding review D2). The
 * DAO can set its minimum yes votes, minimum turnout and the Shares needed to open a decision to any number, and its
 * turnout share up to 100% (`MolochPatched.sol:1209-1254`). Set high enough, no later decision can pass and only leaving
 * is left. The voting lanes refuse a turnout above 60% (`AllocationVoting.setLane`); this app holds these settings to
 * the same limit, since the contracts do not until after the pilots. The app never composes these calls, so a decision
 * that carries one was written elsewhere, and the voter needs to be told plainly what it does.
 */

import {
  type ActionDescription,
  type DescribeContext,
  decodeBatch,
  describeAction,
  formatUnits,
} from "./daoActions.ts";
import { selectorOf } from "./evmAbi.ts";

export const VOTING_RULE_SIGNATURES = {
  quorumBps: "setQuorumBps(uint16)",
  minYes: "setMinYesVotesAbsolute(uint96)",
  quorumAbsolute: "setQuorumAbsolute(uint96)",
  proposalThreshold: "setProposalThreshold(uint96)",
} as const;

/** The highest turnout share a voting lane accepts (`AllocationVoting.setLane`), used as the limit for all four. */
const MAX_SAFE_BPS = 6_000;

type Setting = keyof typeof VOTING_RULE_SIGNATURES;

const SELECTORS = Object.fromEntries(
  Object.entries(VOTING_RULE_SIGNATURES).map(([key, sig]) => [
    selectorOf(sig).toLowerCase(),
    key as Setting,
  ]),
) as Record<string, Setting>;

const shares = (v: bigint) => formatUnits(v, 18);

/** One voting setting call, decoded, or null when the call is not one aimed at this DAO. */
function decode(
  call: { to: string; data: string },
  ctx: DescribeContext,
): { setting: Setting; value: bigint } | null {
  if (!ctx.dao || call.to.toLowerCase() !== ctx.dao.toLowerCase()) return null;
  const data = call.data.toLowerCase();
  const setting = SELECTORS[data.slice(0, 10)];
  if (!setting || data.length !== 74) return null;
  return { setting, value: BigInt(`0x${data.slice(10)}`) };
}

/**
 * Whether a setting is outside the safe range. A share is judged directly; a number of Shares is judged against the
 * Shares that vote today, so it is null (cannot tell) when that is not known.
 */
export function votingRuleUnsafe(
  setting: Setting,
  value: bigint,
  votingSupply: bigint | undefined,
): boolean | null {
  if (setting === "quorumBps") return value > BigInt(MAX_SAFE_BPS);
  if (votingSupply === undefined || votingSupply === 0n) return null;
  return value * 10_000n > votingSupply * BigInt(MAX_SAFE_BPS);
}

function title(setting: Setting, value: bigint): string {
  switch (setting) {
    case "quorumBps":
      return `Require ${Number(value) / 100}% of the Shares to take part in every decision`;
    case "minYes":
      return `Require ${shares(value)} Shares to back every decision`;
    case "quorumAbsolute":
      return `Require ${shares(value)} Shares to take part in every decision`;
    case "proposalThreshold":
      return `Require ${shares(value)} Shares to open a decision`;
  }
}

function lines(
  setting: Setting,
  value: bigint,
  ctx: DescribeContext,
): string[] {
  const unsafe = votingRuleUnsafe(setting, value, ctx.votingSupply);
  const limit =
    setting === "quorumBps"
      ? "60% of the Shares"
      : ctx.votingSupply
        ? `${shares((ctx.votingSupply * BigInt(MAX_SAFE_BPS)) / 10_000n)} Shares (60% of the ${shares(ctx.votingSupply)} that vote today)`
        : "60% of the Shares that vote";
  const what =
    setting === "proposalThreshold"
      ? "Only someone holding at least this many Shares could put anything to a vote."
      : "It applies to every decision opened after this one, on top of each decision's own bar.";
  if (unsafe === true) {
    return [
      `Above the safe limit of ${limit}. If this passes, later decisions may never be able to pass: no awards, no spending and no other changes, ever. Leaving would be the only thing left.`,
      what,
    ];
  }
  if (unsafe === null) {
    return [
      what,
      `Anything above ${limit} could stop every later decision from passing. Check how many Shares vote before backing it.`,
    ];
  }
  return [what, `Within the safe limit of ${limit}.`];
}

/**
 * Describe a decision that changes the DAO's voting settings, alone or as one step of a set, or null when it does not
 * touch them.
 */
export function describeVotingRules(
  action: { to: string; data: string },
  ctx: DescribeContext,
): ActionDescription | null {
  const single = decode(action, ctx);
  if (single) {
    return {
      kind: "voting-rules",
      title: title(single.setting, single.value),
      lines: lines(single.setting, single.value, ctx),
      unsafe: votingRuleUnsafe(single.setting, single.value, ctx.votingSupply),
    };
  }
  const batch = decodeBatch(action.data);
  if (!batch || !ctx.dao || action.to.toLowerCase() !== ctx.dao.toLowerCase())
    return null;
  const steps = batch.map((call) => decode(call, ctx));
  if (steps.every((step) => step === null)) return null;
  const verdicts = steps.flatMap((step) =>
    step ? [votingRuleUnsafe(step.setting, step.value, ctx.votingSupply)] : [],
  );
  const unsafe = verdicts.includes(true)
    ? true
    : verdicts.includes(null)
      ? null
      : false;
  return {
    kind: "voting-rules",
    title: `A set of ${batch.length} actions that changes how votes work`,
    lines: batch.flatMap((call, i) => {
      const step = steps[i];
      return step
        ? [
            title(step.setting, step.value),
            ...lines(step.setting, step.value, ctx),
          ]
        : [describeAction(call, ctx).title];
    }),
    unsafe,
  };
}

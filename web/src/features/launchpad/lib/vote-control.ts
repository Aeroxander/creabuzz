/**
 * Who controls a DAO's votes right now, and what changes that: the founder-control disclosure (D79's "the founder still
 * decides alone until ownership actually spreads", and a raise's team, whose Shares vote from the first day while
 * backers' vote only once claimed). No governance mechanism, only the reading of the one there is.
 *
 * The votes that count are the Shares outside the DAO and outside the addresses its voting policy leaves out (in a
 * raise, the auction holding Shares not yet claimed). A decision passes (`AllocationVoting.thresholdsMet`) when enough
 * of those votes take part, at least the DAO's minimum of votes in favour are cast, more are for than against, and the
 * votes for are at least the lane's approval share of those for or against. How many must take part is fixed when the
 * decision opens (`openProposal`): the highest of the lane's share, the DAO's own share (`quorumBps`) and the DAO's
 * floor in Shares (`quorumAbsolute`); the minimum in favour is the DAO's `minYesVotesAbsolute`. So a holder passes a
 * decision even if every other holder votes against when their votes clear all of those against everyone else's; and
 * passes one nobody else votes on when they alone clear the turnout and the minimum in favour. The hold time and the
 * review are waits, not bars: they change when, not whether.
 *
 * Pure apart from the injected `call`: `vote-control.test.mjs` drives it with a fake chain. A network that does not
 * answer is an error, never a share of the votes.
 */

/** One `eth_call`: the raw return data, or a thrown error. */
export type Call = (to: string, data: string) => Promise<string>;

const TOTAL_SUPPLY = "0x18160ddd";
const BALANCE_OF = "0x70a08231";
const LANES = "0x713c311a"; // lanes(uint256)
const EXCLUDED_HOLDERS = "0x38f66048"; // excludedHolders()
const QUORUM_BPS = "0xcd2ddd0c"; // quorumBps(), on the DAO
const QUORUM_ABSOLUTE = "0x6a34d91a"; // quorumAbsolute(), on the DAO
const MIN_YES = "0x8ab8c683"; // minYesVotesAbsolute(), on the DAO

export interface Bars {
  /** Of the votes that count, how many must take part (basis points). */
  quorumBps: number;
  /** Of the votes cast for or against, how many must be for (basis points). */
  approvalBps: number;
}

export interface VoteControl {
  /** The votes that count today, in Share base units. */
  votingSupply: bigint;
  /** Shares the policy leaves out besides the DAO's own: in a raise, those still waiting to be claimed. */
  waiting: bigint;
  /** The addresses the policy leaves out (lower-case). */
  excluded: string[];
  /** Anything that spends the treasury or changes the rules. */
  full: Bars;
  /** An award or a work area inside a budget already voted. */
  bounded: Bars;
  /** The DAO's own bars, which raise a lane's and never lower it. */
  governor: Governor;
}

/** The DAO's own settings a decision opens with (`openProposal`'s `bps`, `absolute` and `minYes`). */
export interface Governor {
  /** Of the votes that count, how many must take part (basis points); 0 when off. */
  quorumBps: number;
  /** How many votes must take part, in Share base units; 0 when off. */
  quorumAbsolute: bigint;
  /** How many votes must be in favour, in Share base units; 0 when off. */
  minYes: bigint;
}

const NO_GOVERNOR: Governor = { quorumBps: 0, quorumAbsolute: 0n, minYes: 0n };

/** `_ceilBps`: the votes a share in basis points of `supply` comes to, rounded up as the contract does. */
const ceilBps = (supply: bigint, bps: number) =>
  (supply * BigInt(bps) + 9_999n) / 10_000n;

/** The votes a decision on `bars` needs to take part: the highest of the lane's, the DAO's share and its floor. */
export function turnoutNeeded(
  control: Pick<VoteControl, "votingSupply"> & { governor?: Governor },
  bars: Bars,
): bigint {
  const governor = control.governor ?? NO_GOVERNOR;
  const supply = control.votingSupply;
  const lane = ceilBps(supply, bars.quorumBps);
  const share = ceilBps(supply, governor.quorumBps);
  const most = lane > share ? lane : share;
  return governor.quorumAbsolute > most ? governor.quorumAbsolute : most;
}

function words(hex: string): bigint[] {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (
    body.length === 0 ||
    body.length % 64 !== 0 ||
    !/^[0-9a-fA-F]+$/.test(body)
  ) {
    throw new Error("expected an ABI answer");
  }
  return Array.from({ length: body.length / 64 }, (_, i) =>
    BigInt(`0x${body.slice(i * 64, (i + 1) * 64)}`),
  );
}

const pad = (value: string | number) =>
  (typeof value === "number"
    ? value.toString(16)
    : value.slice(2).toLowerCase()
  ).padStart(64, "0");

export async function readVoteControl(
  call: Call,
  dao: string,
  policy: string,
  shares: string,
): Promise<VoteControl> {
  const balance = async (who: string) =>
    words(await call(shares, `${BALANCE_OF}${pad(who)}`))[0];
  const [
    supply,
    daoHeld,
    excludedHex,
    fullHex,
    boundedHex,
    quorumBpsHex,
    quorumAbsoluteHex,
    minYesHex,
  ] = await Promise.all([
    call(shares, TOTAL_SUPPLY),
    balance(dao),
    call(policy, EXCLUDED_HOLDERS),
    call(policy, `${LANES}${pad(0)}`),
    call(policy, `${LANES}${pad(1)}`),
    call(dao, QUORUM_BPS),
    call(dao, QUORUM_ABSOLUTE),
    call(dao, MIN_YES),
  ]);
  // `address[]`: offset, length, then one word per address.
  const list = words(excludedHex);
  const excluded = list
    .slice(2, 2 + Number(list[1] ?? 0n))
    .map((a) => `0x${a.toString(16).padStart(40, "0")}`);
  const waiting = (await Promise.all(excluded.map(balance))).reduce(
    (a, b) => a + b,
    0n,
  );
  const outside = words(supply)[0] - daoHeld - waiting;
  const bars = (hex: string): Bars => {
    const [quorumBps, approvalBps] = words(hex);
    return { quorumBps: Number(quorumBps), approvalBps: Number(approvalBps) };
  };
  return {
    votingSupply: outside > 0n ? outside : 0n,
    waiting,
    excluded,
    full: bars(fullHex),
    bounded: bars(boundedHex),
    governor: {
      quorumBps: Number(words(quorumBpsHex)[0]),
      quorumAbsolute: words(quorumAbsoluteHex)[0],
      minYes: words(minYesHex)[0],
    },
  };
}

/**
 * `alone`: passes it even against every other vote; `unopposed`: passes it when nobody else votes; `shared`: needs
 * others; `nobody`: the DAO's turnout floor is more than all the votes that count, so no decision of this kind can pass.
 */
export type Control = "alone" | "unopposed" | "shared" | "nobody";

export function controlOf(
  weight: bigint,
  control: Pick<VoteControl, "votingSupply"> & { governor?: Governor },
  bars: Bars = (control as VoteControl).full,
): Control {
  const supply = control.votingSupply;
  const turnout = turnoutNeeded(control, bars);
  if (supply === 0n) return "shared";
  if (turnout > supply) return "nobody";
  if (weight === 0n) return "shared";
  const minYes = (control.governor ?? NO_GOVERNOR).minYes;
  if (weight < minYes) return "shared";
  // Everyone else votes against: all the votes take part, so the turnout is met; the votes for must still be more than
  // those against and at least the approval share of both.
  if (
    weight * 2n > supply &&
    weight * 10_000n >= BigInt(bars.approvalBps) * supply
  ) {
    return "alone";
  }
  // Nobody else votes: all the votes cast are for, so only the turnout is left to meet.
  if (weight >= turnout) return "unopposed";
  return "shared";
}

/** How many more Shares others must come to hold before `weight` can no longer pass a decision against all of them. */
export function sharesUntilShared(
  weight: bigint,
  control: VoteControl,
): bigint {
  const needed =
    (weight * 10_000n) / BigInt(control.full.approvalBps) +
    1n -
    control.votingSupply;
  return needed > 0n ? needed : 0n;
}

/** Basis points of `part` in `whole`, as a percent with one decimal at most. */
function percentOf(part: bigint, whole: bigint): string {
  if (whole === 0n) return "0%";
  const tenths = Number((part * 1000n + whole / 2n) / whole);
  return `${tenths % 10 === 0 ? tenths / 10 : (tenths / 10).toFixed(1)}%`;
}

const pct = (bps: number) =>
  `${bps % 100 === 0 ? bps / 100 : (bps / 100).toFixed(1)}%`;

/** The disclosure in sentences: who holds how much of the votes, whether they decide alone, and what changes it. */
export function voteControlLines(input: {
  /** How the biggest voter is named. */
  who: string;
  weight: bigint;
  control: VoteControl;
  kind: "raise" | "contributors";
  shares: (atomic: bigint) => string;
}): string[] {
  const { who, weight, control, kind, shares } = input;
  const { full, bounded } = control;
  const governor = control.governor ?? NO_GOVERNOR;
  // The turnout as a share of the votes, with the DAO's own bars in it.
  const turnoutPct = (bars: Bars) =>
    percentOf(turnoutNeeded(control, bars), control.votingSupply);
  const lines = [
    `${who} holds ${percentOf(weight, control.votingSupply)} of the votes that count today. A decision that spends the treasury or changes the rules needs ${turnoutPct(full)} of those votes to take part and ${pct(full.approvalBps)} of the votes cast in favour; an award or a work area inside a budget already voted needs ${turnoutPct(bounded)} and ${pct(bounded.approvalBps)}${governor.minYes > 0n ? `. Either needs at least ${shares(governor.minYes)} votes in favour` : ""}.`,
  ];
  const now = controlOf(weight, control, full);
  const small = controlOf(weight, control, bounded);
  lines.push(
    now === "nobody"
      ? "No decision that spends the treasury or changes the rules can pass now: the DAO's minimum turnout is more than all the votes that count."
      : now === "alone"
        ? `So ${who} can pass any decision alone, even if every other holder votes against it.`
        : now === "unopposed"
          ? `So ${who} can pass a decision alone when nobody else votes, but holders who vote against it can stop it${small === "alone" ? ` (an award or a work area ${who} can pass even against everyone)` : ""}.`
          : small !== "shared"
            ? `No single holder can pass a decision that spends the treasury or changes the rules alone, but ${who} can pass an award or a work area ${small === "alone" ? "even against everyone" : "that nobody else votes on"}.`
            : "No single holder can pass a decision alone.",
  );
  if (kind === "raise" && control.waiting > 0n) {
    lines.push(
      `${shares(control.waiting)} Shares bought in the sale are still waiting to be claimed and vote only once they are; with all of them claimed, ${who} would hold ${percentOf(weight, control.votingSupply + control.waiting)}.`,
    );
  }
  const until = now === "alone" ? sharesUntilShared(weight, control) : 0n;
  lines.push(
    kind === "contributors"
      ? `That changes only as Shares are awarded for accepted work, and as holders leave${until > 0n ? `: ${who} stops deciding alone once others hold about ${shares(until)} more Shares` : ""}.`
      : `It also changes as Shares are awarded for accepted work and as holders leave.`,
  );
  return lines;
}

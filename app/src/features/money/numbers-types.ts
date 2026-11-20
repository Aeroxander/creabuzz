/** The shapes of a version 2 record once it is read (`numbers.ts` parses it, `numbers-read.ts` reads it strictly). */
import type { ChainTasks } from "../tasks/chain/types";

/** Where a project is, in the words of the record: checked in, quiet, dormant, open to wind down, wound down. */
export type QuietState =
  | "active"
  | "quiet"
  | "dormant"
  | "may_wind_down"
  | "wound_down";
export interface GrantNumbers {
  id: number;
  member: string;
  /** A protected grant vests on calendar time, has no cliff and cannot be given up. */
  kind: "normal" | "protected";
  state: "live" | "announced" | "closed";
  granted: bigint;
  keeps: bigint;
  claimed: bigint;
  vested: bigint;
  claimable: bigint;
  startActive: number;
  /** Live, normal grants only. `endsAtIfActive` is not a promise: vesting runs on active time. */
  cliff: { passed: boolean; endsAtIfActive: number | null } | null;
  fullyVestedAtIfActive: number | null;
  /** Set only while the grant is announced: the part that burns, and when anyone may run the burn. */
  forfeit: { amount: bigint; burnAt: number; byMember: boolean } | null;
}

export interface AgentNumbers {
  agent: string;
  live: boolean;
  usdCap: bigint;
  teamCap: bigint;
  usdUsed: bigint;
  teamUsed: bigint;
}

export interface HolderNumbers {
  account: string;
  shares: bigint;
  teamShares: bigint;
}

export interface ProjectNumbers {
  removed: false;
  version: 2;
  key: string;
  projectId: string;
  founder: string;
  chainId: number;
  launcher: string;
  launchedAt: number;
  /** True when the dollar is play money. A record that does not say, or says something else, counts as true. */
  playMoney: boolean;
  contracts: {
    treasury: string;
    shares: string;
    team: string;
    vester: string;
    dollar: string;
    /** The Pair, once a second person took the seat. */
    pair: string | null;
  };
  /** The time unit in seconds (7 days on a real network); a "day" in every rate is a seventh of it. */
  unit: number;
  /** The platform's fee on money going in, in ten-thousandths. */
  feeBps: number;
  asOf: { block: number; time: number };
  /** When the server signed the record: the age of the server's work. */
  builtAt: number;
  /** How often the server promises a fresh record, in seconds. */
  refreshEverySecs: number;
  money: {
    pot: bigint;
    paidIn: bigint;
    arriving: bigint;
    arrivalEnd: number | null;
    feesOwed: bigint;
    locked: bigint;
    notesOwed: bigint;
    held: bigint;
  };
  shares: { backers: bigint; teamCounted: bigint; announcedBurn: bigint };
  /** What one whole Share would pay now, in dollar units: for lists. A person's own figure is a quote from the chain. */
  value: { leaveValue: bigint; teamValue: bigint };
  allowance: {
    ratePpm: number;
    pending: {
      ratePpm: number;
      proposedAt: number;
      applicableAt: number;
    } | null;
    box: bigint;
    boxCap: bigint;
    drawnLastDay: bigint;
  };
  clock: {
    lastCheckIn: number;
    lastRecordHash: string | null;
    activeUntil: number | null;
    activeSeconds: number;
  };
  door: { switchOn: boolean; openNow: boolean; shutsAt: number | null };
  quiet: {
    state: QuietState;
    since: number;
    quietFrom: number | null;
    dormantFrom: number | null;
    windableFrom: number | null;
    next: { state: QuietState; at: number } | null;
  };
  windDown: { kind: 1 | 2; at: number } | null;
  runner: {
    address: string;
    isPair: boolean;
    signers: [string, string] | null;
  };
  team: {
    pool: bigint;
    inHands: bigint;
    inVester: bigint;
    promised: bigint;
    ungranted: bigint;
    grantCount: number;
    grants: GrantNumbers[];
  };
  agents: AgentNumbers[];
  limits: {
    minJoin: bigint;
    minOutsidePayment: bigint;
    maxRatePpm: number;
    checkInWindowUnits: number;
    windDownUnits: number;
    cliffUnits: number;
    vestUnits: number;
    minGrant: bigint;
    maxGrantsPerMember: number;
    agentUsdPerDay: bigint;
    agentTeamPerDay: bigint;
  };
  totals: {
    joined: bigint;
    fees: bigint;
    tookOut: bigint;
    drawn: bigint;
    outside: bigint;
    /** What accepted tasks have been paid and what leavers' notes have been claimed (step 2); absent from an older record. */
    paidToWorkers?: bigint;
    noteClaims?: bigint;
  };
  /** When the project's first Back landed, or null before. */
  firstBackedAt: number | null;
  holders: HolderNumbers[];
  holderCount: number;
  teamHolderCount: number;
  /** A list was cut at its cap: "none" is never said about a cut list. */
  truncated: boolean;
  /**
   * The project's task queue, from the signed record (step 2): an object when the server wrote one and it reads; null when
   * the project has no task book; "unreadable" when the section did not parse (the rest of the record is believed); absent
   * when the server is older than step 2. Every task screen treats the last three as "no queue screens" (1.6).
   */
  tasks?: ChainTasks | null | "unreadable";
  /**
   * The step 3 keys (`numbers-social.ts`), each read on its own: a part that is absent or null is not known here, and a
   * part that cannot be believed reads as null while the rest of the record stands.
   */
  held?: HeldNumbers | null;
  feed?: FeedNumbers | null;
  streaks?: StreaksNumbers | null;
  established?: EstablishedNumbers | null;
}

/**
 * What the step 3 keys of a record say once read (`numbers-social.ts`; `docs/next-version/RECORD-V2.md` section 11). Each
 * is read apart from the money: absent (an older server) and null (the server could not work it out, or the key could
 * not be believed here) both mean "not known here", never "none" and never zero.
 */
export interface HeldWindow {
  /** Backer Shares held without a fall for the whole window (18 decimals). */
  shares: bigint;
  /** The part of all backer Shares that is, in ten-thousandths. */
  bps: number;
}
export interface HeldNumbers {
  windows: { rankSecs: number; badgeSecs: number };
  /** The ranking's window (30 days); null when that window could not be counted. */
  rank:
    | (HeldWindow & {
        /** What those Shares would get if taken out now (6 decimals): for lists and words. */
        money: bigint;
        /** Accounts holding at least the smallest Back at that lowest balance. */
        accounts: number;
      })
    | null;
  /** The badge's window (13 units); null when that window could not be counted. */
  badge: HeldWindow | null;
  /** Accounts that hold now at least the smallest Back. */
  countedAccounts: number;
}

export interface FeedHour {
  /** The hour's first second. */
  at: number;
  joins: number;
  tookOut: number;
  /** The net money in that hour, rounded to the feed's step: a direction and an absolute amount (0 when "even"). */
  net: { dir: "in" | "out" | "even"; amount: bigint };
}
export type FeedItemKind =
  | "task_planned"
  | "task_taken"
  | "task_paid"
  | "task_ended"
  | "task_withdrawn"
  | "update";
export interface FeedItem {
  kind: FeedItemKind;
  at: number;
  serial: number | null;
  /** When a planned task can first be taken, or when a taken one is due. */
  date: number | null;
}
export interface FeedNumbers {
  /** The step every amount is rounded to (100 dollars, 6 decimals). */
  roundTo: bigint;
  bucketSecs: number;
  /** The last hours, oldest first (48 from the server). */
  hours: FeedHour[];
  /** Things that are not money flows, newest first. Kinds this app does not know are left out. */
  items: FeedItem[];
  cut: number;
}

export interface StreaksNumbers {
  updates: { weeks: number; longest: number; lastAt: number | null };
}

export interface EstablishedNumbers {
  rule: { minHeldBps: number; heldSecs: number; minAccounts: number };
  heldBps: number | null;
  accounts: number | null;
  twoSigners: boolean;
  /** The server's verdict; null when it could not be worked out. */
  reached: boolean | null;
}

/** A launch that later left the chain: nothing about money is shown for it. */
export interface RemovedNumbers {
  removed: true;
  key: string;
}

export interface NumbersEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

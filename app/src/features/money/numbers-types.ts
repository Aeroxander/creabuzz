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
    /**
     * The project's holder pause contract (step 4): an address when the project has one and the record said so readably;
     * null when it has none, or the key was not believed; left out of a record signed before step 4.
     */
    pause?: string | null;
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
    /**
     * The kind of runner (milestone 9, `numbers-step9.ts`): "single", "pair" or "council". Absent in a record signed
     * before the key existed, and null when it could not be believed: the screens then read `isPair` as before.
     */
    kind?: RunnerKind | null;
    /** For a Council, the number of distinct non-zero live seats. */
    seats?: number | null;
  };
  team: {
    pool: bigint;
    inHands: bigint;
    inVester: bigint;
    promised: bigint;
    ungranted: bigint;
    grantCount: number;
    grants: GrantNumbers[];
    /**
     * The earlier backers' pool and what of it is still unclaimed (step 4); null when the project has none or the two were not
     * believed, left out of a record signed before step 4. `ungranted` already leaves the reserve out.
     */
    earlier?: { pool: bigint; reserve: bigint } | null;
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
  /**
   * The step 4 keys (`numbers-step4.ts`), each read on its own: absent (a record signed before step 4) and null (none, or
   * not believed) both mean "the app shows nothing about it"; `contracts.pause` set with `pause` null means "the stop exists
   * and could not be read".
   */
  pause?: PauseNumbers | null;
  earlierGrants?: EarlierGrantsNumbers | null;
  /**
   * The milestone 9 keys (`numbers-step9.ts`), each read on its own exactly as the step 4 keys are: nothing shows on a
   * project with no Council and no open vote, and a key that cannot be believed is null while the rest stands.
   */
  council?: CouncilNumbers | null;
  vote?: VoteNumbers | null;
  /**
   * The step 4 and milestone 9 keys as the record signed them, kept undecoded so their parser (`numbers-step9.ts`) loads
   * only with the screens that read them: the first download stays as small as it was. Absent from a record signed before
   * those keys existed.
   */
  step?: Record<string, unknown>;
}

/** The project's holder pause, from the record (RECORD-V2 section 13.1). Nothing here is per person. */
export interface PauseNumbers {
  contract: string;
  /** Shares parked now (18 decimals). */
  parkedTotal: bigint;
  /** The parked Shares that make the line. */
  line: bigint;
  /** The warning period in seconds. */
  dayLength: number;
  /** The line is one this-many-th of the backers' Shares; the words say "a third" only when this is 3. */
  lineDivisor: number;
  armedAt: number | null;
  pausesFrom: number | null;
  /** At the record's own time: whether the team's draws and new task plans are refused. */
  paused: boolean;
  since: number | null;
  /** How many accounts have Shares parked: a count, never a name. */
  parkerCount: number;
}

/** The earlier backers' claim contract, from the record (RECORD-V2 section 13.2). Never a row. */
export interface EarlierGrantsNumbers {
  contract: string;
  /** Tied to the project's Vester: claims can start. */
  bound: boolean;
  root: string;
  textHash: string;
  total: bigint;
  rows: number;
  claimedRows: number;
  claimedTotal: bigint;
  clockSecs: number;
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

// --- The Council runner, the vote and the Council (milestone 9; RECORD-V2 section 14, COUNCIL-PLAN.md 5.2) ---------------

export type RunnerKind = "single" | "pair" | "council";

export type VoteKind = "seats" | "replace";

/** Where a ballot stands. `waiting` starts at `voteEnd` whether or not anyone has recorded the result; `ended` is a
 * result that changes nothing (short, kept or unchanged). */
export type VotePhase =
  | "standing"
  | "voting"
  | "counting"
  | "waiting"
  | "carried-out"
  | "ended"
  | "lapsed";

export type VoteOutcome = "short" | "kept" | "moved" | "seated" | "unchanged";

export type VoteOptionKind = "keep" | "list" | "person";

/** Every number a vote sentence needs: the contract's own constants and views, never typed in a word file. */
export interface VoteRule {
  /** The stand window, in seconds (one day). */
  standSecs: number;
  /** The vote length, in seconds (three days). */
  voteSecs: number;
  /** The wait before a won result takes effect: the Treasury's longest task notice. */
  waitSecs: number;
  /** The turnout floor is one this-many-th of the snapshot's Shares. */
  floorDivisor: number;
  /** To open a replace vote, the Shares parked in all must be one this-many-th of the Shares. */
  openDivisor: number;
  /** To stand, an account needs one this-many-th of the snapshot's Shares. */
  standDivisor: number;
  /** The replace cooldown after a "kept" result that met the floor, in seconds. */
  cooldownSecs: number;
  /** Two seats come up every this many seconds. */
  seatsEverySecs: number;
  /** A Council proposal lives this long, in seconds. */
  proposalTtlSecs: number;
  /** How many Council seats must agree to an action. */
  needed: number;
  /** The number of Council seats (five). */
  seats: number;
  /** The most lists a replace ballot offers. */
  maxLists: number;
  /** The most people a seat ballot offers. */
  maxPeople: number;
  /** The smallest weight that can be cast, in Shares (18 decimals). */
  minVote: bigint;
}

/** One choice on the open ballot; option 0 is always "keep". */
export interface VoteOptionNumbers {
  index: number;
  kind: VoteOptionKind;
  /** The list's five accounts, or the one person; empty for "keep". */
  members: string[];
  /** Who put it forward; null for "keep". */
  proposer: string | null;
  /** The signed text's id; null for "keep". */
  recordHash: string | null;
  /** Its Shares (18 decimals). */
  tally: bigint;
}

/** The result the frozen tallies give, from `voteEnd` on. */
export interface VoteResultNumbers {
  outcome: VoteOutcome;
  /** The winning option numbers (at most two). */
  winners: number[];
  /** True once the result is recorded on the network; it must agree with the tallies. */
  recorded: boolean;
}

/** The newest ballot worth showing. */
export interface VoteOpenNumbers {
  id: number;
  kind: VoteKind;
  phase: VotePhase;
  openedAt: number;
  standEnd: number;
  voteEnd: number;
  effectiveAt: number;
  /** The backers' Shares at the snapshot (18 decimals). */
  supply: bigint;
  /** The Shares that must be cast (18 decimals). */
  floor: bigint;
  /** The Shares cast so far (18 decimals). */
  cast: bigint;
  options: VoteOptionNumbers[];
  /** Null before `voteEnd`. */
  result: VoteResultNumbers | null;
  carriedOutAt: number | null;
}

/** What the next ballots allow. */
export interface VoteNextNumbers {
  /** When two seats may be opened, or null when there is no Council. */
  seatsAt: number | null;
  /** When a replace vote may next open (the cooldown's end, or the present time). */
  replaceFrom: number | null;
  /** The parked Shares needed to open a replace vote now (one in `openDivisor` of the supply). */
  openFloor: bigint;
}

/** The project's vote contract (the project's pause). Null for a project with no vote contract, or one not believed. */
export interface VoteNumbers {
  contract: string;
  rule: VoteRule;
  open: VoteOpenNumbers | null;
  next: VoteNextNumbers;
}

export interface CouncilSeatNumbers {
  /** The account, or null for an open seat. */
  account: string | null;
  seatedAt: number | null;
}

/** The kinds of waiting Council action, as the record counts them. */
export type CouncilActionKind =
  | "draw"
  | "checkIn"
  | "rate"
  | "door"
  | "plan"
  | "accept"
  | "reject"
  | "cancel"
  | "grant"
  | "helper"
  | "handOver"
  | "windDown"
  | "other";

export interface CouncilWaitingKind {
  kind: CouncilActionKind;
  count: number;
}

/** The Council's open proposals, counted: never their bytes or amounts. */
export interface CouncilWaitingNumbers {
  count: number;
  kinds: CouncilWaitingKind[];
  /** True when more proposals wait than the count allows: "none" is never said about a cut list. */
  truncated: boolean;
}

/** The project's Council (COUNCIL-PLAN.md 5.2). */
export interface CouncilNumbers {
  contract: string;
  /** The five seats in order; null for an open seat. */
  seats: [
    CouncilSeatNumbers,
    CouncilSeatNumbers,
    CouncilSeatNumbers,
    CouncilSeatNumbers,
    CouncilSeatNumbers,
  ];
  /** How many seats must agree. */
  needed: number;
  /** Goes up whenever any seat changes. */
  generation: number;
  /** When two seats next come up. */
  nextElection: number;
  /** Which two seats come up. */
  upSeats: [number, number];
  /** Null when the server could not count them (the section then says nothing about waiting actions). */
  waiting: CouncilWaitingNumbers | null;
}

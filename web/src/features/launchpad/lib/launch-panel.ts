/**
 * The panel a founder names in the launch itself: who judges the team's milestones, how many must agree, and the bond
 * each posts. This turns what the form holds (every part still a string) into what the launch plan takes, or says in
 * plain words what is missing. The plan then checks the rest (nobody on the team, a token to pay claims in, and so on).
 *
 * Pure and alias-free: `launch-panel.test.mjs` drives it under `node --test`.
 */

import {
  DecisionInputError,
  parseUnits,
} from "@creaton/core/launchpad/daoActions.ts";
import {
  CHALLENGE_DEFAULTS,
  type DaoLaunchChallengeInput,
  type DaoLaunchPanelInput,
} from "@creaton/core/launchpad/daoLaunch.ts";

/** A panel stays open for two years by default: it has to outlast the last milestone, or nothing can unlock. */
export const PANEL_OPEN_SECONDS = 730 * 86_400;

/** How the team's milestones are let through: holders who can object, or a panel of named reviewers. */
export type ReviewMode = "challenge" | "panel";

export interface PanelDraft {
  /** Who lets the milestones through. */
  review: ReviewMode;
  /** For holders' objections: the bond the team posts with each milestone, in whole units of the sale currency; empty for the default. */
  challengeBond: string;
  /**
   * Test networks only: whole days a milestone waits for objections, a vote on one runs, and late objections stay open
   * after an unlock; empty for the defaults. A launch on a real network always uses the defaults.
   */
  challengeWindow: string;
  challengeVote: string;
  challengeLate: string;
  /** Wallet addresses, one per line (or separated by commas or spaces). */
  reviewers: string;
  /** How many must agree; empty means a simple majority. */
  quorum: string;
  /** The bond each posts, in whole units of the bond token; empty for none. */
  bond: string;
  /** What it is paid in: the sale currency (the safe default) or another token. */
  bondIn: "currency" | "other";
  bondOther: string;
  /** How the reviewers will work: how quickly they respond, whether they are paid, and any tie to the team. */
  terms: string;
  /** The founder has asked each reviewer and each agreed to judge these milestones on these terms. */
  agreed: boolean;
}

export const EMPTY_PANEL_DRAFT: PanelDraft = {
  review: "challenge",
  challengeBond: "",
  challengeWindow: "",
  challengeVote: "",
  challengeLate: "",
  reviewers: "",
  quorum: "",
  bond: "",
  bondIn: "currency",
  bondOther: "",
  terms: "",
  agreed: false,
};

/** The least a statement of how the reviewers will work must say to say anything. */
export const MIN_TERMS_CHARS = 20;
/** The most it can say: it is read on the sale page and kept on the launch record. */
export const MAX_TERMS_CHARS = 1_000;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** The people named, in order, however they were separated. */
export function reviewerList(text: string): string[] {
  return text.split(/[\s,;]+/).filter(Boolean);
}

/** What the form knows about the token a bond is paid in, so the amount can be turned into base units. */
export interface BondTokenFacts {
  /** The sale currency's decimals. */
  currencyDecimals: number;
  /** For another token: its decimals once read, or why not yet. */
  other: { decimals: number } | "loading" | "unreadable";
}

/** How long the panel stays open, in whole years, for the words that tell the founder. */
export const PANEL_OPEN_YEARS = Math.round(PANEL_OPEN_SECONDS / (365 * 86_400));

/**
 * How many reviewers could be unreachable before no milestone can be approved: the people named, less the number that must
 * agree. `null` until anyone is named or while the quorum is not a usable number (the form says so elsewhere).
 */
export function panelSpare(
  draft: Pick<PanelDraft, "reviewers" | "quorum">,
): { reviewers: number; needed: number; spare: number } | null {
  const reviewers = reviewerList(draft.reviewers).length;
  if (reviewers === 0) return null;
  const text = draft.quorum.trim();
  const needed = text === "" ? Math.floor(reviewers / 2) + 1 : Number(text);
  if (!Number.isInteger(needed) || needed < 1) return null;
  return { reviewers, needed, spare: reviewers - needed };
}

export function panelFromDraft(
  draft: PanelDraft,
  facts: BondTokenFacts,
  now: number,
): { panel: DaoLaunchPanelInput; terms: string } | { problem: string } {
  const reviewers = reviewerList(draft.reviewers);
  if (reviewers.length === 0) {
    return { problem: "Name who judges the milestones." };
  }
  // A panel that has not agreed to the job can strand an honest team: the reviewers are fixed at launch, and if too few
  // of them answer, no milestone can be approved. So the founder says they asked, and says how the reviewers will work,
  // and backers read it before they bid.
  if (!draft.agreed) {
    return {
      problem:
        "Confirm that you have asked each reviewer and that each agreed to judge your milestones.",
    };
  }
  const terms = draft.terms.trim();
  if (terms.length < MIN_TERMS_CHARS) {
    return {
      problem:
        "Say how your reviewers will work: how quickly they respond, whether they are paid, and any tie they have to your team.",
    };
  }
  if (terms.length > MAX_TERMS_CHARS) {
    return {
      problem: `Keep it under ${MAX_TERMS_CHARS} characters: backers read this before they bid.`,
    };
  }
  const quorumText = draft.quorum.trim();
  const quorum =
    quorumText === ""
      ? Math.floor(reviewers.length / 2) + 1
      : Number(quorumText);
  let bond = 0n;
  let bondToken = "";
  const bondText = draft.bond.trim();
  if (bondText !== "") {
    let decimals = facts.currencyDecimals;
    if (draft.bondIn === "other") {
      const token = draft.bondOther.trim();
      if (!ADDRESS_RE.test(token)) {
        return {
          problem: "Paste the address of the token the bond is paid in.",
        };
      }
      if (facts.other === "unreadable") {
        return {
          problem: "That address does not look like a token on this network.",
        };
      }
      if (facts.other === "loading") return { problem: "Reading that token…" };
      decimals = facts.other.decimals;
      bondToken = token;
    }
    try {
      bond = parseUnits(bondText, decimals, "bond", "The bond");
    } catch (error) {
      if (error instanceof DecisionInputError) {
        return { problem: error.message };
      }
      throw error;
    }
  }
  return {
    panel: {
      reviewers,
      quorum,
      bond,
      bondToken,
      endsAt: now + PANEL_OPEN_SECONDS,
      now,
    },
    terms,
  };
}

type ChallengeDraft = Pick<
  PanelDraft,
  "challengeBond" | "challengeWindow" | "challengeVote" | "challengeLate"
>;

const DAY = 86_400;

/** The shorter waits a test network may use, each in whole days within the lock's limits. */
const WAITS = [
  [
    "challengeWindow",
    "window",
    1,
    30,
    "A milestone waits for objections for 1 to 30 days.",
  ],
  [
    "challengeVote",
    "votePeriod",
    1,
    30,
    "A vote on an objection runs for 1 to 30 days.",
  ],
  [
    "challengeLate",
    "clawback",
    0,
    180,
    "Late objections stay open for 0 to 180 days.",
  ],
] as const;

/**
 * The holders' challenge a founder asked for: the defaults, a bond of their own if they typed one, and on a test network
 * the waits they typed (D138), so a milestone test fits in weeks. The plan checks the rest (the lock's own limits, and
 * that the sale's currency can pay a bond).
 */
export function challengeFromDraft(
  draft: ChallengeDraft,
  currencyDecimals: number,
  testNetwork = false,
): { challenge: DaoLaunchChallengeInput } | { problem: string } {
  const challenge: DaoLaunchChallengeInput = {};
  const text = draft.challengeBond.trim();
  if (text !== "") {
    try {
      challenge.bond = parseUnits(text, currencyDecimals, "bond", "The bond");
    } catch (error) {
      if (error instanceof DecisionInputError) {
        return { problem: error.message };
      }
      throw error;
    }
  }
  if (!testNetwork) return { challenge };
  for (const [field, key, least, most, problem] of WAITS) {
    const days = draft[field].trim();
    if (days === "") continue;
    if (!/^\d+$/.test(days) || Number(days) < least || Number(days) > most) {
      return { problem };
    }
    challenge[key] = Number(days) * DAY;
  }
  return { challenge };
}

/** The waits a launch would use, in seconds: what was typed where it counts, else the defaults. */
export function challengeWaits(
  draft: ChallengeDraft,
  testNetwork: boolean,
): { window: number; votePeriod: number; clawback: number } {
  const result = challengeFromDraft(
    { ...draft, challengeBond: "" },
    0,
    testNetwork,
  );
  const typed = "challenge" in result ? result.challenge : {};
  return {
    window: typed.window ?? CHALLENGE_DEFAULTS.window,
    votePeriod: typed.votePeriod ?? CHALLENGE_DEFAULTS.votePeriod,
    clawback: typed.clawback ?? CHALLENGE_DEFAULTS.clawback,
  };
}

const STORAGE_PREFIX = "buzz.launchpad.panel-draft:";

/**
 * The draft kept across a reload, per launch: a launch whose transaction was sent but not yet saved is finished from
 * the same terms (the receipt names the panel), so the reviewers the founder typed must not be lost with the page.
 * Anything that is not a well-formed draft is ignored.
 */
export function loadPanelDraft(
  launchKey: string,
  storage: Pick<Storage, "getItem"> | null = safeStorage(),
): PanelDraft {
  try {
    const raw = storage?.getItem(STORAGE_PREFIX + launchKey);
    if (!raw) return EMPTY_PANEL_DRAFT;
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object") return EMPTY_PANEL_DRAFT;
    const draft = value as Record<string, unknown>;
    const text = (key: string) =>
      typeof draft[key] === "string" ? (draft[key] as string) : "";
    return {
      // A draft saved before there was a choice, with reviewers typed into it, was a panel launch: keep it one.
      review:
        draft.review === "challenge" || draft.review === "panel"
          ? draft.review
          : text("reviewers").trim() !== ""
            ? "panel"
            : "challenge",
      challengeBond: text("challengeBond"),
      challengeWindow: text("challengeWindow"),
      challengeVote: text("challengeVote"),
      challengeLate: text("challengeLate"),
      reviewers: text("reviewers"),
      quorum: text("quorum"),
      bond: text("bond"),
      bondIn: draft.bondIn === "other" ? "other" : "currency",
      bondOther: text("bondOther"),
      terms: text("terms"),
      agreed: draft.agreed === true,
    };
  } catch {
    return EMPTY_PANEL_DRAFT;
  }
}

export function savePanelDraft(
  launchKey: string,
  draft: PanelDraft,
  storage: Pick<Storage, "setItem"> | null = safeStorage(),
): void {
  try {
    storage?.setItem(STORAGE_PREFIX + launchKey, JSON.stringify(draft));
  } catch {
    // Storage unavailable: the draft just does not survive a reload.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

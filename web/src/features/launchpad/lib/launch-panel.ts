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
import type { DaoLaunchPanelInput } from "@creaton/core/launchpad/daoLaunch.ts";

/** A panel stays open for two years by default: it has to outlast the last milestone, or nothing can unlock. */
export const PANEL_OPEN_SECONDS = 730 * 86_400;

export interface PanelDraft {
  /** Wallet addresses, one per line (or separated by commas or spaces). */
  reviewers: string;
  /** How many must agree; empty means a simple majority. */
  quorum: string;
  /** The bond each posts, in whole units of the bond token; empty for none. */
  bond: string;
  /** What it is paid in: the sale currency (the safe default) or another token. */
  bondIn: "currency" | "other";
  bondOther: string;
}

export const EMPTY_PANEL_DRAFT: PanelDraft = {
  reviewers: "",
  quorum: "",
  bond: "",
  bondIn: "currency",
  bondOther: "",
};

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

export function panelFromDraft(
  draft: PanelDraft,
  facts: BondTokenFacts,
  now: number,
): { panel: DaoLaunchPanelInput } | { problem: string } {
  const reviewers = reviewerList(draft.reviewers);
  if (reviewers.length === 0) {
    return { problem: "Name who judges the milestones." };
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
      reviewers: text("reviewers"),
      quorum: text("quorum"),
      bond: text("bond"),
      bondIn: draft.bondIn === "other" ? "other" : "currency",
      bondOther: text("bondOther"),
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

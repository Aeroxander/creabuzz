/**
 * A team's pledge to pay part of what the project earns into its treasury (D78).
 *
 * Money paid into the treasury raises every Share's part of it when someone leaves, so a pledge is how revenue reaches
 * holders here: no automatic payout, no dividend. The pledge is the team's statement, written (ideally) into a signed
 * document like the ones behind "who holds the IP"; the contracts do not enforce it, and every sentence about it says so.
 *
 * Pure and alias-free: `revenue-pledge.test.mjs` drives it under `node --test`.
 */

import {
  EMPTY_DOCUMENT,
  type IpDocument,
  type IpDocumentDraft,
  parseIpDocument,
} from "./ip-record.ts";

export type PledgeEvery = "month" | "quarter" | "year";

export interface RevenuePledge {
  v: 1;
  /** Whole percent of the project's net receipts, 1 to 100. */
  percent: number;
  /** How often it is paid in. */
  every: PledgeEvery;
  /** The last day it holds (YYYY-MM-DD), or null for as long as the project earns. */
  until: string | null;
  /** The signed document it is written into, or null when none is on record. */
  document: IpDocument | null;
}

const EVERY: readonly PledgeEvery[] = ["month", "quarter", "year"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const validDate = (value: unknown): string | null =>
  typeof value === "string" &&
  DATE.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    ? value
    : null;

/** The pledge as published, or null when it is not one this app can read. */
export function parseRevenuePledge(value: unknown): RevenuePledge | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const percent = raw.percent;
  if (
    typeof percent !== "number" ||
    !Number.isInteger(percent) ||
    percent < 1 ||
    percent > 100
  ) {
    return null;
  }
  if (!EVERY.includes(raw.every as PledgeEvery)) return null;
  return {
    v: 1,
    percent,
    every: raw.every as PledgeEvery,
    until: validDate(raw.until),
    document: parseIpDocument(raw.document),
  };
}

/** What to publish: only what is present, so an absent field never reads as a promise. */
export function revenuePledgeContent(
  pledge: RevenuePledge,
): Record<string, unknown> {
  const content: Record<string, unknown> = {
    v: 1,
    percent: pledge.percent,
    every: pledge.every,
  };
  if (pledge.until) content.until = pledge.until;
  if (pledge.document) content.document = pledge.document;
  return content;
}

/** The editor's state: what a person has typed, before it is checked. */
export interface PledgeDraft {
  percent: string;
  every: PledgeEvery;
  /** Blank for as long as the project earns. */
  until: string;
  document: IpDocumentDraft;
}

export function pledgeDraftFromRecord(
  pledge: RevenuePledge | null,
): PledgeDraft {
  return {
    percent: pledge ? String(pledge.percent) : "",
    every: pledge?.every ?? "quarter",
    until: pledge?.until ?? "",
    document: pledge?.document ? { ...pledge.document } : { ...EMPTY_DOCUMENT },
  };
}

/** Check a draft and make the pledge, or say what is wrong in plain words. */
export function pledgeFromDraft(
  draft: PledgeDraft,
): { pledge: RevenuePledge } | { problem: string } {
  const text = draft.percent.trim();
  if (text === "")
    return { problem: "Say what percent of net receipts you pledge." };
  if (!/^\d+$/.test(text))
    return { problem: "Use a whole percent, from 1 to 100." };
  const percent = Number(text);
  if (percent < 1 || percent > 100) {
    return { problem: "Use a whole percent, from 1 to 100." };
  }
  const until = draft.until.trim();
  if (until !== "" && validDate(until) === null) {
    return {
      problem: "Give the last day as a date (2030-12-31), or leave it blank.",
    };
  }
  const doc = draft.document;
  const blank =
    doc.title.trim() === "" &&
    doc.url.trim() === "" &&
    doc.sha256.trim() === "";
  const document = blank ? null : parseIpDocument(doc);
  if (!blank && document === null) {
    return {
      problem:
        "The document needs a title, an https link and its fingerprint, or leave all three blank.",
    };
  }
  return {
    pledge: {
      v: 1,
      percent,
      every: draft.every,
      until: until === "" ? null : until,
      document,
    },
  };
}

/** The pledge in one plain paragraph. */
export function pledgeSentence(pledge: RevenuePledge): string {
  const until = pledge.until
    ? `until ${pledge.until}`
    : "for as long as the project earns";
  const where = pledge.document
    ? `It is written into “${pledge.document.title}”.`
    : "It is not written into a signed document on record.";
  return `The team pledges ${pledge.percent}% of the project's net receipts, to be paid into the project's money every ${pledge.every}, ${until}. ${where} The contracts do not enforce it.`;
}

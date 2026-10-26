/**
 * Remixes, step one (N11, D121): where a project comes from. No money moves here.
 *
 * A project's record can say it is **built on** another project (its launch record's coordinate, also published as an
 * `a` tag so a parent finds its remixes with one query). A project can publish **remix terms**: whether it invites
 * projects built on it, what it asks in return (in words; step two would make some of it a contract), and what a remix
 * gets. Whether a remix's licence **fits** its parent's is worked out from both IP records (D38): the page says so, and
 * never claims to take back rights an open licence already gave.
 *
 * Pure and alias-free: `remix.test.mjs` drives it under `node --test`.
 */

import type { IpRecord } from "./ip-record.ts";

/** The launch record a project is built on: its author and id. */
export interface BuiltOn {
  author: string;
  id: string;
}

/** What a remix of this project gets. */
export type RemixOffer = "name" | "assets" | "announce" | "contributors";
export const REMIX_OFFERS: readonly RemixOffer[] = [
  "name",
  "assets",
  "announce",
  "contributors",
];

export interface RemixTerms {
  /** Whether the project invites projects built on it. */
  invited: boolean;
  /** What it asks in return, in its own words (empty for nothing). */
  asks: string;
  offers: RemixOffer[];
}

export const REMIX_ASKS_MAX = 500;
const PUBKEY_RE = /^[0-9a-f]{64}$/;
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function parseBuiltOn(value: unknown): BuiltOn | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  return typeof raw.author === "string" &&
    PUBKEY_RE.test(raw.author) &&
    typeof raw.id === "string" &&
    ID_RE.test(raw.id)
    ? { author: raw.author, id: raw.id }
    : null;
}

export function parseRemixTerms(value: unknown): RemixTerms | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.invited !== "boolean") return null;
  const asks =
    typeof raw.asks === "string"
      ? raw.asks.trim().slice(0, REMIX_ASKS_MAX)
      : "";
  const offers = Array.isArray(raw.offers)
    ? REMIX_OFFERS.filter((o) => (raw.offers as unknown[]).includes(o))
    : [];
  return { invited: raw.invited, asks, offers };
}

/** The parent's launch record coordinate, for the `a` tag. */
export function builtOnCoordinate(b: BuiltOn): string {
  return `37001:${b.author}:${b.id}`;
}

export function isBuiltOnCoordinate(value: string): boolean {
  return value.startsWith("37001:");
}

// ---- licence fit ------------------------------------------------------------------------------

const PERMISSIVE = new Set([
  "MIT",
  "APACHE-2.0",
  "BSD-2-CLAUSE",
  "BSD-3-CLAUSE",
  "ISC",
  "0BSD",
  "CC0-1.0",
  "CC-BY-4.0",
  "UNLICENSE",
]);
const SHARE_ALIKE = new Set([
  "GPL-2.0",
  "GPL-3.0",
  "AGPL-3.0",
  "LGPL-3.0",
  "MPL-2.0",
  "CC-BY-SA-4.0",
]);

/** A licence name as compared: upper case, without "-only" or "-or-later". */
export function normaliseLicence(name: string): string {
  return name
    .trim()
    .toUpperCase()
    .replace(/-(ONLY|OR-LATER)$/, "")
    .replace(/\+$/, "");
}

export type RemixFit =
  | { kind: "fits"; line: string }
  | { kind: "needs-same-licence"; line: string }
  | { kind: "needs-terms"; line: string }
  | { kind: "unknown"; line: string };

/** Whether a remix's licence fits what its parent's licence and terms allow, in one plain sentence. */
export function remixFit(
  parentName: string,
  parent: { ipRecord: IpRecord | null; remixTerms: RemixTerms | null },
  remix: { ipRecord: IpRecord | null },
): RemixFit {
  const ip = parent.ipRecord;
  const invited = parent.remixTerms?.invited
    ? {
        kind: "fits" as const,
        line: parent.remixTerms.asks
          ? `${parentName} invites projects built on it, and asks: ${parent.remixTerms.asks}`
          : `${parentName} invites projects built on it.`,
      }
    : null;
  if (!ip) {
    // An explicit invitation is permission enough when the parent never said who holds its work.
    if (invited) return invited;
    return {
      kind: "unknown",
      line: `${parentName} hasn't said who holds its work, so whether it can be built on is unclear.`,
    };
  }
  if (ip.holder === "open") {
    const licence = ip.licence ? normaliseLicence(ip.licence) : "";
    if (PERMISSIVE.has(licence)) {
      return {
        kind: "fits",
        line: `${parentName} is open under ${ip.licence}, which lets anyone build on it with credit.`,
      };
    }
    if (SHARE_ALIKE.has(licence)) {
      const mine =
        remix.ipRecord?.holder === "open" && remix.ipRecord.licence
          ? normaliseLicence(remix.ipRecord.licence)
          : "";
      return mine === licence
        ? {
            kind: "fits",
            line: `Both are open under ${ip.licence}, as ${parentName}'s licence asks.`,
          }
        : {
            kind: "needs-same-licence",
            line: `${parentName} is under ${ip.licence}, which asks that work built on it use ${ip.licence} too. This project doesn't say it does.`,
          };
    }
    return {
      kind: "unknown",
      line: `${parentName} is open under ${ip.licence ?? "a licence it doesn't name"}. Check that it allows building on it.`,
    };
  }
  if (invited) return invited;
  return {
    kind: "needs-terms",
    line: `${parentName}'s work is held by ${ip.holder === "entity" ? "its entity" : "its founders"}, and it doesn't invite projects built on it. Ask them first.`,
  };
}

/** What a remix gets, in words. */
export function offersLine(offers: readonly RemixOffer[]): string | null {
  if (offers.length === 0) return null;
  const words: Record<RemixOffer, string> = {
    name: "use of the name",
    assets: "its assets",
    announce: "an announcement to its community",
    contributors: "an invitation to its contributors",
  };
  const list = offers.map((o) => words[o]);
  const joined =
    list.length === 1
      ? list[0]
      : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
  return `A project built on it gets ${joined}.`;
}

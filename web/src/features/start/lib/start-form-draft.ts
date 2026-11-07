/**
 * The contributor project form as typed, kept in this browser so a reload or a closed tab does not lose a long setup
 * (names, reviewers, how the founder knows them, the first work areas). It is kept per server, per signed-in account,
 * and per Projects-board project it started from ("new" otherwise), and dropped only once the run itself has been
 * kept (the run then holds the draft) or the founder starts over.
 *
 * Pure and alias-free: `start-form-draft.test.mjs` drives it under `node --test`.
 */

import type { ContributorDraft, ProjectDraft } from "./contributor-project.ts";

const PREFIX = "buzz.start.contributor-form:";

export function formDraftKey(scope: {
  server: string;
  account: string;
  /** The Projects-board project the form started from, if any. */
  fromBoard?: string | null;
}): string {
  return `${PREFIX}${[scope.server, scope.account, scope.fromBoard || "new"]
    .map((part) => part.trim().toLowerCase())
    .join("|")}`;
}

const STRING_FIELDS = [
  "name",
  "pitch",
  "symbol",
  "founderShares",
  "budgetShares",
  "projectCap",
  "reviewers",
  "quorum",
] as const;

const isProject = (value: unknown): value is ProjectDraft =>
  value !== null &&
  typeof value === "object" &&
  typeof (value as ProjectDraft).name === "string" &&
  typeof (value as ProjectDraft).check === "string" &&
  typeof (value as ProjectDraft).shares === "string";

/** The kept form, or null when there is none or it is not well formed. */
export function loadFormDraft(
  key: string,
  storage: Pick<Storage, "getItem"> | null = safeStorage(),
): ContributorDraft | null {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as Record<string, unknown> | null;
    if (value === null || typeof value !== "object") return null;
    for (const field of STRING_FIELDS)
      if (typeof value[field] !== "string") return null;
    const { projects } = value;
    if (
      !Array.isArray(projects) ||
      projects.length === 0 ||
      !projects.every(isProject)
    )
      return null;
    for (const field of [
      "reviewerTies",
      "builtOn",
      "remixAsks",
      "saleLot",
      "saleCliffDays",
      "saleDays",
    ] as const)
      if (value[field] !== undefined && typeof value[field] !== "string")
        return null;
    if (
      value.remixInvited !== undefined &&
      typeof value.remixInvited !== "boolean"
    )
      return null;
    return value as unknown as ContributorDraft;
  } catch {
    return null;
  }
}

/**
 * The form kept under `key`, to bring back when the page comes to that key later (someone signs in on the page), or
 * null. Never over a form that already holds typing (`current` differs from `blank`): that is not thrown away.
 */
export function keptFormFor(
  key: string,
  current: ContributorDraft,
  blank: ContributorDraft,
  storage: Pick<Storage, "getItem"> | null = safeStorage(),
): ContributorDraft | null {
  if (JSON.stringify(current) !== JSON.stringify(blank)) return null;
  return loadFormDraft(key, storage);
}

/**
 * Keep the form as it is now, or forget it when it is just as it started (`blank`): nothing typed is nothing to bring
 * back. False when storage refused it, so the page can say a reload would lose it.
 */
export function saveFormDraft(
  key: string,
  draft: ContributorDraft,
  blank: ContributorDraft,
  storage: Pick<Storage, "setItem" | "removeItem"> | null = safeStorage(),
): boolean {
  if (!storage) return false;
  try {
    if (JSON.stringify(draft) === JSON.stringify(blank))
      storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function clearFormDraft(
  key: string,
  storage: Pick<Storage, "removeItem"> | null = safeStorage(),
): void {
  try {
    storage?.removeItem(key);
  } catch {
    // Nothing to forget if storage is unavailable.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

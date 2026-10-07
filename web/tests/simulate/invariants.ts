/**
 * What may never break while a story runs (plan §9). Every step of every scene
 * answers to these four, and the run reports what each one read — so a scene
 * that "worked" while the treasury went empty cannot look like a success.
 *
 * A check records what it read, not just a boolean: a failed invariant whose
 * only evidence is `false` cannot be diagnosed after the fact.
 */

export type Invariant =
  | "treasury-solvent"
  | "supply-conserved"
  | "spend-within-allowance"
  | "exits-neutral";

export const INVARIANTS: readonly Invariant[] = [
  "treasury-solvent",
  "supply-conserved",
  "spend-within-allowance",
  "exits-neutral",
];

export const INVARIANT_LABELS: Record<Invariant, string> = {
  "treasury-solvent": "The treasury can cover what it owes",
  "supply-conserved": "No tokens appear or disappear",
  "spend-within-allowance": "Nothing is spent past its allowance",
  "exits-neutral": "Leaving gains nobody anything",
};

export interface Check {
  invariant: Invariant;
  holds: boolean;
  /** The numbers or the sentence behind the reading. */
  detail: string;
}

/**
 * One step of a story: who acted, what they did, and what the four invariants
 * read immediately after.
 */
export interface TimelineEntry {
  scene: string;
  step: string;
  actor: string;
  checks: readonly Check[];
  /** A screenshot path or a note left beside the step. */
  artifact?: string;
}

/** Run the same reading against every invariant. */
export function checkAll(
  read: (invariant: Invariant) => { holds: boolean; detail: string },
): Check[] {
  return INVARIANTS.map((invariant) => ({ invariant, ...read(invariant) }));
}

/** The checks that did not hold — the only reason to stop or fail a run. */
export function failingChecks(checks: readonly Check[]): Check[] {
  return checks.filter((check) => !check.holds);
}

export function checksHold(checks: readonly Check[]): boolean {
  return failingChecks(checks).length === 0;
}

/**
 * A step that checks nothing is not a step the story can stand behind. This is
 * the rule that keeps "the happy path ran" from meaning "nothing was measured"
 * (Review-Proven Rule 3: a check nobody reads protects nothing).
 */
export function uncheckedSteps(entries: readonly TimelineEntry[]): string[] {
  return entries.filter((e) => e.checks.length === 0).map((e) => e.step);
}

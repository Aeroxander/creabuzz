/**
 * The founder commitments a sale needs before it can go live: a real story, how
 * often backers hear from the founder, and a monthly budget. A quick sale setup
 * does not ask for them, so the founder is asked at the point they matter.
 *
 * Alias-free on purpose: `commitments.test.mjs` drives it under `node --test`.
 */

import { budgetForShare } from "./wizard.ts";

export const CADENCES = [
  { value: "weekly", label: "Every week" },
  { value: "every two weeks", label: "Every two weeks" },
  { value: "monthly with KPIs", label: "Monthly, with numbers" },
] as const;

/** Shares of the raise a founder can commit to spending each month. */
export const BUDGET_CHOICES = [5, 10, 15, 20] as const;

export const MIN_STORY_LENGTH = 40;

export interface CommitmentForm {
  longPitch: string;
  cadence: string;
  /** Percent of the raise target spent per month. */
  budgetShare: number;
}

/** Why the commitments cannot be saved yet, or null when they can. */
export function commitmentIssue(form: CommitmentForm): string | null {
  if (form.longPitch.trim().length < MIN_STORY_LENGTH) {
    return `Tell backers a bit more: at least ${MIN_STORY_LENGTH} characters.`;
  }
  if (!CADENCES.some((cadence) => cadence.value === form.cadence)) {
    return "Choose how often you will update backers.";
  }
  if (!BUDGET_CHOICES.some((share) => share === form.budgetShare)) {
    return "Choose a monthly budget.";
  }
  return null;
}

/** The record fields the commitments write. */
export function commitmentFields(
  form: CommitmentForm,
  requiredRaised: string,
): { longPitch: string; updateCadence: string; budget: string } {
  return {
    longPitch: form.longPitch.trim(),
    updateCadence: form.cadence,
    budget: budgetForShare(requiredRaised, form.budgetShare),
  };
}

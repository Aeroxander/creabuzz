/**
 * What a founder still has to do between "the sale is prepared" and "people can
 * back it", in plain words. Derived from the record, so it can never disagree
 * with what is actually published.
 *
 * Alias-free on purpose: `sale-steps.test.mjs` drives it under `node --test`.
 */

import { hasFounderCommitments, type LaunchRecord } from "../models.ts";

export type SaleStepKey =
  | "prepared"
  | "commitments"
  | "deploy"
  | "open"
  | "announce";

export interface SaleStep {
  key: SaleStepKey;
  label: string;
  hint: string;
  done: boolean;
  /** Where the founder does it: here (commitments, go live), Manage, or the update dialog. */
  action: "commitments" | "manage" | "live" | "update" | null;
}

const OPEN_STAGES: readonly string[] = ["live", "funding", "graduated"];

export function saleSteps(
  record: Pick<
    LaunchRecord,
    | "stage"
    | "auction"
    | "token"
    | "longPitch"
    | "channels"
    | "budget"
    | "updateCadence"
  >,
  updateCount: number,
): SaleStep[] {
  return [
    {
      key: "prepared",
      label: "Sale prepared",
      hint: "Your terms are saved. You can still edit them.",
      done: true,
      action: null,
    },
    {
      key: "commitments",
      label: "Make your commitments",
      hint: "A longer story, how often you will update backers, and a monthly budget. Backers weigh these.",
      done: hasFounderCommitments(record as LaunchRecord),
      action: "commitments",
    },
    {
      key: "deploy",
      label: "Deploy the token and the sale",
      hint: "One guided flow on the Manage tab.",
      done: Boolean(record.auction && record.token),
      action: "manage",
    },
    {
      key: "open",
      label: "Open the sale to backers",
      hint: "Set the launch to Live so backers can bid.",
      done: OPEN_STAGES.includes(record.stage),
      action: "live",
    },
    {
      key: "announce",
      label: "Tell your supporters",
      hint: "Post an update so they know it is open.",
      done: updateCount > 0,
      action: "update",
    },
  ];
}

/**
 * True while the founder is still being walked through the sale: from prepared
 * until it has been live and announced. Later stages are the founder's own
 * business, not onboarding.
 */
export function isSetupStage(stage: LaunchRecord["stage"]): boolean {
  return stage === "draft" || stage === "review" || stage === "live";
}

/** The first step still to do, or null when everything is done. */
export function nextSaleStep(steps: readonly SaleStep[]): SaleStep | null {
  return steps.find((step) => !step.done) ?? null;
}

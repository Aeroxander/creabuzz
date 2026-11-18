/**
 * The projects a wallet has been named to judge. A reviewer is usually an outsider who holds no Shares and started
 * nothing, so none of the usual ways of finding "their" DAOs would ever find these. The launch receipt names the panel (it
 * is written when the project launches), so the projects can be found from the launches already read, without a chain
 * read per project; the DAO's own page then reads what is waiting.
 *
 * Alias-free: `reviewer-launches.test.mjs` drives it under `node --test`.
 */

import type { Launch } from "../models.ts";
import { daoOfLaunch } from "./dao-of-launch.ts";

/** The reviewers a launch's own receipt names, lower-cased; empty when it names none. */
export function namedReviewers(launch: Launch): string[] {
  const out = new Set<string>();
  for (const receipt of launch.receipts) {
    if (receipt.table !== "dao-launch") continue;
    const panel = receipt.payload.panel;
    if (panel === null || typeof panel !== "object") continue;
    const reviewers = (panel as { reviewers?: unknown }).reviewers;
    if (!Array.isArray(reviewers)) continue;
    for (const reviewer of reviewers) {
      if (typeof reviewer === "string") out.add(reviewer.toLowerCase());
    }
  }
  return [...out];
}

export interface ReviewerTarget {
  launch: Launch;
  dao: string;
}

/** The launches whose panel names `wallet`, with the DAO each belongs to. */
export function reviewerTargets(
  launches: readonly Launch[],
  wallet: string | null,
  skip: (launch: Launch) => boolean = () => false,
): ReviewerTarget[] {
  if (!wallet) return [];
  const me = wallet.toLowerCase();
  const out: ReviewerTarget[] = [];
  for (const launch of launches) {
    if (skip(launch)) continue;
    if (!namedReviewers(launch).includes(me)) continue;
    const dao = daoOfLaunch(launch);
    if (dao) out.push({ launch, dao });
  }
  return out;
}

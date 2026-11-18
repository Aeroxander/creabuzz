/**
 * What a contributor-only build (`raisesOffered()` false, the hosted pilot) lists and says about launches.
 *
 * Such a build has no sales, so it never lists one, never offers to back one, and never describes a project by its
 * money. A raise that another build published to the same server is left out of every listing here; its page stays
 * reachable by a direct link, without a button to put money in.
 *
 * Pure and alias-free: `contributor-only.test.mjs` drives it under `node --test`.
 */

import {
  FUNDING_SEEKING_LABELS,
  fundingSummary,
  isContributorProject,
  type FundingStatus,
  type ResolvedFunding,
} from "./funding.ts";
import { isIdea } from "./idea.ts";
import type { LaunchRecord } from "../models.ts";

/** The slice of a launch record these rules read. */
export interface ListedRecord {
  stage: LaunchRecord["stage"];
  auction: string | null;
  token: string | null;
  requiredRaised: string | null;
  floorPrice: string | null;
  funding?: FundingStatus | null;
  tokenPlan?: { mode: string } | null;
}

/**
 * Whether a launch belongs in this build's listings. Every build lists everything except a contributor-only one, which
 * lists contributor projects and ideas (which have no sale terms), and leaves raises out.
 */
export function listedHere(record: ListedRecord, raises: boolean): boolean {
  if (raises) return true;
  return isContributorProject(record) || isIdea(record);
}

/**
 * The funding line on a card or a project header. Where raises are offered it is the whole declaration ("Not raising ·
 * looking for contributors"); a contributor-only build says only who the project is looking for, never a word about
 * raising, and nothing at all when the project names no one but backers.
 */
export function fundingLine(
  funding: ResolvedFunding,
  raises: boolean,
): string | null {
  if (raises) return fundingSummary(funding);
  const wanted = funding.seeking.filter((who) => who !== "backers");
  if (wanted.length === 0) return null;
  return `Looking for ${wanted
    .map((who) => FUNDING_SEEKING_LABELS[who].toLowerCase())
    .join(", ")}`;
}

/**
 * The contributor projects whose Work tab may hold a step for this person, found without a chain read per project.
 *
 * Home looks at the DAOs a person holds Shares in, started, or was named a reviewer for in a launch receipt. A
 * contributor project's contributors hold no Shares until an award, and it publishes no such receipt, so its reviewers
 * and contributors would never be looked at. So two more sources:
 *
 * - the projects this person published evidence for (they submitted work there: its steps are theirs);
 * - the newest few contributor projects on this server, so a reviewer, who has no other tie to one, is found too. This
 *   is bounded and cheap to skip: the project's page decides what (if anything) is waiting, and a person with no part
 *   in it is shown nothing.
 *
 * Alias-free: `work-targets.test.mjs` drives it under `node --test`.
 */

import type { Launch } from "../models.ts";
import { daoOfLaunch } from "./dao-of-launch.ts";
import { isContributorProject } from "./funding.ts";

/** How many of the newest contributor projects are looked at for a person with no other tie to them. */
export const NEWEST_CONTRIBUTOR_PROJECTS = 2;

export interface WorkTarget {
  launch: Launch;
  dao: string;
  /**
   * Found only as one of the newest contributor projects, not by anything this person did there: it is looked at only
   * in slots their own projects leave free ({@link boundTargets}).
   */
  discovery: boolean;
}

/** Contributor projects whose work may wait on `me`: where they submitted work first, then the newest few. */
export function contributorWorkTargets(
  launches: readonly Launch[],
  me: string | null,
  skip: (launch: Launch) => boolean = () => false,
): WorkTarget[] {
  const out: WorkTarget[] = [];
  const seen = new Set<string>();
  const add = (launch: Launch, discovery: boolean) => {
    const dao = daoOfLaunch(launch);
    if (!dao || seen.has(dao)) return;
    seen.add(dao);
    out.push({ launch, dao, discovery });
  };
  const projects = launches
    .filter((launch) => !skip(launch) && isContributorProject(launch.record))
    .sort((a, b) => b.record.createdAt - a.record.createdAt);
  if (me) {
    for (const launch of projects) {
      if (launch.updates.some((u) => u.claim && u.author === me)) {
        add(launch, false);
      }
    }
  }
  for (const launch of projects.slice(0, NEWEST_CONTRIBUTOR_PROJECTS)) {
    add(launch, true);
  }
  return out;
}

/**
 * At most `max` projects to read: the person's own first (those they hold, started, review or submitted work to),
 * newest first, then projects found only by looking, in the slots left. A newer project somebody else started never
 * pushes out one this person is part of.
 */
export function boundTargets<
  T extends { launch: { record: { createdAt: number } }; dao: string },
>(own: readonly T[], discovery: readonly T[], max: number): T[] {
  const newest = (a: T, b: T) =>
    b.launch.record.createdAt - a.launch.record.createdAt;
  const picked = [...own].sort(newest).slice(0, max);
  const taken = new Set(picked.map((t) => t.dao));
  for (const found of [...discovery].sort(newest)) {
    if (picked.length >= max) break;
    if (taken.has(found.dao)) continue;
    taken.add(found.dao);
    picked.push(found);
  }
  return picked;
}

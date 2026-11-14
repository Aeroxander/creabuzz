/**
 * A team from the Projects board, as a contributor project (D84): the founder's declared stake becomes their starting
 * Shares, and each other role becomes a first project worth its stake, earned as the person in it delivers. Nothing is
 * handed out up front: a stake on the board is a promise, and here it becomes Shares only through accepted work.
 *
 * The scale: 1,000,000 Shares is the whole project once every role's work is awarded, so a 20% role is a project of
 * 200,000 Shares and a founder who declared 30% starts with 300,000.
 *
 * The contributor kit wants the founder's start to be at most a third of the first budget (D79). The budget is the
 * roles' Shares plus what the board left unassigned, and is made larger when that is not enough; the extra is room for
 * people who join later, and the founder sees it before anything is sent.
 *
 * Alias-free: `from-pitch.test.mjs` drives it under `node --test`.
 */

import {
  CONTRIBUTOR_DEFAULTS,
  type ContributorDraft,
  MAX_FIRST_PROJECTS,
  PROJECT_NAME_MAX,
  contributorSymbol,
  emptyProject,
} from "./contributor-project.ts";

/** Shares that stand for the whole project once every role's work is awarded. */
const WHOLE_PROJECT = 1_000_000n;

export interface PitchTeam {
  name: string;
  summary: string;
  /** The founder's declared stake, 0 to 100. */
  founderPct: number;
  /** Every other role, with the person in it when one was recorded. */
  roles: { slug: string; label: string; pct: number; holder: string | null }[];
}

export interface PitchStart {
  draft: ContributorDraft;
  /** Shares in the first budget that no role takes yet: room for people who join later. */
  roomWhole: bigint;
  /** Roles left out because the kit makes at most eight first projects; the project can vote them in later. */
  leftOut: string[];
  /** The founder declared no stake, so they start with 1% to be able to open votes. */
  founderDefaulted: boolean;
}

function sharesFor(pct: number): bigint {
  return (WHOLE_PROJECT * BigInt(Math.round(pct * 100))) / 10_000n;
}

/** A role's project name: its label when it fits, else its slug. */
function projectName(role: PitchTeam["roles"][number]): string {
  const label = role.label.trim();
  return label.length > 0 &&
    new TextEncoder().encode(label).length <= PROJECT_NAME_MAX &&
    !label.startsWith("0x")
    ? label
    : role.slug;
}

export function draftFromPitch(team: PitchTeam): PitchStart {
  const founderDefaulted = !(team.founderPct > 0);
  const founderWhole = sharesFor(founderDefaulted ? 1 : team.founderPct);
  const roles = team.roles
    .filter((role) => role.pct > 0)
    .sort((a, b) => b.pct - a.pct || a.slug.localeCompare(b.slug));
  const kept = roles.slice(0, MAX_FIRST_PROJECTS);
  const projects = kept.map((role) => ({
    name: projectName(role),
    check: `${role.label}: the work agreed for this role is delivered${role.holder ? ` by ${role.holder}` : ""}, and the reviewers accept it.`,
    shares: sharesFor(role.pct).toString(),
  }));
  const assigned = projects.reduce((sum, p) => sum + BigInt(p.shares), 0n);
  const rest = WHOLE_PROJECT - founderWhole;
  let budget = rest > assigned ? rest : assigned;
  if (founderWhole * 3n > budget) budget = founderWhole * 3n;
  const cap = projects.reduce(
    (max, p) => (BigInt(p.shares) > max ? BigInt(p.shares) : max),
    0n,
  );
  const capWhole = cap > 0n ? cap : BigInt(CONTRIBUTOR_DEFAULTS.projectCap);
  return {
    draft: {
      name: team.name.trim(),
      pitch: team.summary.trim(),
      symbol: contributorSymbol(team.name),
      founderShares: founderWhole.toString(),
      budgetShares: budget.toString(),
      projectCap: capWhole.toString(),
      reviewers: "",
      quorum: "",
      projects:
        projects.length > 0 ? projects : [emptyProject(capWhole.toString())],
    },
    roomWhole: budget - assigned,
    leftOut: roles.slice(MAX_FIRST_PROJECTS).map((role) => role.label),
    founderDefaulted,
  };
}

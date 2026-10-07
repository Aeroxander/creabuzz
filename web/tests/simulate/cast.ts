/**
 * The simulation's cast (plan §9): every seat a whole-project story needs, so
 * a scene can name who is acting instead of inventing a new actor each time.
 *
 * The counts are the plan's own — one founder, three backers, two
 * contributors, an agent and the human sponsor answerable for it, two
 * verifiers, and one seat whose job is to try to break the rules. That last
 * one is not decoration: the attack scenes are the ones that tell you whether
 * the money controls work.
 */

export type CastRole =
  | "founder"
  | "backer"
  | "contributor"
  | "agent"
  | "sponsor"
  | "verifier"
  | "troublemaker";

export interface CastMember {
  /** Stable id a scene names. */
  id: string;
  role: CastRole;
  name: string;
  /** What this seat exists to do in the story. */
  purpose: string;
}

export const CAST: readonly CastMember[] = [
  {
    id: "founder",
    role: "founder",
    name: "the founder",
    purpose: "declares the funding status, sets the terms, commits to updates",
  },
  {
    id: "backer-1",
    role: "backer",
    name: "the first backer",
    purpose: "backs the raise early and exits when allowed",
  },
  {
    id: "backer-2",
    role: "backer",
    name: "the second backer",
    purpose: "backs the raise and challenges a payout",
  },
  {
    id: "backer-3",
    role: "backer",
    name: "the third backer",
    purpose: "backs the raise and splits holdings across two wallets",
  },
  {
    id: "contributor-1",
    role: "contributor",
    name: "the first contributor",
    purpose: "earns shares by work and claims a milestone",
  },
  {
    id: "contributor-2",
    role: "contributor",
    name: "the second contributor",
    purpose:
      "earns shares by work and attests to the first contributor's claim",
  },
  {
    id: "agent",
    role: "agent",
    name: "the agent",
    purpose: "does the work its mandate allows, and nothing else",
  },
  {
    id: "sponsor",
    role: "sponsor",
    name: "the agent's sponsor",
    purpose: "pays for the agent and answers for what it does",
  },
  {
    id: "verifier-1",
    role: "verifier",
    name: "the first verifier",
    purpose: "verifies milestone claims against the check written up front",
  },
  {
    id: "verifier-2",
    role: "verifier",
    name: "the second verifier",
    purpose: "verifies claims and recuses themselves from their own",
  },
  {
    id: "troublemaker",
    role: "troublemaker",
    name: "the troublemaker",
    purpose:
      "tries self-approval, split wallets, flash buying, and buying to ragequit",
  },
];

/** The plan's cast, by role: 1 founder, 3 backers, 2 contributors, and so on. */
export const CAST_SHAPE: Record<CastRole, number> = {
  founder: 1,
  backer: 3,
  contributor: 2,
  agent: 1,
  sponsor: 1,
  verifier: 2,
  troublemaker: 1,
};

export function castByRole(role: CastRole): CastMember[] {
  return CAST.filter((member) => member.role === role);
}

export function castMember(id: string): CastMember | undefined {
  return CAST.find((member) => member.id === id);
}

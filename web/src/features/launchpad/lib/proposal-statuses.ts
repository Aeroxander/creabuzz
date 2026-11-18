/**
 * Where the decision behind each proposal post stands, for the board's list.
 *
 * A post's decision tag is a claim, so a status is given only when the DAO it
 * names belongs to a launch the app knows (see `dao-of-launch.ts`) and the
 * decision is in that DAO's own list. Anything else gets no status, and the
 * board treats it as settled: it sorts after the live ones and shows no pill.
 *
 * Alias-free; `proposal-statuses.test.mjs` drives it under `node --test`.
 */

import type { Decision } from "@creaton/core/launchpad/decisions.ts";

import type { Launch } from "../models.ts";
import { launchOfDao } from "./dao-of-launch.ts";
import { decisionStage, isLive } from "./decision-stage.ts";

/** The part of a proposal post this reads. */
export interface ProposalPost {
  id: string;
  proposal: { chainId: number; dao: string; id: string } | null;
}

export interface Status {
  label: string;
  tone: "open" | "good" | "wait" | "bad" | "done";
  live: boolean;
}

/** The distinct DAOs, by lower-case address, that known launches own among these posts. */
export function knownDaosOf(
  posts: readonly ProposalPost[],
  launches: readonly Launch[],
): string[] {
  const daos = new Set<string>();
  for (const post of posts) {
    const ref = post.proposal;
    if (ref && launchOfDao(launches, ref.chainId, ref.dao)) daos.add(ref.dao);
  }
  return [...daos];
}

export function proposalStatuses(
  posts: readonly ProposalPost[],
  launches: readonly Launch[],
  snapshots: ReadonlyMap<
    string,
    { chainTime: number; decisions: readonly Decision[] }
  >,
): Map<string, Status> {
  const out = new Map<string, Status>();
  for (const post of posts) {
    const ref = post.proposal;
    if (!ref || !launchOfDao(launches, ref.chainId, ref.dao)) continue;
    const snapshot = snapshots.get(ref.dao);
    const decision = snapshot?.decisions.find(
      (d) => d.id.toLowerCase() === ref.id,
    );
    if (!snapshot || !decision) continue;
    const stage = decisionStage(decision, snapshot.chainTime);
    out.set(post.id, {
      label: stage.label,
      tone: stage.tone,
      live: isLive(decision),
    });
  }
  return out;
}

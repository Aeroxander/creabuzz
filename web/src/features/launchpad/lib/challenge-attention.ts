/**
 * What a milestone that holders can object to asks of one person, as a line on Home and on the DAO's page: the team has a
 * milestone to finish or a bond to take back, a holder has evidence to read or a vote to cast, anyone can settle a vote
 * that has ended. It says nothing about a milestone that needs nothing from this person, so a quiet project is quiet.
 *
 * Pure and alias-free: `challenge-attention.test.mjs` drives it under `node --test`.
 */

import type { AttentionItem } from "./dao-overview.ts";
import type { ChallengeLockView } from "./milestone-challenge.ts";

const date = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });

/**
 * The lines for `wallet`, one per milestone that needs them. A holder is anyone not on the team who holds Shares in the DAO
 * (the caller only asks about DAOs the person is part of); the team is whoever the lock names.
 */
export function challengeAttention(
  view: ChallengeLockView,
  wallet: string,
): AttentionItem[] {
  const me = wallet.toLowerCase();
  const onTeam = view.team.includes(me);
  const items: AttentionItem[] = [];
  for (const m of view.milestones) {
    const n = m.index + 1;
    const key = `challenge-${m.index}`;
    const add = (
      kind: AttentionItem["kind"],
      suffix: string,
      text: string,
      action: string,
    ) =>
      items.push({
        key: `${key}-${suffix}`,
        kind,
        text,
        action,
        tab: "milestones",
      });
    switch (m.stage) {
      case "ready":
        add(
          "move",
          "finish",
          onTeam
            ? `Milestone ${n} waited out its objection window and nobody objected. Finish it to unlock your tokens.`
            : `Milestone ${n} waited out its objection window and nobody objected. Anyone can finish it.`,
          "Finish it",
        );
        break;
      case "waiting":
        if (!onTeam) {
          add(
            "review",
            "read",
            `The team published milestone ${n}. Holders can object until ${date(m.windowEnds)}. Read the evidence, and object if it was not reached.`,
            "Read the evidence",
          );
        }
        break;
      case "voting":
      case "late-voting": {
        const ends = m.objection?.voteEnds ?? 0;
        if (!onTeam) {
          add(
            "vote",
            "vote",
            `Holders are voting on an objection to milestone ${n} until ${date(ends)}. Your vote counts; the team's does not.`,
            "Vote",
          );
        }
        break;
      }
      case "vote-ended":
      case "late-vote-ended":
        add(
          "move",
          "settle",
          `The vote on milestone ${n} has ended. Anyone can settle it.`,
          "Settle it",
        );
        break;
      default:
        break;
    }
    // The bond comes back to whoever posted it once the month is over and nothing is open against it.
    if (
      onTeam &&
      m.submitter === me &&
      m.phase === "stood" &&
      m.bond > 0n &&
      !m.objection?.open &&
      view.now >= m.unlockedAt + view.terms.clawback
    ) {
      add(
        "payout",
        "bond",
        `The month after milestone ${n} unlocked is over. Take your bond back.`,
        "Return the bond",
      );
    }
  }
  return items;
}

/**
 * The sentences for the refusals that are new with milestone 9's two contracts (the vote contract, which is the project's
 * pause with ballots, and the Council), and what the Launcher and the Treasury say when the Council is not switched on.
 * Like `pot-copy-step4.ts` this is a leaf: `pot-copy.ts` keys its table by every error name of every ABI, so it does not
 * compile until each has words. Each sentence says what happened and what to do next, and shows no name, code or hex.
 *
 * The vote card's and the Council section's own sentences — the plan's section 6.2 table — are in
 * `app/src/features/council/council-words.ts`, which the screens that press these calls read; these are the plain path
 * (any other screen, any other action) and say the same things in fewer words.
 */
import type { DecodedValue } from "@creaton/core/launchpad/evmAbi.ts";
import { timeText } from "./numbers";
import type { Text } from "./pot-copy-tasks";

const NOTHING = "Nothing changed.";

const num = (v: DecodedValue | undefined): bigint =>
  typeof v === "bigint" ? v : 0n;

/** A time the contract names, in words; a missing argument is never shown as a number. */
const at = (v: DecodedValue | undefined): string => timeText(Number(num(v)));

/** Every refusal new with the vote contract, the Council and the switch that turns them on, for any action. */
export const VOTE_ERRORS = {
  // The vote contract
  VotingClosed: {
    any: "This vote has ended. Nothing was sent. The result is on the project page.",
  },
  StandingClosed: {
    any: "Names are final now: the vote has started. Nothing changed.",
  },
  NotEligible: {
    any: "Only Shares parked before the vote opened count for this. Nothing changed. You can take your money out any time.",
  },
  AlreadyStood: {
    any: "You already put a name forward in this vote. Nothing changed.",
  },
  BadMembers: {
    any: "A list needs five different accounts. Nothing changed.",
  },
  ProjectAccount: {
    any: "These accounts belong to the project and cannot hold a seat. Nothing changed.",
  },
  HoldsSeat: {
    any: "This account already holds a seat. Nothing changed.",
  },
  NoRoom: {
    any: "Every place is taken by a name with more Shares parked. Park more Shares to try again, or vote. Nothing changed.",
  },
  Cooldown: {
    any: (a: readonly DecodedValue[]) =>
      `A vote cannot open yet: the next one can open from ${at(a[0])}. Nothing changed.`,
  },
  BallotLive: {
    any: "A vote is already open. Nothing changed.",
  },
  NoBallot: {
    any: `There is no vote with that number. ${NOTHING}`,
  },
  NotFinished: {
    any: `The vote has not ended yet. ${NOTHING}`,
  },
  AlreadyFinished: {
    any: `The result is already recorded. ${NOTHING}`,
  },
  NotLapsable: {
    any: `This result cannot be let go. ${NOTHING}`,
  },
  NothingToDo: {
    any: `Nothing to do: this result is not due, or was already put in. ${NOTHING}`,
  },
  Settled: {
    any: `This vote is settled. ${NOTHING}`,
  },
  WoundDown: {
    any: `This project has wound down, so no vote can open. ${NOTHING}`,
  },
  BadKind: {
    any: `This vote is not the kind this step works on. ${NOTHING}`,
  },
  BadOption: {
    any: `That is not one of this vote's choices. ${NOTHING}`,
  },
  BadProject: {
    any: `This vote does not belong to this project. ${NOTHING}`,
  },
  TooEarly: {
    any: (a: readonly DecodedValue[]) =>
      `It is too early for this: it can be done from ${at(a[0])}. Nothing changed.`,
  },
  TooLate: {
    any: (a: readonly DecodedValue[]) =>
      `This ran out at ${at(a[0])}. Nothing changed.`,
  },
  // The Council
  AlreadyAgreed: {
    any: `You have already agreed to this. ${NOTHING}`,
  },
  AlreadySeated: {
    any: `This account already holds a seat. ${NOTHING}`,
  },
  BadCall: {
    any: `That call cannot run through the Council. ${NOTHING}`,
  },
  BadSeat: {
    any: `That seat cannot be filled. ${NOTHING}`,
  },
  NotDue: {
    any: (a: readonly DecodedValue[]) =>
      `This can be done from ${at(a[0])}. Nothing changed.`,
  },
  SeatsChanged: {
    any: "The seats changed since this was proposed. Propose it again if it is still needed. Nothing changed.",
  },
  // The Launcher and the Treasury: the Council is a switch the network may have left off
  NoCouncil: {
    any: `This network does not have Councils switched on. ${NOTHING}`,
  },
  BadSeatHolder: {
    any: "That account belongs to the project, so it cannot hold a seat. Nothing changed.",
  },
  NotVote: {
    any: `Only the project's vote contract can do this. ${NOTHING}`,
  },
  NotVoteCaller: {
    any: `Only the project's vote contract can make this Council. ${NOTHING}`,
  },
};

/**
 * What the older refusals say for a vote or Council step: none needs different words yet, and the screens that press
 * these calls read the plan's own sentences (`features/council/council-words.ts`).
 */
export const VOTE_EXTENSIONS: Record<string, Record<string, Text>> = {};

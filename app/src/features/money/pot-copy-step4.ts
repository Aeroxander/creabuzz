/**
 * The sentences for the refusals that are new with step 4's two contracts (the holder pause and the earlier backers' claim),
 * and what the older refusals say for a park, a take-back or a claim. Like `pot-copy-tasks.ts` it is a leaf: `pot-copy.ts`
 * keys its table by every error name of every ABI, so it does not compile until each has words. Each sentence says what
 * happened and what to do next, and shows no name, code or hex.
 */
import type { Text } from "./pot-copy-tasks";

/** What a person was doing when a step 4 press stopped. */
export type Step4Action = "park" | "take-back" | "earlier-claim";

const NOTHING = "Nothing changed.";

/** The errors that are new with the holder pause and the earlier claim: each has a sentence for any action. */
export const STEP4_ERRORS = {
  AlreadyBorn: {
    any: `This part of the project was already set up. ${NOTHING}`,
  },
  TransferFailed: {
    any: `The Shares could not be moved, so ${NOTHING.toLowerCase()} Try again in a moment.`,
  },
  NotLauncher: {
    any: `This step does not run from here. ${NOTHING}`,
  },
  NotBound: {
    "earlier-claim": `Claims are not open yet. ${NOTHING}`,
    any: `This is not switched on yet. ${NOTHING}`,
  },
  AlreadyBound: {
    any: `This part of the project was already set up. ${NOTHING}`,
  },
  WrongText: {
    "earlier-claim":
      "This page and the network name different texts, so nothing was claimed. Do not accept. Tell the person who sent you the link.",
    any: `The text does not match the one on the network. ${NOTHING}`,
  },
  BadRow: {
    "earlier-claim": `This link is not for the account you are using. Nothing was claimed. Open it with the account it was made for.`,
    any: `That does not fit the list. ${NOTHING}`,
  },
  AlreadyClaimed: {
    "earlier-claim": `This grant is already claimed. ${NOTHING}`,
    any: `This was already claimed. ${NOTHING}`,
  },
  BadProof: {
    "earlier-claim": `This link is not for the account you are using. Nothing was claimed. Open it with the account it was made for.`,
    any: `That does not match the list. ${NOTHING}`,
  },
  RowTooSmall: {
    "earlier-claim": `This grant is smaller than one whole Team Share, so it cannot be claimed. ${NOTHING}`,
    any: `That is smaller than the smallest grant. ${NOTHING}`,
  },
  OverPool: {
    "earlier-claim": `The pool for these grants cannot cover this one, so it was not claimed. ${NOTHING}`,
    any: `That is more than the pool holds. ${NOTHING}`,
  },
} as const satisfies Record<
  string,
  { any: Text } & Partial<Record<Step4Action, Text>>
>;

/** What the older refusals say for the three new actions (merged over their own sentences, like the task actions'). */
export const STEP4_EXTENSIONS = {
  BadInput: {
    park: `That is not an amount of Shares you can park. Choose an amount and try again. ${NOTHING}`,
    "take-back": `That is not an amount of Shares you can take back. ${NOTHING}`,
  },
  TooMuch: {
    "take-back": `You have fewer Shares parked than that. Take back less. ${NOTHING}`,
  },
  InsufficientBalance: {
    park: `You hold fewer Shares in your wallet than that. Nothing was parked. Choose a smaller amount.`,
  },
} as const satisfies Record<string, Partial<Record<Step4Action, Text>>>;

/** The press's name inside "... did not go through". */
export const STEP4_ACTION_WORDS: Record<Step4Action, string> = {
  park: "Parking your Shares",
  "take-back": "Taking your Shares back",
  "earlier-claim": "The claim",
};

/** What a park says when the network gave no reason: the plan's own sentence. */
export const PARK_FALLBACK =
  "The network did not take it. Nothing moved. Try again.";

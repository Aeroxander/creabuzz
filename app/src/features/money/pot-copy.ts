/**
 * Every refusal the money contracts can give (`contracts/pot`: the Treasury, the Vester, the Launcher, the Pair, the
 * Share tokens and the play dollar), as a sentence that says what happened and what to do next. The screens show only
 * what `potProblem` returns, so no contract name, code or hex reaches a person.
 *
 * `ErrorWords` is keyed by every error name in the generated ABIs, so a contract that gains an error does not compile here
 * until it has words, and `pot-copy.test.ts` walks every error of every ABI besides.
 */
import type { DecodedValue } from "@creaton/core/launchpad/evmAbi.ts";
import { isUserRejection } from "@creaton/core/launchpad/wallet-errors.ts";
import { type Abi, decodeRevert } from "@creaton/core/pot/abi-codec.ts";
import {
  EARLIER_GRANTS_ABI,
  HOLDER_PAUSE_ABI,
  LAUNCHER_ABI,
  PAIR_ABI,
  PLAY_DOLLAR_ABI,
  SHARE_TOKEN_ABI,
  TASK_BOOK_ABI,
  TREASURY_ABI,
  VESTER_ABI,
} from "@creaton/core/pot/abis.generated.ts";
import { moneyProblem, passkeyClosedWords } from "./money-copy";
import { dollarsText, timeText } from "./numbers";
import {
  NEW_TASK_ERRORS,
  TASK_ACTION_WORDS,
  TASK_EXTENSIONS,
  type TaskAction,
  type Text,
} from "./pot-copy-tasks";
import {
  PARK_FALLBACK,
  STEP4_ACTION_WORDS,
  STEP4_ERRORS,
  STEP4_EXTENSIONS,
  type Step4Action,
} from "./pot-copy-step4";
import { WalletStepError } from "./wallet";

/** What a person was doing when a step stopped; some refusals read better said for one of them. */
export type PotAction =
  | "back"
  | "take-out"
  | "take-out-team"
  | "check-in"
  | "draw"
  | "rate"
  | "door"
  | "grant"
  | "claim"
  | "forfeit"
  | "revenue"
  | "faucet"
  | "agent"
  | "seat"
  | "launch"
  | "link"
  | "wind-down"
  | "pair"
  | Step4Action
  | TaskAction;

const ABIS: readonly Abi[] = [
  TREASURY_ABI,
  TASK_BOOK_ABI,
  VESTER_ABI,
  LAUNCHER_ABI,
  PAIR_ABI,
  SHARE_TOKEN_ABI,
  PLAY_DOLLAR_ABI,
  HOLDER_PAUSE_ABI,
  EARLIER_GRANTS_ABI,
];

type ErrorItem<T> = T extends { type: "error"; name: infer N } ? N : never;
/** The name of every custom error in the seven ABIs (the task book's included). */
export type PotErrorName =
  | ErrorItem<(typeof TREASURY_ABI)[number]>
  | ErrorItem<(typeof TASK_BOOK_ABI)[number]>
  | ErrorItem<(typeof VESTER_ABI)[number]>
  | ErrorItem<(typeof LAUNCHER_ABI)[number]>
  | ErrorItem<(typeof PAIR_ABI)[number]>
  | ErrorItem<(typeof SHARE_TOKEN_ABI)[number]>
  | ErrorItem<(typeof PLAY_DOLLAR_ABI)[number]>
  | ErrorItem<(typeof HOLDER_PAUSE_ABI)[number]>
  | ErrorItem<(typeof EARLIER_GRANTS_ABI)[number]>;

type Words = { any: Text } & Partial<Record<PotAction, Text>>;

const num = (v: DecodedValue | undefined): bigint =>
  typeof v === "bigint" ? v : 0n;

const NOTHING = "Nothing changed.";

/** "1 dollar", "25 dollars", "2.50 dollars". */
const dollarsPhrase = (raw: bigint): string =>
  raw === 1_000_000n ? "1 dollar" : `${dollarsText(raw)} dollars`;

/**
 * The sentence for each error that was worded before the task book, for any action and, where it reads better, for one
 * action. The errors new with the task book, and what the older ones say for a task step, are in `pot-copy-tasks.ts`.
 */
const EARLIER_WORDS: Record<
  Exclude<
    PotErrorName,
    keyof typeof NEW_TASK_ERRORS | keyof typeof STEP4_ERRORS
  >,
  Words
> = {
  // The Treasury
  AlreadyWoundDown: {
    any: "This project has wound down, so this cannot be done. Taking out your Shares still works.",
  },
  BadInput: {
    draw: "The allowance can only be sent to another person's account, and the amount must be more than nothing. Nothing was sent.",
    rate: "That allowance does not fit. Lower it right away, or announce a higher one within the limit. Nothing changed.",
    grant:
      "A grant must go to another person's account and be more than nothing. Nothing changed.",
    seat: "The seat can only be offered to another account. Nothing changed.",
    "take-out":
      "That is not a number of Shares you can take out. Choose an amount and try again. Nothing changed.",
    any: `Something in this request does not fit, for example an amount of nothing or an account that cannot receive it. ${NOTHING} Check it and try again.`,
  },
  BadSetup: {
    any: "This project was not set up completely, so this step cannot run. Nothing changed.",
  },
  BelowMinimum: {
    back: (a) =>
      `That is below the smallest amount you can back with, ${dollarsPhrase(num(a[0]))}. Nothing was taken. Enter at least that.`,
    revenue: (a) =>
      `That is below the smallest outside payment, ${dollarsPhrase(num(a[0]))}. Nothing was taken. Enter at least that.`,
    any: "That is below the smallest amount allowed. Nothing was taken. Enter more.",
  },
  CapAmountTooLarge: {
    any: "That amount is too large for the daily limit to follow. Choose a smaller amount. Nothing was sent.",
  },
  CapExceeded: {
    draw: "That is more than this helper may draw today. Draw less, wait for tomorrow, or ask the person who runs the project to raise its limit. Nothing was sent.",
    grant:
      "That is more Team Shares than this helper may grant today. Nothing changed.",
    any: "That is more than the daily limit allows. Nothing changed. Try less, or try again tomorrow.",
  },
  DoorShut: {
    back: "This project is not taking new backers right now: the person who runs it closed the door, or has not checked in lately. Nothing was taken.",
    any: "This project is not taking new backers right now. Nothing changed.",
  },
  Inconsistent: {
    any: "Something in the project's numbers did not add up, so nothing was done. Nothing changed. Try again in a moment.",
  },
  Paused: {
    // The contract's line is one third (a constant of the pause contract this build is made for).
    any: "The team's spending is paused by holders. Try again when parked Shares fall below a third.",
  },
  BindClosed: {
    any: "The one-time step to switch this on is closed. Nothing changed.",
  },
  NotDeployer: {
    any: "Only the person who put these contracts on the network can do this. Nothing changed.",
  },
  NoOwner: {
    revenue:
      "Nobody holds any Shares in this project yet, so a payment would have no one to go to. Nothing was taken.",
    any: "Nobody holds any Shares in this project yet. Nothing changed.",
  },
  NotAllowed: {
    "check-in": "Only the person who runs the project can check in.",
    draw: "Only the person who runs the project, or a helper inside its daily limit, can draw from the allowance. Nothing was sent.",
    rate: "Only the person who runs the project can change the allowance. Nothing changed.",
    door: "Only the person who runs the project can open or shut the door. Nothing changed.",
    grant:
      "Only the person who runs the project can grant Team Shares. Nothing changed.",
    agent:
      "Only the person who runs the project can set its helpers. Nothing changed.",
    seat: "This account was not offered the seat. Nothing changed.",
    forfeit:
      "Only the member the grant is for can give it up. Nothing changed.",
    "wind-down":
      "A project can be wound down by the person who runs it, or by anyone after it has been quiet for a long time. Nothing changed.",
    pair: "Only the other signer can confirm this: the one who proposed it cannot confirm it too. Nothing changed.",
    any: `This account may not do this. ${NOTHING}`,
  },
  NotYet: {
    rate: (a) =>
      `The announced allowance can be applied from ${timeText(Number(num(a[0])))}. Try again then. Nothing changed.`,
    forfeit: (a) =>
      `The notice is still running. The Shares can be removed from ${timeText(Number(num(a[0])))}. Try again then. Nothing changed.`,
    any: (a) =>
      `It is too early for this. Try again after ${timeText(Number(num(a[0])))}. Nothing changed.`,
  },
  NothingToPay: {
    "take-out":
      "Those Shares would pay nothing right now, so nothing was taken out. Try a larger amount, or wait until the project holds more money.",
    "take-out-team":
      "Team Shares pay only what the project holds above what backers put in, and that is nothing right now. Nothing was taken out.",
    any: `There is nothing to pay out right now. ${NOTHING}`,
  },
  OfferExpired: {
    any: "The offer of the seat ran out. Ask for a new one. Nothing changed.",
  },
  ProjectQuiet: {
    any: "The team has not checked in lately, so no task can be planned or taken until they do. Nothing changed.",
  },
  Reentrancy: {
    any: "Another step on this project was still running. Nothing changed. Try again in a moment.",
  },
  SafeERC20FailedOperation: {
    any: "The dollar could not be moved. Check that you hold enough dollars, then try again. Nothing changed.",
  },
  TokenMisbehaved: {
    any: "The dollar moved a different amount than asked, so nothing changed.",
  },
  TooFewShares: {
    back: "The price moved while you were deciding, so you would get fewer Shares than the sheet showed. Nothing was taken. Look at the new numbers and press again.",
    any: "The numbers moved while you were deciding. Nothing was taken. Look again and press again.",
  },
  TooLittleCash: {
    "take-out":
      "The project's money moved while you were deciding, so you would get less than the sheet showed. Nothing was taken out. Look at the new number and press again.",
    "take-out-team":
      "The project's money moved while you were deciding, so you would get less than the sheet showed. Nothing was taken out. Look again and press again.",
    any: "The numbers moved while you were deciding. Nothing was taken. Look again and press again.",
  },
  TooManyShares: {
    any: "That would make more Shares than a project can hold. Choose a smaller amount. Nothing was taken.",
  },
  TooMuch: {
    draw: "That is more than the allowance box holds right now. Draw less, or wait: the box fills a little each day. Nothing was sent.",
    revenue:
      "That is more than a single outside payment can be. Choose a smaller amount. Nothing was taken.",
    any: "That is more than is available. Choose less. Nothing changed.",
  },
  ZeroMint: {
    back: "That amount is too small to buy any Shares right now. Nothing was taken. Try a larger amount.",
    any: "That amount is too small. Nothing was taken. Try a larger amount.",
  },
  // The Vester
  AlreadyInitialized: {
    any: `This part of the project was already set up. ${NOTHING}`,
  },
  BadGrant: {
    grant:
      "A grant must go to another person's account and be at least one whole Team Share. Nothing changed.",
    any: "That grant does not fit. Nothing changed.",
  },
  NotFunded: {
    grant:
      "The project does not have that many Team Shares left to grant. Choose a smaller amount. Nothing changed.",
    any: "The project does not have what this needs yet. Nothing changed.",
  },
  NotWoundDown: {
    any: "This can be done only after the project has wound down. Nothing changed.",
  },
  NothingToBurn: {
    any: "There is nothing waiting to be removed here. Nothing changed.",
  },
  NothingToClaim: {
    claim:
      "Nothing has unlocked on this grant since the last claim. Try again later.",
    any: "There is nothing to claim here yet. Try again later.",
  },
  ProtectedGrant: {
    any: "This grant is protected, so it cannot be given up. Nothing changed.",
  },
  TooManyGrants: {
    grant:
      "This person already has the most grants one person can have on this project. Nothing changed.",
    any: "This person already has the most grants one person can have. Nothing changed.",
  },
  UnknownGrant: {
    any: "This project has no grant with that number. Nothing changed.",
  },
  WrongState: {
    forfeit:
      "This grant is not in a state this step works on: a notice may already be running, or the grant may be settled. Nothing changed.",
    any: "This is not in a state this step works on. Nothing changed.",
  },
  // The Launcher
  BadName: {
    any: "The project's name and symbol must each be 1 to 64 letters long. Nothing was created.",
  },
  BadSettings: {
    any: "Creaton's settings are not valid. Nothing changed.",
  },
  BadStack: {
    any: "The project's parts could not be put together. Nothing was created. Try again.",
  },
  BadTerms: {
    launch:
      "The allowance or the Team pool is outside what is allowed. Nothing was created. Choose smaller ones.",
    any: "Those terms are outside what is allowed. Nothing changed.",
  },
  FailedDeployment: {
    any: "The project could not be created on the network. Nothing was created. Try again.",
  },
  InsufficientBalance: {
    "take-out":
      "You hold fewer Shares than that. Nothing was taken out. Choose a smaller amount.",
    any: "An account did not hold enough for this. Nothing changed.",
  },
  NotAdmin: {
    any: "Only Creaton's administrator can do this. Nothing changed.",
  },
  NotRunner: {
    any: "Only the account that runs this project can do this. Nothing changed.",
  },
  ProjectExists: {
    launch:
      "This project is already on the network from this account. Nothing was created.",
    any: "This project is already on the network. Nothing changed.",
  },
  SettingsMoved: {
    launch:
      "Creaton's settings changed while you were deciding. Nothing was created; press again to launch under the new settings.",
    any: "Creaton's settings changed. Nothing changed; try again.",
  },
  UnknownProject: {
    any: "The network does not know this project. Nothing changed.",
  },
  // The Pair
  BadTarget: {
    any: "A Pair can only call its own project's money and launch. Nothing changed.",
  },
  Expired: {
    pair: "This waiting call ran out of time. Propose it again if it is still wanted. Nothing changed.",
    any: "This ran out of time. Start it again if it is still wanted. Nothing changed.",
  },
  UnknownCall: {
    any: "This call is not waiting any more: it was confirmed or withdrawn. The list here catches up in a moment.",
  },
  // The Share tokens
  BadBirth: {
    any: "These Shares were not set up correctly. Nothing changed.",
  },
  NotController: {
    any: "Only the project's own money contract can do this. Nothing changed.",
  },
  ZeroRecipient: {
    any: "Shares cannot go to the empty account. Choose another account. Nothing changed.",
  },
  // The play dollar
  ERC1363ApproveFailed: {
    any: `The project did not accept the approval. ${NOTHING}`,
  },
  ERC1363InvalidReceiver: {
    back: "The project would not take this payment, so nothing was taken. Try again in a moment.",
    any: "The receiving account would not take this payment, so nothing was sent.",
  },
  ERC1363InvalidSpender: {
    any: "That account cannot be allowed to take dollars. Nothing changed.",
  },
  ERC1363TransferFailed: {
    back: "The project did not accept this payment, so nothing was taken. Try again in a moment.",
    any: "The payment was not accepted, so nothing was sent.",
  },
  ERC1363TransferFromFailed: {
    any: "The payment was not accepted, so nothing was sent.",
  },
  ERC20InsufficientAllowance: {
    any: "You have not yet let the project take that many dollars. Nothing was taken. Press again to allow it.",
  },
  ERC20InsufficientBalance: {
    any: "Your account does not hold enough dollars for this. Nothing was taken. On this test network you can take 1,000 play dollars once from the faucet.",
  },
  ERC20InvalidApprover: {
    any: `That account cannot be used here. ${NOTHING}`,
  },
  ERC20InvalidReceiver: {
    any: `Dollars cannot be sent to that account. ${NOTHING}`,
  },
  ERC20InvalidSender: {
    any: `That account cannot be used here. ${NOTHING}`,
  },
  ERC20InvalidSpender: {
    any: `That account cannot be allowed to take dollars. ${NOTHING}`,
  },
  FaucetUsed: {
    faucet:
      "This account already took its play dollars. Each account can take them once. Nothing changed.",
    any: "This account already took its play dollars. Nothing changed.",
  },
  NotATestChain: {
    any: "Play dollars exist only on a test network. Nothing changed.",
  },
};

/** Every error's sentences: the earlier ones with what they say for a task step, and the task book's own. */
const ERROR_WORDS: Record<PotErrorName, Words> = (() => {
  const merged: Record<string, Words> = { ...EARLIER_WORDS };
  for (const extensions of [TASK_EXTENSIONS, STEP4_EXTENSIONS])
    for (const [name, more] of Object.entries(extensions)) {
      const earlier = merged[name];
      if (earlier) merged[name] = { ...earlier, ...more };
    }
  return {
    ...merged,
    ...NEW_TASK_ERRORS,
    ...STEP4_ERRORS,
  } as Record<PotErrorName, Words>;
})();

/** The names the sentences above are keyed by (the test walks them against the ABIs). */
export const POT_ERROR_NAMES = Object.keys(ERROR_WORDS) as PotErrorName[];

const ACTION_WORDS: Record<PotAction, string> = {
  back: "Your backing",
  "take-out": "Taking out your Shares",
  "take-out-team": "Taking out your Team Shares",
  "check-in": "The check-in",
  draw: "The draw",
  rate: "Changing the allowance",
  door: "Changing the door",
  grant: "The grant",
  claim: "The claim",
  forfeit: "Giving up the grant",
  revenue: "The payment",
  faucet: "Taking the play dollars",
  agent: "Changing the helper",
  seat: "The seat",
  launch: "Putting the project on the network",
  link: "The link to your account",
  "wind-down": "Winding down",
  pair: "The call",
  ...TASK_ACTION_WORDS,
  ...STEP4_ACTION_WORDS,
};

/** What `potProblem` says when it knows nothing more about an action; the test tells it from a sentence made for an error. */
export function potFallback(action: PotAction): string {
  if (action === "park") return PARK_FALLBACK;
  return `${ACTION_WORDS[action]} did not go through. Nothing changed. Try again.`;
}

/** Every string and hex blob inside a provider's error, however deeply it nests them. */
function textsOf(error: unknown, depth = 0): string[] {
  if (depth > 4 || error === null || error === undefined) return [];
  if (typeof error === "string") return [error];
  if (typeof error !== "object") return [];
  const e = error as Record<string, unknown>;
  return ["message", "data", "error", "cause", "reason"].flatMap((field) =>
    textsOf(e[field], depth + 1),
  );
}

/** The contract refusal inside an error: its name and arguments, or null when the error is not one of ours. */
export function potRefusalOf(
  error: unknown,
): { name: PotErrorName; args: readonly DecodedValue[] } | null {
  const texts = textsOf(error);
  // A node's message can carry the selector alone ("custom error 0x7a537613: ...") beside the full revert data. The longest
  // blob goes first, so the arguments (a date, an amount) are read from the data and not lost to the bare selector.
  const blobs = texts
    .flatMap((text) =>
      [...text.matchAll(/0x[0-9a-fA-F]{8,}/g)].map((b) => b[0]),
    )
    .sort((a, b) => b.length - a.length);
  for (const blob of blobs) {
    const found = decodeRevert(ABIS, blob);
    if (found && found.name in ERROR_WORDS)
      return { name: found.name as PotErrorName, args: found.args };
  }
  // The node's own words ("execution reverted: DoorShut()"): the name alone, as a whole word.
  for (const text of texts)
    for (const name of POT_ERROR_NAMES)
      if (new RegExp(`\\b${name}\\b`).test(text)) return { name, args: [] };
  return null;
}

function said(text: Text, args: readonly DecodedValue[]): string {
  return typeof text === "function" ? text(args) : text;
}

function isRejectionCode(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === 4001 || code === "ACTION_REJECTED";
}

/** "your wallet" said of a passkey account is "your account": the same sentence for the person it is about. */
function forSender(text: string, error: unknown): string {
  if (!(error instanceof WalletStepError) || error.sender !== "passkey")
    return text;
  return text
    .replace(/\byour wallet\b/g, "your account")
    .replace(/\bYour wallet\b/g, "Your account");
}

/** What a person reads when a money step of the join-and-leave design stops. */
export function potProblem(error: unknown, action: PotAction): string {
  return forSender(potProblemOf(error, action), error);
}

function potProblemOf(error: unknown, action: PotAction): string {
  const cause = error instanceof WalletStepError ? error.cause : error;
  const refusal = potRefusalOf(cause);
  if (refusal) {
    const words = ERROR_WORDS[refusal.name];
    return said(words[action] ?? words.any, refusal.args);
  }
  const closed = passkeyClosedWords(error);
  if (closed) return closed;
  if (error instanceof WalletStepError) {
    // The sender's own stops (no wallet, wrong network, still waiting, no network coin) read as they do everywhere.
    if (error.reason !== "reverted" && error.reason !== "failed")
      return moneyProblem(error, "connect");
    if (/insufficient funds/i.test(textsOf(error.cause).join(" ")))
      return moneyProblem(error, "connect");
    if (
      isRejectionCode(error.cause) ||
      isUserRejection(textsOf(error.cause).join(" "))
    )
      return "You said no in your wallet. Nothing was sent.";
  } else if (error instanceof Error && isUserRejection(error.message)) {
    return "You said no in your wallet. Nothing was sent.";
  }
  return potFallback(action);
}

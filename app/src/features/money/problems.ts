/**
 * What a person reads when a money step stops: a sentence that says what happened and what to do next, for every refusal the
 * money contracts can give (`contracts/pot`: the Treasury, the task book, the Vester, the Launcher, the Pair, the Share tokens
 * and the play dollar) and for every stop of the sender. The screens show only what `potProblem` returns: no contract name,
 * code or hex reaches a person.
 *
 * `ERROR_WORDS` is keyed by every error name in the generated ABIs, so a contract that gains an error does not compile here
 * until it has words, and `problems.test.ts` walks every error of every ABI besides. The words of numbers and the fixed
 * lines are in `copy.ts`.
 */
import type { DecodedValue } from "@creaton/core/launchpad/evmAbi.ts";
import { isUserRejection } from "@creaton/core/launchpad/wallet-errors.ts";
import { type Abi, decodeRevert } from "@creaton/core/pot/abi-codec.ts";
import {
  LAUNCHER_ABI,
  PAIR_ABI,
  PLAY_DOLLAR_ABI,
  SHARE_TOKEN_ABI,
  TASK_BOOK_ABI,
  TREASURY_ABI,
  VESTER_ABI,
} from "@creaton/core/pot/abis.generated.ts";
import {
  ACCOUNT_MISMATCH_WORDS,
  dollarsPhrase,
  PASSKEY_WRONG_NETWORK_WORDS,
  percentOfBps,
} from "./copy";
import { timeText } from "./numbers";
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
  | "faucet"
  | "launch"
  | "claim-note"
  | "connect";

const ABIS: readonly Abi[] = [
  TREASURY_ABI,
  TASK_BOOK_ABI,
  VESTER_ABI,
  LAUNCHER_ABI,
  PAIR_ABI,
  SHARE_TOKEN_ABI,
  PLAY_DOLLAR_ABI,
];

type ErrorItem<T> = T extends { type: "error"; name: infer N } ? N : never;
/** The name of every custom error in the ABIs (the task book's included). */
type PotErrorName =
  | ErrorItem<(typeof TREASURY_ABI)[number]>
  | ErrorItem<(typeof TASK_BOOK_ABI)[number]>
  | ErrorItem<(typeof VESTER_ABI)[number]>
  | ErrorItem<(typeof LAUNCHER_ABI)[number]>
  | ErrorItem<(typeof PAIR_ABI)[number]>
  | ErrorItem<(typeof SHARE_TOKEN_ABI)[number]>
  | ErrorItem<(typeof PLAY_DOLLAR_ABI)[number]>;

/** One sentence, or one made from the refusal's arguments. */
type Text = string | ((args: readonly DecodedValue[]) => string);
type Words = { any: Text } & Partial<Record<PotAction, Text>>;

const num = (v: DecodedValue | undefined): bigint =>
  typeof v === "bigint" ? v : 0n;
const bps = (v: DecodedValue | undefined) => percentOfBps(Number(num(v)));
const at = (v: DecodedValue | undefined) => timeText(Number(num(v)));

const NOTHING = "Nothing changed.";

/** An error that reads the same whatever the person was doing. */
const w = (any: Text): Words => ({ any });

/** The claim of money owed from a task: what is said when there is nothing to claim, and when the task has not ended. */
export const CLAIM_NOTHING_WORDS = `There is nothing to claim here: the task was paid in full, or you already claimed. ${NOTHING}`;
export const claimNotYetWords = (until: number): string =>
  `This task has not ended yet, so there is nothing to claim. It ends by ${timeText(until)}.`;

/** The sentence for each error, for any action and, where it reads better, for one action. */
const ERROR_WORDS: Record<PotErrorName, Words> = {
  // The Treasury
  AlreadyWoundDown: w(
    "This project has wound down, so this cannot be done. Taking out your Shares still works.",
  ),
  BadInput: {
    draw: "The allowance can only be sent to another person's account, and the amount must be more than nothing. Nothing was sent.",
    rate: "That allowance does not fit. Lower it right away, or announce a higher one within the limit. Nothing changed.",
    grant:
      "A grant must go to another person's account and be more than nothing. Nothing changed.",
    "take-out":
      "That is not a number of Shares you can take out. Choose an amount and try again. Nothing changed.",
    any: `Something in this request does not fit, for example an amount of nothing or an account that cannot receive it. ${NOTHING} Check it and try again.`,
  },
  BadSetup: w(
    "This project was not set up completely, so this step cannot run. Nothing changed.",
  ),
  BelowMinimum: {
    back: (a) =>
      `That is below the smallest amount you can back with, ${dollarsPhrase(num(a[0]))}. Nothing was taken. Enter at least that.`,
    any: "That is below the smallest amount allowed. Nothing was taken. Enter more.",
  },
  CapAmountTooLarge: w(
    "That amount is too large for the daily limit to follow. Choose a smaller amount. Nothing was sent.",
  ),
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
  Inconsistent: w(
    "Something in the project's numbers did not add up, so nothing was done. Nothing changed. Try again in a moment.",
  ),
  Paused: {
    // The contract's line is one third (a constant of the pause contract this build is made for).
    any: "The team's spending is paused by holders. Try again when parked Shares fall below a third.",
  },
  BindClosed: w(
    "The one-time step to switch this on is closed. Nothing changed.",
  ),
  NotDeployer: w(
    "Only the person who put these contracts on the network can do this. Nothing changed.",
  ),
  NoOwner: w("Nobody holds any Shares in this project yet. Nothing changed."),
  NotAllowed: {
    "check-in": "Only the person who runs the project can check in.",
    draw: "Only the person who runs the project, or a helper inside its daily limit, can draw from the allowance. Nothing was sent.",
    rate: "Only the person who runs the project can change the allowance. Nothing changed.",
    door: "Only the person who runs the project can open or shut the door. Nothing changed.",
    grant:
      "Only the person who runs the project can grant Team Shares. Nothing changed.",
    forfeit:
      "Only the member the grant is for can give it up. Nothing changed.",
    any: `This account may not do this. ${NOTHING}`,
  },
  NotYet: {
    rate: (a) =>
      `The announced allowance can be applied from ${at(a[0])}. Try again then. Nothing changed.`,
    forfeit: (a) =>
      `The notice is still running. The Shares can be removed from ${at(a[0])}. Try again then. Nothing changed.`,
    "claim-note": (a) => claimNotYetWords(Number(num(a[0]))),
    any: (a) =>
      `It is too early for this. Try again after ${at(a[0])}. Nothing changed.`,
  },
  NothingToPay: {
    "take-out":
      "Those Shares would pay nothing right now, so nothing was taken out. Try a larger amount, or wait until the project holds more money.",
    "take-out-team":
      "Team Shares pay only what the project holds above what backers put in, and that is nothing right now. Nothing was taken out.",
    "claim-note": CLAIM_NOTHING_WORDS,
    any: `There is nothing to pay out right now. ${NOTHING}`,
  },
  OfferExpired: w(
    "The offer of the seat ran out. Ask for a new one. Nothing changed.",
  ),
  ProjectQuiet: w(
    "The team has not checked in lately, so no task can be planned or taken until they do. Nothing changed.",
  ),
  Reentrancy: w(
    "Another step on this project was still running. Nothing changed. Try again in a moment.",
  ),
  SafeERC20FailedOperation: w(
    "The dollar could not be moved. Check that you hold enough dollars, then try again. Nothing changed.",
  ),
  TokenMisbehaved: w(
    "The dollar moved a different amount than asked, so nothing changed.",
  ),
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
  TooManyShares: w(
    "That would make more Shares than a project can hold. Choose a smaller amount. Nothing was taken.",
  ),
  TooMuch: {
    draw: "That is more than the allowance box holds right now. Draw less, or wait: the box fills a little each day. Nothing was sent.",
    any: "That is more than is available. Choose less. Nothing changed.",
  },
  ZeroMint: {
    back: "That amount is too small to buy any Shares right now. Nothing was taken. Try a larger amount.",
    any: "That amount is too small. Nothing was taken. Try a larger amount.",
  },
  // The task book (the holder side reads what is owed; the rest are the contracts' own refusals)
  ShareTooBig: w(
    "That is more of the project's money than one task may ask for. Nothing changed.",
  ),
  TooManyOpen: w(
    "The most tasks are already planned or taken. Nothing changed.",
  ),
  NoSuchTask: w("The network does not know that task. Nothing changed."),
  WrongTaskState: w(
    `This task is not in a state this step works on. ${NOTHING}`,
  ),
  NoticeRunning: w(
    (a) =>
      `The notice is still running. This task can be taken from ${at(a[0])}. ${NOTHING}`,
  ),
  TakeWindowOver: w(
    "The time to take this task is over, so it lapses and nothing was set aside.",
  ),
  CapReached: w(
    (a) =>
      `Too much of the project's money has been set aside for tasks recently: ${bps(a[0])} of the ${bps(a[2])} the limit allows, and this task needs ${bps(a[1])}. Nothing was set aside.`,
  ),
  TakesFull: w(
    "The limit on tasks taken recently has been reached, so this one cannot be taken yet. Try again later. Nothing was set aside.",
  ),
  // The Vester
  AlreadyInitialized: w(
    `This part of the project was already set up. ${NOTHING}`,
  ),
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
  NotWoundDown: w(
    "This can be done only after the project has wound down. Nothing changed.",
  ),
  NothingToBurn: w(
    "There is nothing waiting to be removed here. Nothing changed.",
  ),
  NothingToClaim: {
    claim:
      "Nothing has unlocked on this grant since the last claim. Try again later.",
    any: "There is nothing to claim here yet. Try again later.",
  },
  ProtectedGrant: w(
    "This grant is protected, so it cannot be given up. Nothing changed.",
  ),
  TooManyGrants: {
    grant:
      "This person already has the most grants one person can have on this project. Nothing changed.",
    any: "This person already has the most grants one person can have. Nothing changed.",
  },
  UnknownGrant: w(
    "This project has no grant with that number. Nothing changed.",
  ),
  WrongState: {
    forfeit:
      "This grant is not in a state this step works on: a notice may already be running, or the grant may be settled. Nothing changed.",
    any: "This is not in a state this step works on. Nothing changed.",
  },
  // The Launcher
  BadName: w(
    "The project's name and symbol must each be 1 to 64 letters long. Nothing was created.",
  ),
  BadSettings: w("Creaton's settings are not valid. Nothing changed."),
  BadStack: w(
    "The project's parts could not be put together. Nothing was created. Try again.",
  ),
  BadTerms: {
    launch:
      "The allowance or the Team pool is outside what is allowed. Nothing was created. Choose smaller ones.",
    any: "Those terms are outside what is allowed. Nothing changed.",
  },
  FailedDeployment: w(
    "The project could not be created on the network. Nothing was created. Try again.",
  ),
  InsufficientBalance: {
    "take-out":
      "You hold fewer Shares than that. Nothing was taken out. Choose a smaller amount.",
    any: "An account did not hold enough for this. Nothing changed.",
  },
  NotAdmin: w("Only Creaton's administrator can do this. Nothing changed."),
  NotRunner: w(
    "Only the account that runs this project can do this. Nothing changed.",
  ),
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
  UnknownProject: w("The network does not know this project. Nothing changed."),
  // The Pair
  BadTarget: w(
    "A Pair can only call its own project's money and launch. Nothing changed.",
  ),
  Expired: w(
    "This ran out of time. Start it again if it is still wanted. Nothing changed.",
  ),
  UnknownCall: w(
    "This call is not waiting any more: it was confirmed or withdrawn. The list here catches up in a moment.",
  ),
  // The Share tokens
  BadBirth: w("These Shares were not set up correctly. Nothing changed."),
  NotController: w(
    "Only the project's own money contract can do this. Nothing changed.",
  ),
  ZeroRecipient: w(
    "Shares cannot go to the empty account. Choose another account. Nothing changed.",
  ),
  // The play dollar
  ERC1363ApproveFailed: w(
    `The project did not accept the approval. ${NOTHING}`,
  ),
  ERC1363InvalidReceiver: {
    back: "The project would not take this payment, so nothing was taken. Try again in a moment.",
    any: "The receiving account would not take this payment, so nothing was sent.",
  },
  ERC1363InvalidSpender: w(
    "That account cannot be allowed to take dollars. Nothing changed.",
  ),
  ERC1363TransferFailed: {
    back: "The project did not accept this payment, so nothing was taken. Try again in a moment.",
    any: "The payment was not accepted, so nothing was sent.",
  },
  ERC1363TransferFromFailed: w(
    "The payment was not accepted, so nothing was sent.",
  ),
  ERC20InsufficientAllowance: w(
    "You have not yet let the project take that many dollars. Nothing was taken. Press again to allow it.",
  ),
  ERC20InsufficientBalance: w(
    "Your account does not hold enough dollars for this. Nothing was taken. On this test network you can take 1,000 play dollars once from the faucet.",
  ),
  ERC20InvalidApprover: w(`That account cannot be used here. ${NOTHING}`),
  ERC20InvalidReceiver: w(`Dollars cannot be sent to that account. ${NOTHING}`),
  ERC20InvalidSender: w(`That account cannot be used here. ${NOTHING}`),
  ERC20InvalidSpender: w(
    `That account cannot be allowed to take dollars. ${NOTHING}`,
  ),
  FaucetUsed: {
    faucet:
      "This account already took its play dollars. Each account can take them once. Nothing changed.",
    any: "This account already took its play dollars. Nothing changed.",
  },
  NotATestChain: w(
    "Play dollars exist only on a test network. Nothing changed.",
  ),
};

/** The names the sentences above are keyed by (the test walks them against the ABIs). */
export const POT_ERROR_NAMES = Object.keys(ERROR_WORDS) as PotErrorName[];

/** The press's name inside "... did not go through". */
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
  faucet: "Taking the play dollars",
  launch: "Putting the project on the network",
  "claim-note": "The claim",
  connect: "Connecting to your account",
};

/** What `potProblem` says when it knows nothing more about an action; the test tells it from a sentence made for an error. */
export function potFallback(action: PotAction): string {
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

function isRejectionCode(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === 4001 || code === "ACTION_REJECTED";
}

/**
 * Whether `error` is named `name`. By name, not by class: the sending code that throws the sponsor's refusal loads only on
 * a passkey send, and importing it here would put it in the first download.
 */
function errorNamed(error: unknown, name: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    (error as { name?: unknown }).name === name
  );
}

/** What a person reads when they close the passkey prompt. */
const PASSKEY_CLOSED_WORDS = "You closed the passkey prompt. Nothing was sent.";

/** The sentence for a passkey step whose prompt was closed or timed out, or null when this is not that. */
function passkeyClosedWords(error: unknown): string | null {
  return error instanceof WalletStepError &&
    error.sender === "passkey" &&
    (errorNamed(error.cause, "NotAllowedError") ||
      errorNamed(error.cause, "AbortError"))
    ? PASSKEY_CLOSED_WORDS
    : null;
}

/** What a stop of the sender itself says (no wallet, wrong network, still waiting, no network coin), or null when it is not one. */
function senderStopWords(error: WalletStepError): string | null {
  const passkey = error.sender === "passkey";
  switch (error.reason) {
    case "no-wallet":
      return "There is no wallet in this browser. Open this page in a browser with a wallet to go on.";
    case "not-set-up":
      return "Backing from this phone is not switched on for this server yet. Open this page in a browser with a wallet to back now.";
    case "no-passkey":
      return "This browser does not hold the passkey for an account here, so it cannot back from one. Sign in with your passkey on the phone where you made it, or open this page in a browser with a wallet.";
    case "account-mismatch":
      return ACCOUNT_MISMATCH_WORDS;
    case "not-known":
      return "This app will not send that from your passkey account: it is not one of this project's contracts. Nothing was sent.";
    case "wrong-network":
      return passkey
        ? PASSKEY_WRONG_NETWORK_WORDS
        : "Your wallet is on another network. Switch it to the project's network and try again.";
    case "pending":
      return passkey
        ? "It was sent, but it has not landed yet. Press again in a few minutes to look for it: it is not sent a second time while it may still land."
        : "Your wallet sent it, but it has not landed yet. Press again in a few minutes to look for it: it is not sent a second time while it may still land.";
    case "replaced":
      return passkey
        ? "Another step from your account took its place, so this cannot be looked up here. If it went through, the numbers here show it soon. If they do not change, press again to send it."
        : "Your wallet sent this again as another call (sped up or cancelled), so it cannot be looked up here. Look in your wallet's activity: if it went through, the numbers here show it soon. If it did not, press again to send it.";
    default:
      // The node's own words when the wallet cannot pay for sending: the network's coin, not dollars.
      return /insufficient funds/i.test(textsOf(error.cause).join(" "))
        ? passkey
          ? "The server could not pay the network fee for this. Nothing was sent. Try again later."
          : "Your wallet needs a little of the network's own coin to pay for sending this. Add some and try again; nothing was sent."
        : null;
  }
}

/** "your wallet" said of a passkey account is "your account": the same sentence for the person it is about. */
function forSender(text: string, error: unknown): string {
  if (!(error instanceof WalletStepError) || error.sender !== "passkey")
    return text;
  return text
    .replace(/\byour wallet\b/g, "your account")
    .replace(/\bYour wallet\b/g, "Your account");
}

/** What a person reads when a money step stops: a sentence that says what happened and what to do next. */
export function potProblem(error: unknown, action: PotAction): string {
  return forSender(potProblemOf(error, action), error);
}

function potProblemOf(error: unknown, action: PotAction): string {
  const cause = error instanceof WalletStepError ? error.cause : error;
  const refusal = potRefusalOf(cause);
  if (refusal) {
    const words = ERROR_WORDS[refusal.name];
    const text = words[action] ?? words.any;
    return typeof text === "function" ? text(refusal.args) : text;
  }
  const closed = passkeyClosedWords(error);
  if (closed) return closed;
  if (error instanceof WalletStepError) {
    const stop = senderStopWords(error);
    if (stop) return stop;
    if (errorNamed(error.cause, "PaymasterDeniedError"))
      return "The free network fee was refused for this account, for example because today's free sends are used up. Nothing was sent. Try again tomorrow, or use a browser with a wallet.";
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

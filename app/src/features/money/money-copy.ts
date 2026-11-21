/**
 * Every problem a money step can meet, as a sentence that says what happened and what to do next (the auction-copy.ts
 * pattern). The screens only show what this returns: contract refusal names, wallet codes and network words never reach
 * a person. `money-copy.test.ts` walks every refusal the contracts can give these calls.
 */
import { selectorOf } from "@creaton/core/launchpad/evmAbi.ts";
import { isUserRejection } from "@creaton/core/launchpad/wallet-errors.ts";
import { WalletStepError } from "./wallet";

export type MoneyAction =
  | "back"
  | "refund"
  | "take-out"
  | "check-in"
  | "open"
  | "connect";

/** The contracts' refusals these calls can meet (Rounds, Vester, Treasury, Launcher, the dollar token). */
const REFUSALS = [
  "WrongPhase()",
  "BadAmount()",
  "NothingToRefund()",
  "NotAllowed()",
  "CannotOpen()",
  "TokenMisbehaved()",
  "CapReached(uint256)",
  "WrongStage()",
  "NotRunner()",
  "WrongRunner(uint8)",
  "ERC20InsufficientBalance(address,uint256,uint256)",
  "ERC20InsufficientAllowance(address,uint256,uint256)",
] as const;
type Refusal =
  | "WrongPhase"
  | "BadAmount"
  | "NothingToRefund"
  | "NotAllowed"
  | "CannotOpen"
  | "TokenMisbehaved"
  | "CapReached"
  | "WrongStage"
  | "NotRunner"
  | "NotEnoughDollars"
  | "NoGas";

const BY_SELECTOR = new Map<string, Refusal>(
  REFUSALS.map((signature) => {
    const name = signature.slice(0, signature.indexOf("("));
    const refusal: Refusal = name.startsWith("ERC20Insufficient")
      ? "NotEnoughDollars"
      : name === "WrongRunner"
        ? "NotRunner"
        : (name as Refusal);
    return [selectorOf(signature).slice(2), refusal];
  }),
);
const NAMES: readonly Refusal[] = [
  "WrongPhase",
  "BadAmount",
  "NothingToRefund",
  "NotAllowed",
  "CannotOpen",
  "TokenMisbehaved",
  "CapReached",
  "WrongStage",
  "NotRunner",
];

/** Every string and hex blob inside a provider's error, however deeply it nests them. */
function textsOf(error: unknown, depth = 0): string[] {
  if (depth > 4 || error === null || error === undefined) return [];
  if (typeof error === "string") return [error];
  if (typeof error !== "object") return [];
  const out: string[] = [];
  const e = error as Record<string, unknown>;
  for (const field of ["message", "data", "error", "cause", "reason"]) {
    out.push(...textsOf(e[field], depth + 1));
  }
  return out;
}

/** The contract's refusal inside an error, or null when the error is not one. */
export function refusalOf(error: unknown): Refusal | null {
  for (const text of textsOf(error)) {
    for (const match of text.matchAll(/0x([0-9a-fA-F]{8})/g)) {
      const found = BY_SELECTOR.get(match[1].toLowerCase());
      if (found) return found;
    }
    for (const name of NAMES) if (text.includes(name)) return name;
    if (text.includes("WrongRunner")) return "NotRunner";
    // The node's own words when the wallet cannot pay for sending ("insufficient funds for gas * price + value"): this
    // is the network's coin, not dollars. The dollar token's refusals are matched by selector above.
    if (/insufficient funds/i.test(text)) return "NoGas";
    if (/transfer amount exceeds balance/i.test(text))
      return "NotEnoughDollars";
  }
  return null;
}

const REFUSAL_WORDS: Record<
  Refusal,
  Partial<Record<MoneyAction, string>> & { any: string }
> = {
  WrongPhase: {
    back: "This round is not taking asks any more, so nothing was taken.",
    refund:
      "Money can be taken back once the round has closed. Try again then.",
    any: "This cannot be done at this point of the round. Nothing changed.",
  },
  BadAmount: {
    back: "That amount does not fit: an ask is at least 1 dollar. Nothing was taken.",
    any: "That amount does not fit. Nothing changed.",
  },
  NothingToRefund: {
    any: "There is nothing left to take back in this round: it was all released or already taken back.",
  },
  NotAllowed: {
    "check-in": "Only the person who runs the project can check in.",
    open: "Only the person who runs the project can open backing.",
    "take-out": "Only the backer can take out their own Shares.",
    any: "This account may not do this. Nothing changed.",
  },
  CannotOpen: {
    any: "A round could not open: one is already open, or what is left under the limit is too small.",
  },
  CapReached: {
    any: "The project has raised the most it can at this stage, so no round can open.",
  },
  WrongStage: {
    any: "Backing cannot open at this stage of the project.",
  },
  TokenMisbehaved: {
    any: "The dollar token moved a different amount than asked, so nothing changed.",
  },
  NotRunner: {
    open: "Only the account that runs this project can open backing. Nothing changed.",
    "check-in": "Only the account that runs this project can check in.",
    any: "Only the account that runs this project can do this. Nothing changed.",
  },
  NotEnoughDollars: {
    any: "Your wallet does not hold enough dollars for this. Nothing was taken.",
  },
  NoGas: {
    any: "Your wallet needs a little of the network's own coin to pay for sending this. Add some and try again; nothing was sent.",
  },
};

/**
 * What a person reads when the server's address for their passkey account is not the one this phone works out from the
 * passkey: no deposit address is shown and nothing is sent from it.
 */
export const ACCOUNT_MISMATCH_WORDS =
  "The server gave an address for your account that does not match the one this phone works out from your passkey. No address is shown and nothing was sent. Do not send money to it. Try again later, or tell whoever runs this server.";

/** What a passkey account says when it is set up for another network than the project's. */
export const PASSKEY_WRONG_NETWORK_WORDS =
  "This phone's account is set up for another network than this project's. Nothing was sent.";

/** What an error says of the passkey account sending: the lines that name a wallet, said for a passkey account. */
const PASSKEY_WORDS = {
  "wrong-network": PASSKEY_WRONG_NETWORK_WORDS,
  pending:
    "It was sent, but it has not landed yet. Press again in a few minutes to look for it: it is not sent a second time while it may still land.",
  replaced:
    "Another step from your account took its place, so this cannot be looked up here. If it went through, the numbers here show it soon. If they do not change, press again to send it.",
  NotEnoughDollars:
    "Your account does not hold enough dollars for this. Nothing was taken.",
  NoGas:
    "The server could not pay the network fee for this. Nothing was sent. Try again later.",
} as const;

const ACTION_WORDS: Record<MoneyAction, string> = {
  back: "Your backing",
  refund: "Taking your money back",
  "take-out": "Taking out your Shares",
  "check-in": "The check-in",
  open: "Opening backing",
  connect: "Connecting to your account",
};

/** What a person reads when a money step stops. */
export function moneyProblem(error: unknown, action: MoneyAction): string {
  if (error instanceof WalletStepError) {
    if (error.reason === "no-wallet")
      return "There is no wallet in this browser. Open this page in a browser with a wallet to go on.";
    if (error.reason === "not-set-up")
      return "Backing from this phone is not switched on for this server yet. Open this page in a browser with a wallet to back now.";
    if (error.reason === "no-passkey")
      return "This browser does not hold the passkey for an account here, so it cannot back from one. Sign in with your passkey on the phone where you made it, or open this page in a browser with a wallet.";
    if (error.reason === "account-mismatch") return ACCOUNT_MISMATCH_WORDS;
    if (error.reason === "not-known")
      return "This app will not send that from your passkey account: it is not one of this project's contracts. Nothing was sent.";
    const passkey = error.sender === "passkey";
    if (passkey && error.reason === "wrong-network")
      return PASSKEY_WORDS["wrong-network"];
    if (passkey && error.reason === "pending") return PASSKEY_WORDS.pending;
    if (passkey && error.reason === "replaced") return PASSKEY_WORDS.replaced;
    if (error.reason === "wrong-network")
      return "Your wallet is on another network. Switch it to the project's network and try again.";
    if (error.reason === "pending")
      return "Your wallet sent it, but it has not landed yet. Press again in a few minutes to look for it: it is not sent a second time while it may still land.";
    if (error.reason === "replaced")
      return "Your wallet sent this again as another call (sped up or cancelled), so it cannot be looked up here. Look in your wallet's activity: if it went through, the numbers here show it soon. If it did not, press again to send it.";
    const refusal = refusalOf(error.cause);
    if (refusal) {
      if (passkey && (refusal === "NotEnoughDollars" || refusal === "NoGas"))
        return PASSKEY_WORDS[refusal];
      const words = REFUSAL_WORDS[refusal];
      return words[action] ?? words.any;
    }
    if (errorNamed(error.cause, "PaymasterDeniedError"))
      return "The free network fee was refused for this account, for example because today's free sends are used up. Nothing was sent. Try again tomorrow, or use a browser with a wallet.";
    if (isPasskeyClosed(error.cause)) return PASSKEY_CLOSED_WORDS;
    if (error.cause && isUserRejection(textsOf(error.cause).join(" ")))
      return rejected(action, error.landed);
    if (isRejectionCode(error.cause)) return rejected(action, error.landed);
    if (action === "back" && error.landed > 0)
      return "The approval went through but the backing did not. Nothing was taken. Try again.";
    return `${ACTION_WORDS[action]} did not go through. Nothing changed. Try again.`;
  }
  if (error instanceof Error && isUserRejection(error.message))
    return rejected(action, 0);
  const refusal = refusalOf(error);
  if (refusal) {
    const words = REFUSAL_WORDS[refusal];
    return words[action] ?? words.any;
  }
  return `${ACTION_WORDS[action]} did not go through. Nothing changed. Try again.`;
}

/** What a person reads when they close the passkey prompt. */
const PASSKEY_CLOSED_WORDS = "You closed the passkey prompt. Nothing was sent.";

/** The sentence for a passkey step whose prompt was closed or timed out, or null when this is not that. */
export function passkeyClosedWords(error: unknown): string | null {
  return error instanceof WalletStepError &&
    error.sender === "passkey" &&
    isPasskeyClosed(error.cause)
    ? PASSKEY_CLOSED_WORDS
    : null;
}

/** The passkey prompt was closed or timed out (the browser's `NotAllowedError` or `AbortError`). */
function isPasskeyClosed(error: unknown): boolean {
  return (
    errorNamed(error, "NotAllowedError") || errorNamed(error, "AbortError")
  );
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

function isRejectionCode(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === 4001 || code === "ACTION_REJECTED";
}

function rejected(action: MoneyAction, landed: number): string {
  if (action === "back" && landed > 0)
    return "You said no in your wallet after the approval. Nothing was taken.";
  return "You said no in your wallet. Nothing was sent.";
}

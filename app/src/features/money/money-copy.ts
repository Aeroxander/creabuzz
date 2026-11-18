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
  | "NotEnoughDollars";

const BY_SELECTOR = new Map<string, Refusal>(
  REFUSALS.map((signature) => {
    const name = signature.slice(0, signature.indexOf("("));
    const refusal: Refusal = name.startsWith("ERC20Insufficient")
      ? "NotEnoughDollars"
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
    if (/exceeds balance|insufficient (?:balance|funds)/i.test(text))
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
    any: "This wallet may not do this. Nothing changed.",
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
  NotEnoughDollars: {
    any: "Your wallet does not hold enough dollars for this. Nothing was taken.",
  },
};

const ACTION_WORDS: Record<MoneyAction, string> = {
  back: "Your backing",
  refund: "Taking your money back",
  "take-out": "Taking out your Shares",
  "check-in": "The check-in",
  open: "Opening backing",
  connect: "Connecting your wallet",
};

/** What a person reads when a money step stops. */
export function moneyProblem(error: unknown, action: MoneyAction): string {
  if (error instanceof WalletStepError) {
    if (error.reason === "no-wallet")
      return "There is no wallet in this browser. Open this page in a browser with a wallet to go on.";
    if (error.reason === "wrong-network")
      return "Your wallet is on another network. Switch it to the project's network and try again.";
    if (error.reason === "pending")
      return "Your wallet sent it, but it has not landed yet. Look again in a few minutes before trying again.";
    const refusal = refusalOf(error.cause);
    if (refusal) {
      const words = REFUSAL_WORDS[refusal];
      return words[action] ?? words.any;
    }
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

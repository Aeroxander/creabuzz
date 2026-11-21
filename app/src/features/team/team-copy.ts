/**
 * Every refusal Team and the market can meet (the Pair, the Launcher, the Treasury, the Finisher, the auction and its bid
 * rules), as a sentence that says what happened and what to do next. Same pattern as `money-copy.ts`: the screens show
 * only what this returns, so no contract name, code or hex reaches a person. `team-copy.test.ts` walks every error in
 * those contracts' ABIs.
 */
import { selectorOf } from "@creaton/core/launchpad/evmAbi.ts";
import { isUserRejection } from "@creaton/core/launchpad/wallet-errors.ts";
import {
  moneyProblem,
  passkeyClosedWords,
  refusalOf,
} from "../money/money-copy";
import { WalletStepError } from "../money/wallet";

export type TeamAction =
  | "offer-seat"
  | "accept-seat"
  | "confirm"
  | "withdraw"
  | "give"
  | "hand-over"
  | "take-seat"
  | "wind-down"
  | "spend"
  | "launch"
  | "link"
  | "open-round"
  | "open-auction"
  | "bid"
  | "finish"
  | "collect"
  | "hand-back"
  | "trade"
  | "consent"
  | "veto"
  | "deliver";

/** Refusals by error name, with the sentence for any action and, where it reads better, for one action. */
const WORDS: Record<
  string,
  Partial<Record<TeamAction, string>> & { any: string }
> = {
  // Pair
  NotAllowed: {
    confirm:
      "Only the other signer can confirm this: the one who proposed it cannot confirm it too.",
    withdraw: "Only the signer who proposed this can withdraw it.",
    "take-seat": "This account was not offered the seat. Nothing changed.",
    give: "Only the project's runner can give Shares. Nothing changed.",
    "hand-over":
      "Only the founder can mark that they are leaving. Nothing changed.",
    any: "This account may not do this. Nothing changed.",
  },
  BadTarget: {
    any: "A Pair can only call its own project's money and launch. Nothing changed.",
  },
  UnknownCall: {
    any: "This call is not waiting any more: it was confirmed or withdrawn. The list here catches up in a moment.",
  },
  CapExceeded: {
    spend:
      "That is more than one signer may spend alone in 7 days (500 dollars). Propose it so both of you sign.",
    any: "That is more than the limit allows right now. Nothing changed.",
  },
  // Launcher
  SettingsMoved: {
    launch:
      "The platform's settings changed while you were deciding. Nothing was created; press again to launch under the new settings.",
    any: "The platform's settings changed. Nothing changed; try again.",
  },
  ProjectExists: {
    launch:
      "This project is already on the network from this wallet. Press Finish linking to tie your page to it.",
    any: "This project is already on the network.",
  },
  BadName: {
    any: "The project's name must be 1 to 64 letters long. Nothing was created.",
  },
  UnknownProject: {
    any: "The network does not know this project. Nothing changed.",
  },
  NotRunner: {
    any: "Only the account that runs this project can do this. Nothing changed.",
  },
  WrongRunner: {
    "open-auction":
      "Only a project run by two people can open its auction. Add a second person first.",
    "wind-down":
      "After a market opens, only the project's council can wind it down. Nothing changed.",
    any: "The project is not run the way this step needs. Nothing changed.",
  },
  WrongStage: {
    "open-auction":
      "The auction cannot open now: a backing round is open, or a market already exists.",
    "wind-down":
      "The project cannot wind down while a round is open or the auction runs. Try again after it ends.",
    finish: "This finishing step is not due yet. Nothing changed.",
    any: "This cannot be done at this stage of the project. Nothing changed.",
  },
  CapReached: {
    any: "The project has raised the most it can at this stage, so no round can open.",
  },
  TooEarly: {
    finish: "This finishing step is not due yet. Try again later.",
    deliver:
      "Shares are sent 21 days after you agree, and only as they are released. Try again then. Nothing changed.",
    any: "It is too early for this. Nothing changed.",
  },
  BadStart: {
    any: "That starting price is outside what the auction allows. Nothing changed.",
  },
  // Treasury
  NotSettled: {
    "hand-back":
      "Handing back opens once the sale's money has been split. Try again after the finish steps.",
    any: "The sale's money has not been split yet. Nothing changed.",
  },
  SaleNotClosed: {
    "hand-back":
      "Handing back waits until the sale's last finish step is done. Try again then.",
    any: "The sale is not finished yet. Nothing changed.",
  },
  NothingToPay: {
    any: "That many Shares would bring back less than a cent, so nothing was handed back.",
  },
  TooMuch: {
    "hand-back":
      "That is more Shares than are in people's hands. Hand back fewer.",
    spend: "There is not that much money to spend right now. Nothing was sent.",
    any: "That is more than there is. Nothing changed.",
  },
  WorkPotShort: {
    any: "The project does not have that many Shares left to give. Choose a smaller amount.",
  },
  AlreadyWoundDown: {
    any: "This project has already wound down. Nothing changed.",
  },
  BadInput: {
    give: "Shares can only go to a person's own account, and the amount must be more than nothing.",
    "hand-over":
      "The seat can only be offered to another account. Nothing changed.",
    any: "Something in this request does not fit. Nothing changed.",
  },
  // Finisher
  SettleFirst: {
    any: "The sale's money has to be split first. Press the earlier finishing step.",
  },
  SaleDidNotGraduate: {
    any: "The auction did not reach its minimum, so every bid is refunded in full instead.",
  },
  NoPool: { any: "The pool is not open. Nothing changed." },
  // The auction and its bid rules
  BidTooSmall: { any: "A bid is at least 1 dollar. Nothing was taken." },
  TopPriceTooHigh: {
    any: "That price is above the most this auction allows (4 times its starting price). Nothing was taken.",
  },
  BidTooLate: {
    any: "The auction takes no bids in its last stretch. Nothing was taken.",
  },
  AuctionNotStarted: {
    any: "The auction has not started yet. Try again in a few minutes.",
  },
  AuctionIsOver: { any: "The auction has ended. Nothing was taken." },
  AuctionSoldOut: {
    any: "The auction has sold every Share. Nothing was taken.",
  },
  BidMustBeAboveClearingPrice: {
    any: "The price has already passed the most this bid would pay. Nothing was taken.",
  },
  AuctionIsNotOver: {
    any: "The auction has not ended yet. Try again after it ends.",
  },
  NotGraduated: {
    any: "The auction did not reach its minimum, so bids are refunded rather than filled.",
  },
  NotClaimable: {
    any: "These Shares cannot be collected yet. Try again later.",
  },
  BidAlreadyExited: { any: "This bid was already settled. Nothing changed." },
  CannotExitBid: {
    any: "This bid cannot be settled yet. Try again after the auction ends.",
  },
  // The earlier backers' list
  NotFunded: {
    any: "The Shares for this list are not in place yet, so nothing can be agreed. Nothing changed. Try again later.",
  },
  UnknownEntry: {
    any: "This link does not match a line on the list. Ask for a new one. Nothing changed.",
  },
  NotOnList: {
    any: "What this link carries does not match the list. Ask for a new link. Nothing changed.",
  },
  BadHolder: {
    any: "This line has no account to agree with yet. Nothing changed.",
  },
  Barred: {
    any: "This account can no longer agree to this line, because a replacement is waiting. Nothing changed.",
  },
  EntryState: {
    consent: "This line was already agreed to. Nothing changed.",
    deliver: "This line has not been agreed to yet. Nothing was sent.",
    any: "This line is not in the state this step needs. Nothing changed.",
  },
  Expired: {
    any: "Your signed message ran out of time. Sign it again. Nothing changed.",
  },
  BadSignature: {
    consent:
      "Only the account this line was made for can agree to it. Nothing changed.",
    any: "That signature does not match the account this line was made for. Nothing changed.",
  },
  TextMoved: {
    any: "The agreement was updated while you were reading. Read it again, then agree. Nothing changed.",
  },
  BadReceiver: {
    any: "Shares can go to your own account or to an account that already exists on this network, not to a project's own contracts. Choose another. Nothing changed.",
  },
  OverTotal: {
    any: "Agreeing to this would pass the total the list is owed. Nothing changed. Ask the team to look.",
  },
  WindowOver: {
    any: "The days for checking this agreement are over. Nothing changed.",
  },
  NoReplacement: {
    veto: "There is no replacement waiting for this line, or you already used your one veto. Nothing changed.",
    any: "There is no replacement waiting for this line. Nothing changed.",
  },
  ClosedState: {
    any: "The list is closed, so nothing more can be agreed. Nothing changed.",
  },
  NotKeeper: {
    any: "Only the list's keeper can do this. Nothing changed.",
  },
  BindState: {
    any: "The list is not ready yet. Nothing changed. Try again later.",
  },
};

/** Names in WORDS that end in "(...)": matched by selector from the ABIs' own signatures. */
const SIGNATURES = [
  "NotAllowed()",
  "BadTarget()",
  "UnknownCall()",
  "CapExceeded(uint256,uint256,uint256)",
  "SettingsMoved()",
  "ProjectExists()",
  "BadName()",
  "UnknownProject()",
  "NotRunner()",
  "WrongRunner(uint8)",
  "WrongStage()",
  "CapReached(uint256)",
  "TooEarly(uint256)",
  "BadStart()",
  "NotSettled()",
  "SaleNotClosed()",
  "NothingToPay()",
  "TooMuch(uint256,uint256)",
  "WorkPotShort(uint256,uint256)",
  "AlreadyWoundDown()",
  "BadInput()",
  "SettleFirst()",
  "SaleDidNotGraduate()",
  "NoPool()",
  "BidTooSmall(uint128,uint128)",
  "TopPriceTooHigh(uint256,uint256)",
  "BidTooLate(uint256,uint256)",
  "AuctionNotStarted()",
  "AuctionIsOver()",
  "AuctionSoldOut()",
  "BidMustBeAboveClearingPrice()",
  "AuctionIsNotOver()",
  "NotGraduated()",
  "NotClaimable()",
  "BidAlreadyExited()",
  "CannotExitBid()",
  "NotFunded()",
  "UnknownEntry()",
  "NotOnList()",
  "BadHolder()",
  "Barred()",
  "EntryState()",
  "Expired()",
  "BadSignature()",
  "TextMoved()",
  "BadReceiver()",
  "OverTotal()",
  "WindowOver()",
  "NoReplacement()",
  "ClosedState()",
  "NotKeeper()",
  "BindState()",
] as const;

const BY_SELECTOR = new Map<string, string>(
  SIGNATURES.map((s) => [selectorOf(s).slice(2), s.slice(0, s.indexOf("("))]),
);
/** The auction wraps a bid rule's refusal: `ValidationHookCallFailed(bytes)` with the rule's own error inside. */
const WRAPPED = selectorOf("ValidationHookCallFailed(bytes)").slice(2);

function textsOf(error: unknown, depth = 0): string[] {
  if (depth > 4 || error === null || error === undefined) return [];
  if (typeof error === "string") return [error];
  if (typeof error !== "object") return [];
  const e = error as Record<string, unknown>;
  return ["message", "data", "error", "cause", "reason"].flatMap((f) =>
    textsOf(e[f], depth + 1),
  );
}

/** The refusal's name inside an error (looking inside a wrapped bid-rule refusal), or null. */
export function teamRefusalOf(error: unknown): string | null {
  for (const text of textsOf(error)) {
    for (const match of text.matchAll(/0x([0-9a-fA-F]{8})([0-9a-fA-F]*)/g)) {
      const selector = match[1].toLowerCase();
      if (selector === WRAPPED) {
        // selector, offset word, length word, then the inner error's own selector
        const inner = match[2].slice(128, 136).toLowerCase();
        const found = BY_SELECTOR.get(inner);
        if (found) return found;
      }
      const found = BY_SELECTOR.get(selector);
      if (found) return found;
    }
    for (const name of Object.keys(WORDS)) if (text.includes(name)) return name;
  }
  return null;
}

const ACTION_WORDS: Record<TeamAction, string> = {
  "offer-seat": "Offering the seat",
  "accept-seat": "Accepting the seat",
  confirm: "Confirming",
  withdraw: "Withdrawing the call",
  give: "Giving Shares",
  "hand-over": "Handing over",
  "take-seat": "Taking the seat",
  "wind-down": "Winding down",
  spend: "Paying",
  launch: "Putting the project on the network",
  link: "The link to your account",
  "open-round": "Opening backing",
  "open-auction": "Opening the auction",
  bid: "Your bid",
  finish: "This finishing step",
  collect: "Collecting your bid",
  "hand-back": "Handing back",
  trade: "The trade",
  consent: "Agreeing",
  veto: "Keeping this line",
  deliver: "Sending the Shares",
};

/** What a person reads when a Team or market step stops. */
export function teamProblem(error: unknown, action: TeamAction): string {
  const cause = error instanceof WalletStepError ? error.cause : error;
  const refusal = teamRefusalOf(cause);
  if (refusal) {
    const words = WORDS[refusal];
    return words[action] ?? words.any;
  }
  const closed = passkeyClosedWords(error);
  if (closed) return closed;
  if (error instanceof WalletStepError) {
    // The wallet's own stops (no wallet, wrong network, still waiting, said no) read the same as for money.
    if (refusalOf(error.cause) === "NoGas") return moneyProblem(error, "back");
    if (error.reason !== "reverted" && error.reason !== "failed")
      return moneyProblem(error, "connect");
    if (error.cause && isUserRejection(textsOf(error.cause).join(" ")))
      return "You said no in your wallet. Nothing was sent.";
    const code = (error.cause as { code?: unknown } | undefined)?.code;
    if (code === 4001 || code === "ACTION_REJECTED")
      return "You said no in your wallet. Nothing was sent.";
  } else if (error instanceof Error && isUserRejection(error.message)) {
    return "You said no in your wallet. Nothing was sent.";
  }
  return `${ACTION_WORDS[action]} did not go through. Nothing changed. Try again.`;
}

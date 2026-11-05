/**
 * The account this browser acts as on chain (D139): a passkey account, a smart account whose fees the site's paymaster
 * covers on its network so a tester needs no wallet and no ETH, or the browser's own wallet. One account for
 * every contributor step, so the address that starts a project, submits work, reviews it and votes is always the same:
 * the contracts key on `msg.sender`, and a claim filed from one account cannot be taken from another.
 *
 * The choice is remembered in this browser (a convenience, never state that matters to anyone else): a passkey account
 * by default when the site offers one, else the wallet. Pure apart from storage, so `acting-account.test.mjs` pins it.
 */

import type {
  SendCallsResult,
  SenderCall,
} from "../../identity/lib/sponsoredSender.ts";
import { SponsoredSenderUnavailableError } from "../../identity/lib/sponsoredSender.ts";
import {
  PaymasterDeniedError,
  zerodevConfigFromEnv,
} from "../../identity/lib/zerodev.ts";
import { isMainnetChain, networkLabel } from "../chain-config.ts";

export type ActingKind = "wallet" | "passkey";

export const ACTING_KIND_STORAGE_KEY = "buzz.launchpad.actingAccount";

/** Which account acts: what was chosen here, while it can still act; else a passkey account; else the wallet. */
export function chooseActingKind(input: {
  saved: ActingKind | null;
  passkey: boolean;
  wallet: boolean;
}): ActingKind | null {
  if (input.saved === "passkey" && input.passkey) return "passkey";
  if (input.saved === "wallet" && input.wallet) return "wallet";
  if (input.passkey) return "passkey";
  if (input.wallet) return "wallet";
  return null;
}

/**
 * Where the site covers a passkey account's fees, as words for a sentence: "the test network" on a test chain, the
 * network's own name on a real-money one (a build pointed at one must not say "the test network"), and null when no
 * chain is set, so nothing is promised. The same rule as the raise screens' picker (`sender-picker-copy.ts`).
 */
export function feesCoveredOn(chainId: number | null): string | null {
  if (chainId === null || !Number.isInteger(chainId) || chainId <= 0) {
    return null;
  }
  return isMainnetChain(chainId) ? networkLabel(chainId) : "the test network";
}

/** The chain this build's passkey accounts run on, which is where their fees are covered; null when it names none. */
export function passkeyChainId(): number | null {
  const chainId = zerodevConfigFromEnv().chainId;
  return chainId !== undefined && Number.isInteger(chainId) && chainId > 0
    ? chainId
    : null;
}

/** The line that says a passkey account acts here, naming where its fees are covered when that is known. */
export function passkeyActingLine(chainId: number | null): string {
  const fees = feesCoveredOn(chainId);
  return fees
    ? `You act with your account (passkey; fees are covered on ${fees}).`
    : "You act with your account (passkey).";
}

/** What a send needs to know about the acting account to say why it cannot send yet. */
export interface AccountForGate {
  kind: ActingKind | null;
  address: string | null;
  accountsChecked: boolean;
  chainId: number | null;
  passkeyOffered: boolean;
}

/**
 * Why the acting account cannot send on `chainId` yet, in words a person can act on; null when it can. `label` names a
 * network for people; `feesOn` is where a passkey account's fees are covered ({@link feesCoveredOn}).
 */
export function accountGate(
  account: AccountForGate,
  chainId: number | null,
  label: (chainId: number) => string,
  feesOn: string | null = feesCoveredOn(passkeyChainId()),
): string | null {
  if (account.kind === null) {
    if (!account.passkeyOffered) return "Connect a wallet app to take part.";
    const fees = feesOn ? ` (fees are covered on ${feesOn})` : "";
    return `Set up passkey sign-in from your profile menu to act here${fees}, or add a wallet app to this browser.`;
  }
  if (!account.address) {
    if (account.kind === "wallet") return "Connect a wallet app to take part.";
    return account.accountsChecked
      ? "Your passkey account could not be read. Reload the page to try again."
      : "Reading your passkey account…";
  }
  if (chainId === null || account.chainId === null) return null;
  if (account.chainId === chainId) return null;
  return account.kind === "passkey"
    ? `Your passkey account works on ${label(account.chainId)}, but this is on ${label(chainId)}.`
    : `Your wallet is on ${label(account.chainId)}, but this is on ${label(chainId)}. Switch networks in your wallet.`;
}

/** A step that reached the chain and was refused there: nothing it asked for happened. */
export class StepRevertedError extends Error {
  readonly txHash: string;

  constructor(txHash: string) {
    super("The network rejected that step, so nothing changed.");
    this.name = "StepRevertedError";
    this.txHash = txHash;
  }
}

/**
 * A wallet's step of several calls in which some landed and then one did not (refused, rejected in the wallet, or not
 * answered): it is not "nothing changed". Pressing the button again finishes it, because the screen reads what landed.
 */
export class PartialStepError extends Error {
  readonly landed: number;

  constructor(landed: number, cause: unknown) {
    super(
      `Part of this went through, but not all of it${cause instanceof StepRevertedError ? "" : ` (${actingErrorMessage(cause)})`}. Press the button again to finish it.`,
    );
    this.name = "PartialStepError";
    this.landed = landed;
  }
}

/**
 * A failed step said in plain words (`message`), with the original text kept for a "Technical details" disclosure
 * (`technical`, null when there is nothing more to show). Whoever helps the person reads the second; the person the first.
 */
export class ActingStepError extends Error {
  readonly technical: string | null;

  constructor(message: string, technical: string | null) {
    super(message);
    this.name = "ActingStepError";
    this.technical = technical;
  }
}

/** The fee service refused because the step is bigger than it covers: the same step can never pass. */
export const FEE_TOO_LARGE_MESSAGE =
  "The site could not cover the fee for this step, because the step is bigger than the fees it covers, so nothing was sent. Pressing again will not help: tell whoever runs this site.";
/** The fee service has used up what it may spend: nothing passes until someone raises the limit. */
export const FEE_USED_UP_MESSAGE =
  "The site could not cover the fee for this step, because it has used up the fees it may cover for now, so nothing was sent. Pressing again will not help until whoever runs this site raises the limit: tell them.";
/** The fee service is asked too often just now: it passes by waiting, unlike the refusals above. */
export const FEE_BUSY_MESSAGE =
  "The site's fee service is busy just now, so nothing was sent. Wait a minute, then press again.";
/** The fee service refused for a reason it did not name. */
export const FEE_REFUSED_MESSAGE =
  "The site could not cover the fee for this step, so nothing was sent. Pressing again is unlikely to help: tell whoever runs this site.";
/** The chain would refuse the step: most often it was already done, by this person or someone else. */
export const WOULD_FAIL_MESSAGE =
  "The network would refuse this step, so nothing was sent. It may already have been done, by you or someone else: refresh the page to see where it stands before pressing again.";
/** Sent, but no confirmation arrived in time: it may still land. */
export const NOT_CONFIRMED_MESSAGE =
  "It was sent but is not confirmed yet. Wait a minute and refresh the page before pressing again.";
/** Another step from the same account is still on its way. */
export const STILL_GOING_MESSAGE =
  "Another step from your account is still going through. Wait a minute, refresh the page, then press again.";
/** The passkey's signature was not accepted. */
const SIGNATURE_REFUSED_MESSAGE =
  "Your passkey's approval was not accepted, so nothing was sent. Press the button again; if it happens again, tell whoever runs this site.";
/** The service that carries passkey steps did not answer: whether it went through is not known. */
export const NO_ANSWER_MESSAGE =
  "The service that sends passkey steps did not answer. Refresh the page to see whether it went through before pressing again.";
/** The page's own network connection failed. */
export const NETWORK_DOWN_MESSAGE =
  "The network did not answer just now. Wait a minute, refresh the page, then try again.";
/** Anything else from the passkey account's machinery. */
export const COULD_NOT_SEND_MESSAGE =
  "The step could not be sent. Refresh the page and try again; if it keeps failing, tell whoever runs this site.";

/** Text from the passkey account's machinery (its own prefixes and error names), never meant for people. */
const MACHINE_PREFIX =
  /^(zerodev|bundler|kernel033|aa|userop|sponsored ?sender):/i;
const MACHINE_NAMES = new Set([
  "BundlerRpcError",
  "BundlerTimeoutError",
  "BundlerNotConfiguredError",
  "SenderCallsError",
  "Kernel033ConfigError",
  "Kernel033ChainRpcError",
  "Kernel033HashMismatchError",
  "EthCallRevertError",
]);

/** What the fee service's refusal means, from its own text (which differs by dashboard version, so loosely). */
function feeRefusal(serverMessage: string): string {
  // Asked too often: it passes by waiting, so it is never read as a limit used up.
  if (/rate ?limit|too many requests|\b429\b/i.test(serverMessage))
    return FEE_BUSY_MESSAGE;
  // A size limit first: "gas limit exceeded" is about this step, not about what the site has spent.
  if (
    /gas ?limit|max(imum)? ?gas|gas.{0,40}exceed|exceed.{0,40}gas|too (large|big|high)|size|calldata/i.test(
      serverMessage,
    )
  )
    return FEE_TOO_LARGE_MESSAGE;
  if (
    /quota|spend|budget|(cap|limit) (reached|hit|exhausted|exceeded)|used up|insufficient|balance|daily|monthly/i.test(
      serverMessage,
    )
  )
    return FEE_USED_UP_MESSAGE;
  return FEE_REFUSED_MESSAGE;
}

/** Plain words for the passkey machinery's own text; null when the text is not from it. */
function machineMessage(error: Error): string | null {
  const text = error.message;
  if (!MACHINE_PREFIX.test(text) && !MACHINE_NAMES.has(error.name)) return null;
  if (/no receipt for/i.test(text)) return NOT_CONFIRMED_MESSAGE;
  // A paymaster that refuses while checking the step (AA3x) is the fee service, whatever the bundler calls it.
  if (/\bAA31\b/.test(text)) return FEE_USED_UP_MESSAGE;
  if (/\bAA3\d\b/.test(text)) return feeRefusal(text);
  if (/\bAA25\b|invalid (account )?nonce/i.test(text))
    return STILL_GOING_MESSAGE;
  if (/\bAA24\b|signature (error|invalid)|invalid signature/i.test(text))
    return SIGNATURE_REFUSED_MESSAGE;
  // AA1x is the account itself not being made (its creation code), not the step: "already done" would mislead.
  if (/\bAA1\d\b/.test(text)) return COULD_NOT_SEND_MESSAGE;
  if (
    /revert|simulation|\bAA2\d\b|execution reverted|UserOperation reverted/i.test(
      text,
    )
  )
    return WOULD_FAIL_MESSAGE;
  if (error.name === "Kernel033ChainRpcError" || /chain RPC/i.test(text))
    return NETWORK_DOWN_MESSAGE;
  if (
    error.name === "BundlerTimeoutError" ||
    /timed out|HTTP (429|5\d\d)|rate ?limit|too many requests|network error|failed to fetch/i.test(
      text,
    )
  )
    return NO_ANSWER_MESSAGE;
  return COULD_NOT_SEND_MESSAGE;
}

/**
 * What a failed send says to the person who pressed the button: what happened and what to do next, never a vendor's
 * dashboard, a bundler's error or a browser's raw message (the copy rules). A fee refusal that pressing again cannot fix
 * says so. Errors from this app's own code keep their own words, which are already written for people; the original
 * text of anything reworded is `actingErrorDetails`.
 */
export function actingErrorMessage(error: unknown): string {
  if (
    error instanceof StepRevertedError ||
    error instanceof PartialStepError ||
    error instanceof ActingStepError
  ) {
    return error.message;
  }
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "NotAllowedError" || name === "AbortError") {
    return "You closed the passkey prompt, or it timed out, so nothing was sent. Press the button again and confirm with your passkey.";
  }
  if (error instanceof PaymasterDeniedError) {
    return feeRefusal(error.serverMessage);
  }
  if (error instanceof SponsoredSenderUnavailableError) {
    return `${error.message} ${error.availability.action ?? ""}`.trim();
  }
  if (!(error instanceof Error)) return COULD_NOT_SEND_MESSAGE;
  return machineMessage(error) ?? error.message;
}

/** The original text behind `actingErrorMessage`, for "Technical details"; null when the plain words are all there is. */
export function actingErrorDetails(error: unknown): string | null {
  if (error instanceof ActingStepError) return error.technical;
  if (error instanceof StepRevertedError) return error.txHash || null;
  if (!(error instanceof Error)) return error == null ? null : String(error);
  return error.message === actingErrorMessage(error) ? null : error.message;
}

/**
 * The error a failed send throws onward: a refusal on chain as it is (callers read its transaction), anything else as
 * an `ActingStepError` that carries the plain words and keeps the original for "Technical details".
 */
export function actingStepError(error: unknown): Error {
  if (
    error instanceof StepRevertedError ||
    error instanceof PartialStepError ||
    error instanceof ActingStepError
  )
    return error;
  return new ActingStepError(
    actingErrorMessage(error),
    actingErrorDetails(error),
  );
}

/**
 * Send `calls` as the acting account. A passkey account sends them as one operation (all or nothing) and counts it only
 * when it succeeded inside; a wallet sends them one by one, so when one fails after another landed the error says so.
 * Resolves with the last transaction.
 */
export async function sendAsAccount(input: {
  kind: ActingKind;
  calls: SenderCall[];
  sponsored?: { sendCalls(calls: SenderCall[]): Promise<SendCallsResult> };
  walletSend?: (
    call: SenderCall,
  ) => Promise<{ txHash: string; status: "success" | "reverted" }>;
}): Promise<string> {
  if (input.kind === "passkey") {
    if (!input.sponsored) throw new Error("There is no passkey account here.");
    return requireSponsoredSuccess(
      await input.sponsored.sendCalls(input.calls),
    );
  }
  if (!input.walletSend) throw new Error("There is no wallet here.");
  let last = "";
  for (const [index, call] of input.calls.entries()) {
    try {
      const receipt = await input.walletSend(call);
      if (receipt.status !== "success") {
        throw new StepRevertedError(receipt.txHash);
      }
      last = receipt.txHash;
    } catch (error) {
      if (index === 0) throw error;
      throw new PartialStepError(index, error);
    }
  }
  return last;
}

/**
 * Send `calls` as the account a screen acts as, resolving with the last transaction once every call landed and
 * succeeded: a passkey account through its sponsored sender, a wallet one call at a time through its effects, each
 * waited for. The one place a failed send is put into plain words with its original kept (`actingStepError`), for the
 * acting account (`use-acting-account.ts`) and a screen's own picker (`picked-send.ts`) alike.
 */
export async function sendLanded(input: {
  kind: ActingKind;
  calls: SenderCall[];
  sponsored?: { sendCalls(calls: SenderCall[]): Promise<SendCallsResult> };
  /** The wallet's send, which resolves once the transaction is mined (`makeWalletAuctionEffects`). */
  wallet?: {
    send(call: {
      to: string;
      data: string;
      value: string;
    }): Promise<{ txHash: string; status: string }>;
  };
}): Promise<string> {
  const { wallet } = input;
  try {
    return await sendAsAccount({
      kind: input.kind,
      calls: input.calls,
      sponsored: input.sponsored,
      walletSend: wallet
        ? async (call) => {
            const receipt = await wallet.send({
              to: call.to,
              data: call.data,
              value: call.value ?? "0x0",
            });
            return {
              txHash: receipt.txHash,
              status: receipt.status === "success" ? "success" : "reverted",
            };
          }
        : undefined,
    });
  } catch (error) {
    // A refusal on chain and a partial step stay themselves (callers read them); anything else in plain words, with the
    // original kept for "Technical details".
    throw actingStepError(error);
  }
}

/**
 * A sponsored send is included on chain even when a call inside it fails (the bundle's transaction succeeds and the
 * operation is marked failed), so its result says "confirmed" either way. This reads what actually happened: every
 * operation must have succeeded, or the step is refused like any reverted transaction.
 */
export function requireSponsoredSuccess(result: SendCallsResult): string {
  if (result.userOps.length === 0 || result.userOps.some((op) => !op.success)) {
    throw new StepRevertedError(result.txHash);
  }
  return result.txHash;
}

export function loadActingKind(
  storage: Pick<Storage, "getItem"> | null = safeStorage(),
): ActingKind | null {
  try {
    const value = storage?.getItem(ACTING_KIND_STORAGE_KEY);
    return value === "wallet" || value === "passkey" ? value : null;
  } catch {
    return null;
  }
}

export function saveActingKind(
  kind: ActingKind,
  storage: Pick<Storage, "setItem"> | null = safeStorage(),
): void {
  try {
    storage?.setItem(ACTING_KIND_STORAGE_KEY, kind);
  } catch {
    // Private windows can refuse storage: the choice then lasts for this page only.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

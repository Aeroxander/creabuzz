/**
 * The account this browser acts as on chain (D139): a passkey account, a smart account whose fees the site's paymaster
 * covers on the test network so a tester needs no wallet and no test ETH, or the browser's own wallet. One account for
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
import { PaymasterDeniedError } from "../../identity/lib/zerodev.ts";

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
 * network for people.
 */
export function accountGate(
  account: AccountForGate,
  chainId: number | null,
  label: (chainId: number) => string,
): string | null {
  if (account.kind === null) {
    return account.passkeyOffered
      ? "Set up passkey sign-in from your profile menu to act here (fees are covered on the test network), or add a wallet to this browser."
      : "Connect your wallet to act on this.";
  }
  if (!account.address) {
    if (account.kind === "wallet") return "Connect your wallet to act on this.";
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
 * What a failed send says to the person who pressed the button: what happened and what to do next, never a vendor's
 * dashboard or a browser's raw message (the copy rules). Errors not recognised keep their own words.
 */
export function actingErrorMessage(error: unknown): string {
  if (error instanceof StepRevertedError || error instanceof PartialStepError) {
    return error.message;
  }
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "NotAllowedError" || name === "AbortError") {
    return "You closed the passkey prompt, or it timed out, so nothing was sent. Press the button again and confirm with your passkey.";
  }
  if (error instanceof PaymasterDeniedError) {
    return "The site could not cover the fee for this step right now, so nothing was sent. Try again in a few minutes, or tell the project's organiser.";
  }
  if (error instanceof SponsoredSenderUnavailableError) {
    return `${error.message} ${error.availability.action ?? ""}`.trim();
  }
  return error instanceof Error ? error.message : "The step could not be sent.";
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

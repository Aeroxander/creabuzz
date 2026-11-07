/**
 * Send one screen's calls from the account its sender picker is on, on the project's network, and resolve only once
 * they landed and succeeded (D144). The same promise as the acting account's `sendCalls` (`use-acting-account.ts`),
 * for the screens whose picker is their own (a raise's Treasury tab): a wallet is checked to be on the project's network
 * before anything is sent and its receipt is waited for, a passkey account must work on that network, and a step the
 * chain refused throws `StepRevertedError` instead of reading as done.
 *
 * Without this a wallet's send was "submitted" the moment the wallet returned a hash, on whatever network it was on, and
 * leaving or delegating said it was confirmed for a transaction that did nothing.
 */

import type {
  SendCallsResult,
  SenderCall,
} from "../../identity/lib/sponsoredSender.ts";
import { actingStepError, sendLanded } from "./acting-account.ts";
import type { SenderKind } from "./sender-choice.ts";
import { makeWalletAuctionEffects } from "./wallet-effects.ts";
import type { Eip1193ProviderLike } from "./wallet-sender.ts";

export interface PickedSendInput {
  kind: SenderKind;
  calls: SenderCall[];
  /** The project's network: the only one this may land on. */
  chainId: number;
  /** The passkey account's sender and the network its fees are covered on, when the picker offers one. */
  passkey: {
    sendCalls(calls: SenderCall[]): Promise<SendCallsResult>;
    chainId: number;
  } | null;
  wallet: Eip1193ProviderLike | undefined;
  /** Names a network for people. */
  label: (chainId: number) => string;
  /** Test seams for the wallet's receipt wait. */
  walletTiming?: {
    pollMs?: number;
    timeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  };
}

/** Resolves with the last transaction once every call landed and succeeded; throws in plain words otherwise. */
export async function sendPicked(input: PickedSendInput): Promise<string> {
  const { kind, calls, chainId } = input;
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error(
      "This project does not say which network it is on, so nothing was sent.",
    );
  }
  if (kind === "passkey") {
    if (!input.passkey) throw new Error("There is no passkey account here.");
    if (input.passkey.chainId !== chainId) {
      throw new Error(
        `Your passkey account works on ${input.label(input.passkey.chainId)}, but this is on ${input.label(chainId)}.`,
      );
    }
    return sendLanded({ kind, calls, sponsored: input.passkey });
  }
  const provider = input.wallet;
  if (!provider) {
    throw new Error(
      "No wallet was found in this browser. Add one, or use your passkey account.",
    );
  }
  let accounts: unknown;
  try {
    accounts = await provider.request({ method: "eth_requestAccounts" });
  } catch (error) {
    // A wallet that refused or failed to share an account: in plain words, with its own kept.
    throw actingStepError(error);
  }
  const from = Array.isArray(accounts) ? accounts[0] : null;
  if (typeof from !== "string" || from === "") {
    throw new Error(
      "No account was chosen in the wallet, so nothing was sent.",
    );
  }
  // The same wallet send as the acting account's: one call at a time, each waited for, on this network only.
  return sendLanded({
    kind,
    calls,
    wallet: makeWalletAuctionEffects({
      provider,
      deployer: from,
      chainId,
      ...input.walletTiming,
    }),
  });
}

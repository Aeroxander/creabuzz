/**
 * Each person's linked wallet (kind 37017, the same record web/ writes and reads, `@creaton/core/account/wallet-proof.ts`):
 * read for teammates, so the runner can offer a seat or give Shares to an address only that person proved.
 */
import {
  type ChainChecker,
  resolvePaymentWalletChecked,
} from "@creaton/core/account/wallet-proof.ts";
import { KIND_EVM_BINDING } from "@creaton/core/kinds.ts";
import { useQuery } from "@tanstack/react-query";
import type { NostrEvent } from "nostr-tools/pure";
import { read } from "../../lib/relay";
import { investingOn } from "../../lib/server";
import { useWallet } from "../money/use-money";
import { senderKind } from "../money/wallet";
import type { MoneyWallet } from "../money/wallet";

/** A teammate's wallet as far as the app can tell: verified, or why not. */
export type TeamWallet =
  | {
      state: "linked";
      address: string;
      /** When the link's proof ends (unix seconds): the room asks for a new one from 30 days before. */
      expires: number;
    }
  | { state: "none" | "unchecked" | "expired" };

/**
 * Asks the network whether a phone (passkey) account accepts its link's signature. It can only ask on the network the link
 * names, through the sender this browser has; with no sender, or on another network, it cannot say, and the link stays
 * "not checked" (never shown as linked).
 */
function chainChecker(wallet: MoneyWallet): ChainChecker | undefined {
  if (!wallet.isAvailable()) return undefined;
  return async ({ account, chain, digest, signature }) => {
    if ((await wallet.chainId()) !== chain)
      throw new Error("The wallet is on another network.");
    // Loaded only when a phone account's link has to be asked about: it is the account's own signature check, and heavy.
    const { isValidKernelSignature } = await import(
      "@creaton/core/aa/kernel-signature.ts"
    );
    return isValidKernelSignature(
      (tx) => wallet.readCall(tx.to, tx.data),
      account,
      digest,
      signature,
    );
  };
}

/**
 * The wallet each person linked to their account (kind 37017, the same record web/ writes): an ordinary wallet's signature
 * is checked on this device; a smart account's (a phone account) is checked by asking the account on the network, and until
 * that can be asked it is shown as not checked.
 */
async function readWalletLinks(
  wallet: MoneyWallet,
  sorted: readonly string[],
): Promise<Record<string, TeamWallet>> {
  const events = (await read({
    kinds: [KIND_EVM_BINDING],
    authors: [...sorted],
    limit: 20 * sorted.length,
  })) as NostrEvent[];
  const now = Math.floor(Date.now() / 1000);
  const out: Record<string, TeamWallet> = {};
  for (const pubkey of sorted) {
    const result = await resolvePaymentWalletChecked(
      events,
      pubkey,
      now,
      chainChecker(wallet),
    );
    out[pubkey] =
      result.state === "verified"
        ? {
            state: "linked",
            address: result.wallet.address.toLowerCase(),
            expires: result.wallet.expires,
          }
        : result.state === "unchecked" || result.state === "unreachable"
          ? { state: "unchecked" }
          : result.state === "expired"
            ? { state: "expired" }
            : { state: "none" };
  }
  return out;
}

export function useTeamWallets(pubkeys: readonly string[]) {
  const sorted = [...new Set(pubkeys)].sort();
  const wallet = useWallet();
  const kind = senderKind(wallet);
  return useQuery({
    queryKey: ["team", "wallets", kind, ...sorted],
    enabled: investingOn() && sorted.length > 0,
    staleTime: 60_000,
    queryFn: () => readWalletLinks(wallet, sorted),
  });
}

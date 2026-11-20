/**
 * Each person's linked wallet (kind 37017, the same record web/ writes and reads, `@creaton/core/account/wallet-proof.ts`):
 * read for teammates, so the runner can offer a seat or give Shares to an address only that person proved, and written
 * for the signed-in person by "Link this wallet" on You.
 */
import { isValidKernelSignature } from "@creaton/core/aa/kernel-signature.ts";
import {
  type ChainChecker,
  newWalletAttestation,
  resolvePaymentWalletChecked,
  siweMessageHash,
  walletTypedData,
} from "@creaton/core/account/wallet-proof.ts";
import { KIND_EVM_BINDING } from "@creaton/core/kinds.ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NostrEvent } from "nostr-tools/pure";
import { publishAsUser, read } from "../../lib/relay";
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
export async function readWalletLinks(
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

/** The words of the wallet link a person approves in their wallet (its hash is kept in the record). */
const LINK_STATEMENT = "Link this wallet to my Creaton account.";

/**
 * Link the wallet in this browser to the signed-in account: the wallet signs a one-year proof naming this account (never
 * a transfer), and the account publishes it. Teammates then see the address, so they can offer a seat or give Shares.
 */
export async function linkWalletNow(
  wallet: MoneyWallet,
  pubkey: string | null,
): Promise<string> {
  if (!pubkey) throw new Error("Sign in first.");
  const address = await wallet.getAddress();
  const chain = await wallet.chainId();
  const now = Math.floor(Date.now() / 1000);
  const nonce = crypto.getRandomValues(new Uint32Array(1))[0];
  const attestation = newWalletAttestation(address, pubkey, chain, now, nonce);
  attestation.signature = await wallet.signTypedData(
    address,
    walletTypedData(attestation),
  );
  await publishAsUser(
    {
      kind: KIND_EVM_BINDING,
      created_at: now,
      tags: [
        ["d", address],
        ["address", address],
        ["chain", String(chain)],
      ],
      content: JSON.stringify({
        v: 1,
        address,
        siweMessageHash: siweMessageHash(LINK_STATEMENT),
        attestation,
      }),
    },
    "Your wallet was not linked. Try again.",
  );
  return address;
}

/** The press that links this browser's wallet (or the person's passkey account) to the signed-in account. */
export function useLinkWallet(pubkey: string | null) {
  const wallet = useWallet();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => linkWalletNow(wallet, pubkey),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["team"] });
      void queryClient.invalidateQueries({ queryKey: ["room"] });
    },
  });
}

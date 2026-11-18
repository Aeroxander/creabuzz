/**
 * Each person's linked wallet (kind 37017, the same record web/ writes and reads, `@creaton/core/account/wallet-proof.ts`):
 * read for teammates, so the runner can offer a seat or give Shares to an address only that person proved, and written
 * for the signed-in person by "Link this wallet" on You.
 */
import {
  newWalletAttestation,
  resolvePaymentWallet,
  siweMessageHash,
  walletTypedData,
} from "@creaton/core/account/wallet-proof.ts";
import { KIND_EVM_BINDING } from "@creaton/core/kinds.ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NostrEvent } from "nostr-tools/pure";
import { publishAsUser, read } from "../../lib/relay";
import { investingOn } from "../../lib/server";
import { useWallet } from "../money/use-money";

/** A teammate's wallet as far as the app can tell: verified, or why not. */
export type TeamWallet =
  | { state: "linked"; address: string }
  | { state: "none" | "unchecked" | "expired" };

/**
 * The wallet each person linked to their account (kind 37017, the same record web/ writes): only a proof this device can
 * check (an ordinary wallet's signature) counts. A smart account's proof needs the chain and is shown as not linked here.
 */
export function useTeamWallets(pubkeys: readonly string[]) {
  const sorted = [...new Set(pubkeys)].sort();
  return useQuery({
    queryKey: ["team", "wallets", ...sorted],
    enabled: investingOn() && sorted.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<Record<string, TeamWallet>> => {
      const events = (await read({
        kinds: [KIND_EVM_BINDING],
        authors: sorted,
        limit: 20 * sorted.length,
      })) as NostrEvent[];
      const now = Math.floor(Date.now() / 1000);
      const out: Record<string, TeamWallet> = {};
      for (const pubkey of sorted) {
        const result = resolvePaymentWallet(events, pubkey, now);
        out[pubkey] =
          result.state === "verified"
            ? { state: "linked", address: result.wallet.address.toLowerCase() }
            : result.state === "unchecked"
              ? { state: "unchecked" }
              : result.state === "expired"
                ? { state: "expired" }
                : { state: "none" };
      }
      return out;
    },
  });
}

/** The words of the wallet link a person approves in their wallet (its hash is kept in the record). */
const LINK_STATEMENT = "Link this wallet to my Creaton account.";

/**
 * Link the wallet in this browser to the signed-in account: the wallet signs a one-year proof naming this account (never
 * a transfer), and the account publishes it. Teammates then see the address, so they can offer a seat or give Shares.
 */
export function useLinkWallet(pubkey: string | null) {
  const wallet = useWallet();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      if (!pubkey) throw new Error("Sign in first.");
      const address = await wallet.getAddress();
      const chain = await wallet.chainId();
      const now = Math.floor(Date.now() / 1000);
      const nonce = crypto.getRandomValues(new Uint32Array(1))[0];
      const attestation = newWalletAttestation(
        address,
        pubkey,
        chain,
        now,
        nonce,
      );
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
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["team"] }),
  });
}

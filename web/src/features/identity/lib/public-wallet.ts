import type { Event } from "nostr-tools/pure";

import { signAsUser, existingUserPubkey } from "@/shared/lib/identity";
import { publishEvent } from "@/shared/lib/publish-event";
import { relayWsUrl } from "@/shared/lib/relay-url";
import { KIND_EVM_BINDING } from "@/shared/constants/kinds";

import { resolvePaymentWallet, type PaymentWallet } from "./wallet-proof";

const key = (pubkey: string) =>
  `buzz.wallet-proof.pending:${relayWsUrl()}:${pubkey}`;

/** An accepted wallet signature waiting for the relay; scoped to relay and author. */
export function readPendingWalletProof(pubkey: string): Event | null {
  try {
    const raw = window.localStorage.getItem(key(pubkey));
    if (!raw) return null;
    const event = JSON.parse(raw) as Event;
    const result = resolvePaymentWallet(
      [event],
      pubkey,
      Math.floor(Date.now() / 1000),
    );
    // A smart account's proof is "unchecked" here: only the chain can say it is good, and the server asks it.
    return result.state === "verified" ||
      result.state === "unchecked" ||
      result.state === "revoked"
      ? event
      : null;
  } catch {
    return null;
  }
}

/** Save before sending so a refused or interrupted publish can be retried unchanged. */
export function savePendingWalletProof(event: Event): void {
  window.localStorage.setItem(key(event.pubkey), JSON.stringify(event));
}

/** Publish a previously signed proof, retaining it until the relay acknowledges it. */
export async function publishPendingWalletProof(pubkey: string): Promise<void> {
  if (existingUserPubkey() !== pubkey)
    throw new Error("Sign in to the account that linked this wallet.");
  const event = readPendingWalletProof(pubkey);
  if (!event)
    throw new Error(
      "The saved wallet proof expired or is unavailable. Link your wallet again.",
    );
  const relay = relayWsUrl();
  const storageKey = key(pubkey);
  const result = await publishEvent(relay, event, {
    signAuth: async (template) => {
      if (existingUserPubkey() !== pubkey)
        throw new Error(
          "You switched accounts. Try again from the account you started with.",
        );
      const proof = await signAsUser(template);
      if (proof.pubkey !== pubkey)
        throw new Error(
          "The active signer changed. Try again from the original account.",
        );
      return proof;
    },
  });
  if (!result.accepted)
    throw new Error(
      result.message || "The server did not accept the wallet proof.",
    );
  // An acknowledgement for this attempt must not erase another tab's newer update.
  const saved = window.localStorage.getItem(storageKey);
  if (saved && (JSON.parse(saved) as Event).id === event.id)
    window.localStorage.removeItem(storageKey);
}

/** Withdraw the public payment address without removing community membership. */
export async function removePublicWallet(wallet: PaymentWallet): Promise<void> {
  if (existingUserPubkey() !== wallet.event.pubkey)
    throw new Error("Sign in to the account that linked this wallet.");
  const signed = await signAsUser({
    kind: KIND_EVM_BINDING,
    created_at: Math.max(
      Math.floor(Date.now() / 1000),
      wallet.event.created_at + 1,
    ),
    tags: wallet.event.tags,
    content: JSON.stringify({
      ...JSON.parse(wallet.event.content),
      revoked: true,
    }),
  });
  if (signed.pubkey !== wallet.event.pubkey)
    throw new Error("You switched accounts. Try again.");
  savePendingWalletProof(signed);
  await publishPendingWalletProof(signed.pubkey);
}

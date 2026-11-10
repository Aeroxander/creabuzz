/**
 * Link a passkey account as a payment wallet. The account is the product's Kernel smart account, which no browser
 * wallet holds and which has no key to `ecrecover`: it signs "this Nostr key may act for me" through its passkey, and
 * the signature is one only the account contract can check (ERC-1271). See `kernel-signature.ts`.
 *
 * What is published is the same kind:37017 record an ordinary wallet's link produces, with the account's signature in
 * the attestation. The SIWE leg an ordinary wallet adds does not exist here (there is no wallet to sign in with), so
 * `siweMessageHash` is all zeros, and no server-side wallet membership is created: membership comes through the
 * Nostr account, as it does for anyone.
 */

import { existingUserPubkey, signAsUser } from "@/shared/lib/identity";
import { KIND_EVM_BINDING } from "@/shared/constants/kinds";
import { ethCall } from "@/features/launchpad/chain";

import { isValidKernelSignature, signKernelHash } from "./kernel-signature";
import { createKernel033ChainRpc } from "./kernel033";
import { passkeyIdentity } from "./passkey-identity";
import {
  publishPendingWalletProof,
  savePendingWalletProof,
} from "./public-wallet";
import { type PasskeyAccountKeys, signInPasskeyKeys } from "./passkey-account";
import { createSponsoredSender, kernel033ChainRpcUrl } from "./sponsoredSender";
import { zerodevConfigFromEnv } from "./zerodev";
import {
  newWalletAttestation,
  resolvePaymentWallet,
  walletAttestationDigest,
} from "./wallet-proof";

/** No SIWE message stands behind a passkey account's link. */
const NO_SIWE_MESSAGE = `0x${"00".repeat(32)}`;

/** The passkey account this browser would link, or why there is none. `known` keys stand in for passkey sign-in (D139). */
export function passkeyAccountSetup(
  known: PasskeyAccountKeys | null = null,
):
  | { ok: true; chainId: number; rpcUrl: string }
  | { ok: false; reason: string } {
  if (!known && !passkeyIdentity()) {
    return {
      ok: false,
      reason:
        "This browser has no passkey account. Set up passkey sign-in from your profile menu first.",
    };
  }
  const chainId = zerodevConfigFromEnv().chainId ?? 0;
  if (!Number.isInteger(chainId) || chainId <= 0) {
    return {
      ok: false,
      reason: "Passkey accounts are not set up on this site's network yet.",
    };
  }
  try {
    return { ok: true, chainId, rpcUrl: kernel033ChainRpcUrl(chainId) };
  } catch {
    return {
      ok: false,
      reason:
        "This site has no connection to its network for passkey accounts.",
    };
  }
}

/**
 * Link this browser's passkey account to the signed-in Nostr account, with both signatures, and publish it. One
 * passkey prompt for the account's signature, nothing else to approve. The account must exist on chain: a first-time
 * account is created with one sponsored, empty operation (the same one any first action would make) before it signs.
 */
export async function linkPasskeyAccount(
  options: { newerThan?: number; keys?: PasskeyAccountKeys } = {},
): Promise<{ address: string }> {
  const keys = options.keys ?? signInPasskeyKeys();
  const setup = passkeyAccountSetup(keys);
  if (!setup.ok) throw new Error(setup.reason);
  const pubkey = existingUserPubkey();
  if (!pubkey) throw new Error("Sign in to your account first.");
  if (!keys) {
    throw new Error(
      "No passkey is saved in this browser. Set up passkey sign-in first.",
    );
  }
  const { credentialId } = keys;

  const sender = createSponsoredSender({
    chainId: setup.chainId,
    rpcUrl: setup.rpcUrl,
    credentialId,
    r1OwnerKey: keys.publicKey,
  });
  const status = sender.availability();
  if (!status.available) {
    throw new Error(`${status.reason ?? ""} ${status.action ?? ""}`.trim());
  }
  const account = (await sender.getAddress()).toLowerCase();

  // The account has to exist before it can say a signature is valid.
  const rpc = createKernel033ChainRpc({ url: setup.rpcUrl });
  if ((await rpc.getCode(account)).length <= 2) {
    await sender.sendCalls([{ to: account, data: "0x" }]);
  }

  const now = Math.floor(Date.now() / 1000);
  const attestation = newWalletAttestation(
    account,
    pubkey,
    setup.chainId,
    now,
    crypto.getRandomValues(new Uint32Array(1))[0],
  );
  const digest = `0x${Array.from(walletAttestationDigest(attestation), (b) => b.toString(16).padStart(2, "0")).join("")}`;
  attestation.signature = await signKernelHash({
    credentialId,
    hash: digest,
    account,
    chainId: setup.chainId,
  });

  // Never publish what the account itself would refuse.
  const accepted = await isValidKernelSignature(
    (tx) => ethCall(setup.rpcUrl, tx.to, tx.data),
    account,
    digest,
    attestation.signature,
  );
  if (!accepted) {
    throw new Error(
      "Your passkey account did not accept your approval, so nothing was published. Try again, or sign in with your passkey first.",
    );
  }

  const event = await signAsUser({
    kind: KIND_EVM_BINDING,
    created_at: Math.max(now, (options.newerThan ?? 0) + 1),
    tags: [
      ["d", account],
      ["address", account],
      ["chain", String(setup.chainId)],
    ],
    content: JSON.stringify({
      v: 1,
      address: account,
      siweMessageHash: NO_SIWE_MESSAGE,
      attestation,
      // The account's public details, so another device of this person's can find the account again (D139).
      passkey: keys,
    }),
  });
  if (
    event.pubkey !== pubkey ||
    resolvePaymentWallet([event], pubkey, now).state !== "unchecked"
  ) {
    throw new Error(
      "Your approval did not match your account. Nothing was published.",
    );
  }
  // Kept in this browser until the server confirms it, so a refused or interrupted publish can be retried unchanged.
  savePendingWalletProof(event);
  await publishPendingWalletProof(pubkey);
  return { address: account };
}

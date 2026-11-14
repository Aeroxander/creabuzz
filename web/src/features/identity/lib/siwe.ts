/**
 * Sign-In With Ethereum onboarding (SIWE, EIP-4361) — wallet -> npub binding.
 *
 * Flow: get a single-use challenge -> sign the Nostr proof -> build the SIWE
 * message around the proof's pubkey with `Resources: nostr:<npub>` -> wallet
 * `personal_sign` -> `POST /auth/siwe/register`. The relay verifies both
 * signatures, binds npub<->wallet in `evm_identities` and makes the npub a
 * member.
 *
 * The message/ signature pair is assembled by [`buildSiweLogin`](./siwe-login.ts)
 * so the binding rules stay unit-testable.
 */

import { assertMayAct } from "@/shared/lib/action-guard";
import { signAsUser, existingUserPubkey } from "@/shared/lib/identity";
import { relayHttpBaseUrl, relayWsUrl } from "@/shared/lib/relay-url";
import { queryEvents } from "@/shared/lib/nostr-client";
import { timedFetchStreamed } from "@/shared/lib/timed-fetch";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { KIND_EVM_BINDING } from "@/shared/constants/kinds";
import {
  savePendingWalletProof,
  publishPendingWalletProof,
  removePublicWallet,
} from "./public-wallet";
import {
  newWalletAttestation,
  walletTypedData,
  resolvePaymentWallet,
  siweMessageHash,
} from "./wallet-proof";

import {
  buildSiweLogin,
  parseWalletBinding,
  revokeProofTemplate,
  type SiweLoginChallenge,
  type WalletBinding,
} from "./siwe-login";

/** Where the binding recorded by a successful registration is kept. */
const BINDING_KEY = "buzz.siwe.binding";

/** How long wallet registration may take: room for the server's on-chain signature checks. */
const REGISTRATION_TIMEOUT_MS = 30_000;

/** The wallet bound to this browser's npub, or null when none is recorded. */
export function readWalletBinding(): WalletBinding | null {
  try {
    const binding = parseWalletBinding(
      window.localStorage.getItem(BINDING_KEY),
    );
    return binding?.pubkey === existingUserPubkey() ? binding : null;
  } catch {
    return null;
  }
}

function writeWalletBinding(binding: WalletBinding | null): void {
  try {
    if (binding === null) window.localStorage.removeItem(BINDING_KEY);
    else window.localStorage.setItem(BINDING_KEY, JSON.stringify(binding));
  } catch {
    // Storage unavailable: the binding stays relay-side only.
  }
}

/**
 * Soft-revoke the recorded wallet binding.
 *
 * The relay requires a fresh Nostr proof signed by the bound npub whose content
 * is the bound address, so the call fails loudly rather than revoking a
 * different binding. On success the local record is cleared.
 */
export async function revokeWalletBinding(): Promise<void> {
  assertMayAct(); // changed terms not yet agreed to: nothing goes out as the person
  const binding = readWalletBinding();
  if (!binding)
    throw new Error("No wallet binding is recorded in this browser");
  const publicBinding = resolvePaymentWallet(
    await queryEvents(relayWsUrl(), {
      kinds: [KIND_EVM_BINDING],
      authors: [binding.pubkey],
      limit: 50,
    }),
    binding.pubkey,
    Math.floor(Date.now() / 1000),
  );
  // Withdraw discovery while membership still permits publishing. If either
  // operation fails it propagates, and the original private record is retained.
  if (publicBinding.state === "verified" || publicBinding.state === "unchecked")
    await removePublicWallet(publicBinding.wallet);
  const proof = await signAsUser(revokeProofTemplate(binding.address));
  const res = await timedFetchStreamed(
    `${relayHttpBaseUrl()}/auth/siwe/revoke`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nostr_proof: proof }),
    },
  );
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    throw new Error(json.error ?? `revoke failed (${res.status})`);
  }
  writeWalletBinding(null);
}

interface EthereumProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

export function walletAvailable(): boolean {
  return typeof window !== "undefined" && window.ethereum != null;
}

async function getChallenge(): Promise<SiweLoginChallenge> {
  const res = await timedFetchStreamed(`${relayHttpBaseUrl()}/auth/siwe/nonce`);
  if (!res.ok) throw new Error("couldn't start wallet sign-in");
  const json = (await res.json()) as {
    nonce?: string;
    domain?: string;
    chain_id?: number;
  };
  if (!json.nonce) throw new Error("server returned no nonce");
  return { nonce: json.nonce, domain: json.domain, chainId: json.chain_id };
}

async function personalSign(message: string, address: string): Promise<string> {
  if (!window.ethereum) throw new Error("no wallet found");
  const sig = await window.ethereum.request({
    method: "personal_sign",
    params: [message, address],
  });
  if (typeof sig !== "string") throw new Error("wallet returned no signature");
  return sig;
}

async function getAccount(): Promise<string> {
  if (!window.ethereum) throw new Error("no wallet found");
  const accounts = (await window.ethereum.request({
    method: "eth_requestAccounts",
  })) as string[];
  const account = accounts?.[0];
  if (
    typeof account !== "string" ||
    !/^0x[0-9a-f]{40}$/i.test(account) ||
    /^0x0{40}$/i.test(account)
  )
    throw new Error("Wallet returned an invalid account");
  return account.toLowerCase();
}

export async function signInWithWallet(
  options: { publicProof?: boolean; newerThan?: number } = {},
): Promise<{
  address: string;
  pubkey: string;
}> {
  assertMayAct();
  const relay = relayWsUrl();
  const registrationUrl = `${relayHttpBaseUrl()}/auth/siwe/register`;
  const address = await getAccount();
  const challenge = await getChallenge();
  if (options.publicProof) {
    const chain = challenge.chainId ?? 1;
    const connectedChain = await window.ethereum?.request({
      method: "eth_chainId",
    });
    if (
      !Number.isSafeInteger(chain) ||
      chain <= 0 ||
      typeof connectedChain !== "string" ||
      Number.parseInt(connectedChain, 16) !== chain
    ) {
      throw new Error(
        `Switch your wallet to network ${chain}, then connect it again.`,
      );
    }
  }

  const login = await buildSiweLogin(challenge, {
    address,
    origin: window.location.origin,
    hostname: window.location.hostname,
    // Nostr proof: the active signer declares control of this npub and asserts
    // the EVM address being bound. Its pubkey is what the relay checks against
    // the message, which is why the message is built from it.
    signProof: () =>
      signAsUser({
        kind: 27235,
        tags: [
          ["u", "/auth/siwe/register"],
          ["method", "POST"],
        ],
        content: address,
      }),
    personalSign,
  });

  let attestation: ReturnType<typeof newWalletAttestation> | undefined;
  let publicEvent: SignedNostrEvent | undefined;
  if (options.publicProof) {
    const chain = challenge.chainId ?? 1;
    const nonce = crypto.getRandomValues(new Uint32Array(1))[0];
    attestation = newWalletAttestation(
      address,
      login.pubkey,
      chain,
      Math.floor(Date.now() / 1000),
      nonce,
    );
    const signature = await window.ethereum?.request({
      method: "eth_signTypedData_v4",
      params: [address, JSON.stringify(walletTypedData(attestation))],
    });
    if (typeof signature !== "string")
      throw new Error("Wallet returned no proof signature");
    attestation.signature = signature;
    publicEvent = await signAsUser({
      kind: KIND_EVM_BINDING,
      created_at: Math.max(
        Math.floor(Date.now() / 1000),
        (options.newerThan ?? 0) + 1,
      ),
      tags: [
        ["d", address],
        ["address", address],
        ["chain", String(chain)],
      ],
      content: JSON.stringify({
        v: 1,
        address,
        siweMessageHash: siweMessageHash(login.message),
        attestation,
      }),
    });
    if (
      publicEvent.pubkey !== login.pubkey ||
      resolvePaymentWallet(
        [publicEvent],
        login.pubkey,
        Math.floor(Date.now() / 1000),
      ).state !== "verified"
    ) {
      throw new Error(
        "Your wallet's approval did not match your account. Use a standard wallet app, not a contract-based one, then try again.",
      );
    }
    if (existingUserPubkey() !== login.pubkey || relayWsUrl() !== relay)
      throw new Error(
        "Your account or community changed while you were approving. Try again.",
      );
    // The public proof is valid independently of SIWE membership. Retain it
    // even if registration or publication fails, so the owner can retry it.
    savePendingWalletProof(publicEvent);
  }

  const res = await timedFetchStreamed(registrationUrl, {
    // Longer than the default: for a smart account the server checks the signature on chain, up to two calls of
    // 8 s each (crates/buzz-evm-auth/src/rpc.rs), before it answers.
    timeoutMs: REGISTRATION_TIMEOUT_MS,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: login.message,
      signature: login.signature,
      nostr_proof: login.proof,
      ...(attestation ? { attestation } : {}),
    }),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    throw new Error(json.error ?? `register failed (${res.status})`);
  }
  // Remember the binding so the profile menu can show it and offer to unbind.
  writeWalletBinding({
    address: login.address,
    pubkey: login.pubkey,
    boundAt: Date.now(),
  });
  if (publicEvent) {
    if (relayWsUrl() !== relay)
      throw new Error(
        "Your community changed. Return to the original community to retry the saved wallet update.",
      );
    await publishPendingWalletProof(login.pubkey);
  }
  return { address: login.address, pubkey: login.pubkey };
}

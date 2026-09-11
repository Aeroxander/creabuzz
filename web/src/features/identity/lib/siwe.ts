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

import { signAsUser } from "@/shared/lib/identity";
import { relayHttpBaseUrl } from "@/shared/lib/relay-url";

import {
  buildSiweLogin,
  buildSiweMessage,
  type SiweLoginChallenge,
} from "./siwe-login";

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
  const res = await fetch(`${relayHttpBaseUrl()}/auth/siwe/nonce`);
  if (!res.ok) throw new Error("couldn't start wallet sign-in");
  const json = (await res.json()) as {
    nonce?: string;
    domain?: string;
    chain_id?: number;
  };
  if (!json.nonce) throw new Error("relay returned no nonce");
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
  if (!account) throw new Error("no account");
  return account.toLowerCase();
}

export async function signInWithWallet(): Promise<{
  address: string;
  pubkey: string;
}> {
  const address = await getAccount();
  const challenge = await getChallenge();

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

  const res = await fetch(`${relayHttpBaseUrl()}/auth/siwe/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: login.message,
      signature: login.signature,
      nostr_proof: login.proof,
    }),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    throw new Error(json.error ?? `register failed (${res.status})`);
  }
  return { address: login.address, pubkey: login.pubkey };
}

export { buildSiweMessage };

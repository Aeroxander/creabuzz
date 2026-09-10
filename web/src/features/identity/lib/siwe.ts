/**
 * Sign-In With Ethereum onboarding (SIWE, EIP-4361) — wallet -> npub binding.
 *
 * Flow: get single-use nonce -> build the SIWE message with
 * `Resources: nostr:<npub>` -> wallet `personal_sign` -> nostr proof event
 * signed by the device identity (kind 27235, content = EVM address) ->
 * `POST /auth/siwe/register` on the relay, which verifies both signatures,
 * binds npub<->wallet in evm_identities and makes the npub a member.
 */

import { signAsUser } from "@/shared/lib/identity";
import { userPubkey } from "@/shared/lib/identity";
import { relayHttpBaseUrl } from "@/shared/lib/relay-url";

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

async function getNonce(): Promise<string> {
  const res = await fetch(`${relayHttpBaseUrl()}/auth/siwe/nonce`);
  if (!res.ok) throw new Error("couldn't start wallet sign-in");
  const json = (await res.json()) as { nonce?: string };
  if (!json.nonce) throw new Error("relay returned no nonce");
  return json.nonce;
}

export function buildSiweMessage(input: {
  domain: string;
  address: string;
  uri: string;
  chainId: number;
  nonce: string;
  npub: string;
}): string {
  return [
    `${input.domain} wants you to sign in with your Ethereum account:`,
    input.address,
    "",
    `URI: ${input.uri}`,
    "Version: 1",
    `Chain ID: ${input.chainId}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${new Date().toISOString()}`,
    "Resources:",
    `- nostr:${input.npub}`,
  ].join("\n");
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
  const nonce = await getNonce();
  const npub = userPubkey(); // ensure identity exists first
  const message = buildSiweMessage({
    domain: window.location.host,
    address,
    uri: window.location.origin,
    chainId: 1,
    nonce,
    npub,
  });
  const signature = await personalSign(message, address);

  // Nostr proof: the device identity signs that it controls this npub and
  // asserts the EVM address being bound.
  const proof = await signAsUser({
    kind: 27235,
    tags: [
      ["u", "/auth/siwe/register"],
      ["method", "POST"],
    ],
    content: address,
  });

  const res = await fetch(`${relayHttpBaseUrl()}/auth/siwe/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, signature, nostr_proof: proof }),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    throw new Error(json.error ?? `register failed (${res.status})`);
  }
  return { address, pubkey: npub };
}

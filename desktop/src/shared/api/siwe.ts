import { relayHttpFromWs } from "@/shared/api/inviteHelpers";
import { invokeTauri, signRelayEvent } from "@/shared/api/tauri";
import type { RelayEvent } from "@/shared/api/types";

// SIWE (EIP-4361) onboarding data layer (creabuzz).
//
// Unlike the NIP-98-authed invite endpoints, `/auth/siwe/*` are plain HTTP:
// the Nostr proof event (kind 27235) is embedded in the JSON body, not sent as
// an `Authorization` header. The flow is:
//
//   GET  /auth/siwe/nonce     → { nonce, expires_in_secs }
//   POST /auth/siwe/register  → { message, signature, nostr_proof }
//
// where `signature` is the EVM owner's EIP-191 `personal_sign` over the SIWE
// message and `nostr_proof` is a signed kind-27235 event (content = the EVM
// address, `["u", "/auth/siwe/register"]` tag).

const SIWE_REQUEST_TIMEOUT_MS = 20_000;
const SIWE_PROOF_KIND = 27235;
const SIWE_REGISTER_URI = "/auth/siwe/register";

export type SiweAccountInfo = {
  /** ZeroDev Kernel account address (0x-prefixed) — the EVM identity. */
  account: string;
  /** Owner EOA address (0x-prefixed); equals `account` under EIP-7702. */
  owner_address: string;
  /** Whether an EVM owner key already exists in the keyring. */
  has_owner: boolean;
};

export type SiweSignature = {
  /** 65-byte hex `personal_sign` signature over the SIWE message. */
  signature: string;
  /** Signer EOA address (0x-prefixed). */
  owner_address: string;
};

export type SiweRegisterResult = {
  status: "joined" | "already_member";
  community_id: string;
  host: string;
  npub: string;
  evm_address: string;
  role: string;
};

/** Get (and create on first use) the ZeroDev account + EVM owner key. */
export async function getSiweAccount(): Promise<SiweAccountInfo> {
  return invokeTauri<SiweAccountInfo>("siwe_get_account");
}

/** Whether an EVM owner key is already stored. */
export async function getSiweHasAccount(): Promise<{ has_owner: boolean }> {
  return invokeTauri<{ has_owner: boolean }>("siwe_has_account");
}

/** Sign a canonical SIWE message with the stored EVM owner key. */
export async function signSiweMessage(message: string): Promise<SiweSignature> {
  return invokeTauri<SiweSignature>("sign_siwe_message", { message });
}

async function fetchNonce(httpBase: string): Promise<string> {
  const response = await fetch(
    `${httpBase.replace(/\/+$/, "")}/auth/siwe/nonce`,
    {
      signal: AbortSignal.timeout(SIWE_REQUEST_TIMEOUT_MS),
    },
  );
  const json = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    const message =
      typeof json.error === "string" ? json.error : `HTTP ${response.status}`;
    throw new Error(message);
  }
  const nonce = json.nonce;
  if (typeof nonce !== "string") throw new Error("Relay returned no nonce");
  return nonce;
}

/**
 * Build the canonical EIP-4361 SIWE message the relay verifies.
 *
 * `domain` must match the relay's tenant host; `chainId` must match
 * `BUZZ_EVM_CHAIN_ID` on the relay; `npubHex` becomes the
 * `Resources: - nostr:<npub>` binding that links the EVM root to the joining
 * Nostr key.
 */
export function buildSiweMessage(input: {
  domain: string;
  address: string;
  chainId: number;
  nonce: string;
  npubHex: string;
  statement?: string;
  uri: string;
}): string {
  const issuedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const lines = [
    `${input.domain} wants you to sign in with your Ethereum account:`,
    input.address,
    "",
    input.statement ?? "",
    "",
    `URI: ${input.uri}`,
    "Version: 1",
    `Chain ID: ${input.chainId}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${issuedAt}`,
    "Resources:",
    `- nostr:${input.npubHex}`,
  ];
  return lines.join("\n");
}

/**
 * Register the current identity against a relay via SIWE.
 *
 * Returns the relay's `{ status: "joined" | "already_member", ... }` response.
 */
export async function registerSiwe(
  relayWsUrl: string,
  chainId: number,
): Promise<SiweRegisterResult> {
  const httpBase = relayHttpFromWs(relayWsUrl);
  const domain = new URL(httpBase).hostname;

  const account = await getSiweAccount();
  const nonce = await fetchNonce(httpBase);

  const identity = await invokeTauri<{ pubkey: string }>("get_identity");
  const message = buildSiweMessage({
    domain,
    address: account.account,
    chainId,
    nonce,
    npubHex: identity.pubkey,
    uri: httpBase,
  });

  const { signature } = await signSiweMessage(message);

  // Nostr proof: kind 27235, content = EVM address, tagged for this endpoint.
  const proof = await signRelayEvent({
    kind: SIWE_PROOF_KIND,
    content: account.account,
    tags: [["u", SIWE_REGISTER_URI]],
  });

  const response = await fetch(
    `${httpBase.replace(/\/+$/, "")}/auth/siwe/register`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        signature,
        nostr_proof: proof as RelayEvent,
      }),
      signal: AbortSignal.timeout(SIWE_REQUEST_TIMEOUT_MS),
    },
  );
  const json = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    const message =
      typeof json.error === "string" ? json.error : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return json as unknown as SiweRegisterResult;
}

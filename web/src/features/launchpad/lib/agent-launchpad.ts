/**
 * Agent-authored launchpad participation (C4).
 *
 * Agents are first-class participants, not impersonators: an agent-run event
 * stays authored by the agent key (`event.pubkey` = agent) and carries, when
 * the owner opts in, a NIP-OA `auth` tag — the owner's BIP-340 signature over
 * `nostr:agent-auth:<agentPubkey>:<conditions>` — proving the agent acts for
 * that owner. `agent` tag makes the agent authorship self-describing and
 * filterable; the NIP-OA tag makes it verifiable.
 */

import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import { getAgentPubkey, signAsAgent } from "@/shared/lib/agent-identity";
import { getOrCreateIdentity, userPubkey } from "@/shared/lib/identity";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";

const AUTH_PREFIX = "nostr:agent-auth:";

/**
 * Sign the NIP-OA preimage `nostr:agent-auth:<agent-pubkey>:<conditions>`
 * with the owner's identity and return the `auth` tag.
 */
export function buildAuthTag(
  ownerSecretHex: string,
  agentPubkey: string,
  conditions: string,
): string[] {
  const preimage = `${AUTH_PREFIX}${agentPubkey}:${conditions}`;
  const digest = sha256(new TextEncoder().encode(preimage));
  const sig = schnorr.sign(digest, hexToBytes(ownerSecretHex));
  return ["auth", userPubkey() ?? "", conditions, bytesToHex(sig)];
}

/**
 * Publish a launchpad event as the browser agent: agent-key signed, with an
 * `agent` tag (self-describing authorship) and — when the owner identity
 * exists and opts in — a NIP-OA `auth` tag binding the agent to the owner.
 *
 * Returns null when the agent key cannot sign (non-browser env).
 */
export async function signLaunchpadEventAsAgent(
  template: { kind: number; content: string; tags: string[][] },
  options: { attest?: boolean; conditions?: string } = {},
): Promise<SignedNostrEvent | null> {
  const agent = getAgentPubkey();
  const tags = [...template.tags];
  // Self-describing: clients can badge without decoding NIP-OA signatures.
  if (!tags.some((t) => t[0] === "agent")) tags.push(["agent", agent]);
  if (options.attest !== false) {
    try {
      const ownerSecretHex = getOrCreateIdentity();
      if (/^[0-9a-fA-F]{64}$/.test(ownerSecretHex)) {
        const conditions = options.conditions ?? "";
        const auth = buildAuthTag(ownerSecretHex, agent, conditions);
        tags.push(auth);
      }
    } catch {
      // Owner identity unavailable — the event stays agent-authored without
      // attestation rather than failing the whole publish.
    }
  }
  try {
    return await signAsAgent({
      kind: template.kind,
      content: template.content,
      tags,
    });
  } catch {
    return null;
  }
}

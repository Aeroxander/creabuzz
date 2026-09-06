/**
 * Durable identity for browser-hosted agents.
 *
 * An agent is a pubkey like any other fleet member; what distinguishes it is
 * the capabilities event it advertises. The browser agent gets its own
 * persisted key (separate from the human's `buzz.identity.nsec`) so its
 * turns, tasks, and presence are attributable to the agent, not the tab's
 * owner.
 */

import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";

import type {
  UnsignedNostrEvent,
  SignedNostrEvent,
} from "@/shared/lib/nostr-signer";

const AGENT_STORAGE_KEY = "buzz.agent.nsec";

function getOrCreateAgentIdentity(): Uint8Array {
  if (typeof localStorage === "undefined") {
    return generateSecretKey();
  }
  let hex = localStorage.getItem(AGENT_STORAGE_KEY);
  if (!hex) {
    const key = generateSecretKey();
    hex = Array.from(key)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    localStorage.setItem(AGENT_STORAGE_KEY, hex);
  }
  return new Uint8Array(
    hex.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)),
  );
}

/** Stable agent pubkey for this browser (created on first use). */
export function getAgentPubkey(): string {
  return getPublicKey(getOrCreateAgentIdentity());
}

/** Sign a template with the persisted browser-agent key. */
export async function signAsAgent(
  template: Omit<UnsignedNostrEvent, "created_at"> & { created_at?: number },
): Promise<SignedNostrEvent> {
  const unsigned: UnsignedNostrEvent = {
    ...template,
    created_at: template.created_at ?? Math.floor(Date.now() / 1000),
  };
  return finalizeEvent(unsigned, getOrCreateAgentIdentity());
}

/** Rotate the browser-agent key (used by the UI's reset control). */
export function resetAgentIdentity(): void {
  localStorage.removeItem(AGENT_STORAGE_KEY);
}

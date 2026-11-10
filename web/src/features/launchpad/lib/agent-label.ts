/**
 * Whether a record was signed by an agent, and who runs it, read from the record itself.
 *
 * A helper is an account, not a person. An agent's records say so in two tags the app already writes when its browser
 * agent acts (`agent-launchpad.ts`):
 *
 *   agent   the agent's own public key: "this account is an agent"
 *   auth    the owner's public key, the conditions, and the owner's signature over
 *           `nostr:agent-auth:<agent key>:<conditions>`: "and this person runs it"
 *
 * The owner is named only when that signature checks out for this record's author, so nobody can claim to be run by
 * someone who did not agree. An agent that names no owner, or whose proof does not check out, is still shown as an
 * agent: it said so itself, and saying so gains it nothing.
 *
 * Pure and alias-free: `agent-label.test.mjs` drives it under `node --test`.
 */

import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes } from "@noble/hashes/utils.js";

const AUTH_PREFIX = "nostr:agent-auth:";
const KEY_RE = /^[0-9a-f]{64}$/;
const SIG_RE = /^[0-9a-f]{128}$/;

/** An agent account as a label needs it: who runs it, when the record proves that. */
export interface AgentMark {
  /** The owner's public key, or null when the record names none it can prove. */
  owner: string | null;
}

interface RecordLike {
  pubkey: string;
  tags: readonly (readonly string[])[];
}

/** The conditions allow this kind: no `kind=` clause at all, or one that names it. */
function allowsKind(conditions: string, kind: number | undefined): boolean {
  const kinds = conditions
    .split("&")
    .map((clause) => /^kind=(\d+)$/.exec(clause.trim())?.[1])
    .filter((value): value is string => value !== undefined);
  if (kinds.length === 0 || kind === undefined) return true;
  return kinds.includes(String(kind));
}

function provenOwner(record: RecordLike, kind: number | undefined) {
  for (const tag of record.tags) {
    if (tag[0] !== "auth") continue;
    const [, owner, conditions, sig] = tag;
    if (
      typeof owner !== "string" ||
      typeof conditions !== "string" ||
      typeof sig !== "string" ||
      !KEY_RE.test(owner) ||
      !SIG_RE.test(sig) ||
      owner === record.pubkey ||
      !allowsKind(conditions, kind)
    )
      continue;
    try {
      const digest = sha256(
        new TextEncoder().encode(
          `${AUTH_PREFIX}${record.pubkey}:${conditions}`,
        ),
      );
      if (schnorr.verify(hexToBytes(sig), digest, hexToBytes(owner)))
        return owner;
    } catch {
      // A proof that cannot be checked proves nothing.
    }
  }
  return null;
}

/**
 * The agent a record was signed by, or null when it was not signed by one. `kind` is the record's kind, checked against
 * the owner's conditions when they name kinds.
 */
export function agentMark(record: RecordLike, kind?: number): AgentMark | null {
  const owner = provenOwner(record, kind);
  if (owner) return { owner };
  const says = record.tags.some(
    (tag) => tag[0] === "agent" && tag[1] === record.pubkey,
  );
  return says ? { owner: null } : null;
}

/** "Agent, run by Sam", or "Agent" when nobody is proven to run it. */
export function agentLabel(ownerName: string | null): string {
  return ownerName ? `Agent, run by ${ownerName}` : "Agent";
}

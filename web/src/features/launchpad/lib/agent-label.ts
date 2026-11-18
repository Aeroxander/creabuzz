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
 * The owner is named only when that signature checks out for this record's author and the record meets the owner's
 * conditions (its kind, and the dates the owner's word covers), so nobody can claim to be run by someone who did not
 * agree, and an owner's word that has run out names nobody. Reading the claim is cheap and done for every record;
 * checking the signature is done only for what is shown, once per record. An agent that names no owner, or whose proof does not check out, is still shown as an
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
  created_at: number;
  tags: readonly (readonly string[])[];
}

/**
 * What a record says about being an agent's, read from its tags without checking anything: cheap, so it can be taken
 * from every record read. The owner's proof is checked later, only for what is shown ({@link verifiedAgent}).
 */
export interface AgentClaim {
  /** The record calls itself an agent (its `agent` tag names its own key). */
  says: boolean;
  /** The owner's proof as written: owner, conditions, signature. Null when the record carries none. */
  auth: { owner: string; conditions: string; sig: string } | null;
  pubkey: string;
  createdAt: number;
}

/** The record's own claim to be an agent's, or null when it makes none. Only its first proof is kept. */
export function agentClaim(record: RecordLike): AgentClaim | null {
  const auth = record.tags.find((tag) => tag[0] === "auth");
  const says = record.tags.some(
    (tag) => tag[0] === "agent" && tag[1] === record.pubkey,
  );
  if (!auth && !says) return null;
  const [, owner, conditions, sig] = auth ?? [];
  return {
    says,
    auth:
      typeof owner === "string" &&
      typeof conditions === "string" &&
      typeof sig === "string"
        ? { owner, conditions, sig }
        : null,
    pubkey: record.pubkey,
    createdAt: record.created_at,
  };
}

const DECIMAL = /^(0|[1-9]\d*)$/;

/**
 * Whether a record of this kind and date meets every clause of the owner's conditions: `kind=<n>`, `created_at<t`,
 * `created_at>t`, joined by `&`. An owner who gave their word until a date did not give it after: a record dated past
 * `created_at<t` is not theirs to answer for. Anything not understood fails: an unknown clause is never waved through.
 */
export function conditionsHold(
  conditions: string,
  record: { kind: number | undefined; createdAt: number },
): boolean {
  if (conditions === "") return true;
  for (const clause of conditions.split("&")) {
    const match = /^(kind=|created_at<|created_at>)(.*)$/.exec(clause);
    if (!match || !DECIMAL.test(match[2])) return false;
    const value = Number(match[2]);
    if (match[1] === "kind=") {
      if (value > 65_535) return false;
      if (record.kind !== undefined && record.kind !== value) return false;
    } else {
      if (value > 4_294_967_295) return false;
      if (match[1] === "created_at<" && !(record.createdAt < value))
        return false;
      if (match[1] === "created_at>" && !(record.createdAt > value))
        return false;
    }
  }
  return true;
}

/**
 * The agent a claim is, with its owner when the proof checks out for this record: the owner's signature over the
 * agent's key and the conditions, and conditions this record meets. At most one signature is checked per claim.
 */
export function verifiedAgent(claim: AgentClaim, kind?: number): AgentMark {
  const auth = claim.auth;
  if (
    !auth ||
    !KEY_RE.test(auth.owner) ||
    !SIG_RE.test(auth.sig) ||
    auth.owner === claim.pubkey ||
    !conditionsHold(auth.conditions, { kind, createdAt: claim.createdAt })
  )
    return { owner: null };
  try {
    const digest = sha256(
      new TextEncoder().encode(
        `${AUTH_PREFIX}${claim.pubkey}:${auth.conditions}`,
      ),
    );
    if (schnorr.verify(hexToBytes(auth.sig), digest, hexToBytes(auth.owner)))
      return { owner: auth.owner };
  } catch {
    // A proof that cannot be checked proves nothing.
  }
  return { owner: null };
}

/**
 * The agent a record was signed by, or null when it was not signed by one. `kind` is the record's kind, checked against
 * the owner's conditions when they name kinds. A record whose only claim is a proof that does not hold, and which does
 * not call itself an agent, is not marked.
 */
export function agentMark(record: RecordLike, kind?: number): AgentMark | null {
  const claim = agentClaim(record);
  if (!claim) return null;
  const mark = verifiedAgent(claim, kind);
  return mark.owner || claim.says ? mark : null;
}

/** "Agent, run by Sam", or "Agent" when nobody is proven to run it. */
export function agentLabel(ownerName: string | null): string {
  return ownerName ? `Agent, run by ${ownerName}` : "Agent";
}

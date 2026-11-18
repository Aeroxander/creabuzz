/**
 * Which accounts are agents the way the server counts them, read from their profiles.
 *
 * The server holds an account as an agent only when someone is on record as running it (`is_agent_account` in
 * `launch_update_authority.rs`). A profile that merely says "agent" proves nobody runs it, and the server treats it as
 * a person: it may check work, and it makes the founder not alone. So a reader counts an account as an agent only when
 * its profile also carries the signature of the person who runs it. Anything less is a person here too.
 *
 * Pure and alias-free: `run-agents.test.mjs` drives it under `node --test`.
 */

import { agentMark } from "./agent-label.ts";

/** A profile record as far as this needs it. */
interface ProfileLike {
  kind: number;
  pubkey: string;
  created_at: number;
  tags: readonly (readonly string[])[];
}

/** Of `asked`, the accounts whose newest profile in `profiles` proves a person runs them. Sorted. */
export function runAgentsOf(
  profiles: readonly ProfileLike[],
  asked: readonly string[],
): string[] {
  const newest = new Map<string, ProfileLike>();
  for (const profile of profiles) {
    if (profile.kind !== 0 || !asked.includes(profile.pubkey)) continue;
    const was = newest.get(profile.pubkey);
    if (!was || profile.created_at > was.created_at)
      newest.set(profile.pubkey, profile);
  }
  return [...newest.values()]
    .filter((profile) => agentMark(profile, 0)?.owner)
    .map((profile) => profile.pubkey)
    .sort();
}

/** How many records of one account are checked for a person's signed word before it is taken to have none. */
const PROOFS_TRIED = 3;

/**
 * Accounts that signed one of `records` as an agent a person vouches for. For a reader that cannot read profiles (the
 * public door serves project records only): the records an agent signs carry the same signed word its profile does.
 * Sorted.
 */
export function runAgentsSigning(
  records: readonly ProfileLike[],
  asked: Iterable<string>,
): string[] {
  const wanted = new Set(asked);
  const tried = new Map<string, number>();
  const found = new Set<string>();
  for (const record of records) {
    const by = record.pubkey;
    if (!wanted.has(by) || found.has(by)) continue;
    const count = tried.get(by) ?? 0;
    if (count >= PROOFS_TRIED) continue;
    tried.set(by, count + 1);
    if (agentMark(record, record.kind)?.owner) found.add(by);
  }
  return [...found].sort();
}

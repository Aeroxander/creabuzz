/**
 * Who may publish a score root this community treats as its own.
 *
 * Score-root records (the `d = <program>:<epoch>` Merkle-root records the
 * scoring operator publishes) are signed by whoever wrote them, and a relay
 * stores records from anyone. Reading them with no filter would present any
 * member's root as the community's reputation. This module is the client-side
 * policy: a build names, per community (a community is a server; the web
 * client talks to one), which publisher keys and score programs it has
 * accepted. With a policy, only accepted publishers' records are fetched and
 * kept — the Nostr query itself is filtered by author, and every returned
 * record is filtered again, so a server that ignores the author filter cannot
 * reshape the list. Without a policy nothing is accepted: roots are labelled
 * as the publisher's own claim, never as authoritative community reputation.
 *
 * The policy is per community and never defaulted to the server's own key:
 * an operator that publishes with a key other than the relay's is fine as long
 * as the build accepts that key.
 *
 * Alias-free with `.ts` specifiers, so `score-root-policy.test.mjs` runs it
 * under `node --test` like its neighbours.
 */

/** The policy a build configures for one community. */
export interface ScorePublisherPolicy {
  /** The server's host: `host[:port]`, lower-cased — one community per server. */
  community: string;
  /** The publisher keys (lower-case hex) whose score roots this community accepts. */
  publishers: readonly string[];
  /** The score programs this community accepts, e.g. the member-score program. */
  programs: readonly string[];
}

const KEY_RE = /^[0-9a-f]{64}$/;

/** The canonical score program the launchpad's community track reads. */
const DEFAULT_PROGRAM = "trustgraphs.output.nostr-member.v1";

/**
 * The settings this module reads; shaped like `chain-config.ts`'s `ChainEnv`,
 * but structural so tests can call it without importing Vite types.
 */
type PartialEnv = { VITE_SCORE_ROOT_PUBLISHERS?: string };

/**
 * The policy for the community behind `relayUrl`, or null when this build
 * configures none. Strict: malformed config is the same as no config — never a
 * partial policy that accepts a key it cannot vouch for.
 */
export function acceptedPublisherPolicy(input: {
  relayUrl: string;
  env?: PartialEnv;
}): ScorePublisherPolicy | null {
  const raw = input.env?.VITE_SCORE_ROOT_PUBLISHERS?.trim();
  if (!raw || !input.relayUrl) return null;
  let map: unknown;
  try {
    map = JSON.parse(raw);
  } catch {
    return null;
  }
  if (map === null || typeof map !== "object" || Array.isArray(map)) {
    return null;
  }
  let host: string | null = null;
  try {
    host = new URL(input.relayUrl).host.toLowerCase();
  } catch {
    return null;
  }
  const body = (map as Record<string, unknown>)[host];
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const entry = body as Record<string, unknown>;
  if (!Array.isArray(entry.publishers) || entry.publishers.length === 0) {
    return null;
  }
  for (const key of entry.publishers) {
    if (typeof key !== "string" || !KEY_RE.test(key)) return null;
  }
  // A policy names the programs it accepts too, unless the build accepts only the default one.
  let programs: string[];
  if (entry.programs === undefined) {
    programs = [DEFAULT_PROGRAM];
  } else {
    if (
      !Array.isArray(entry.programs) ||
      entry.programs.length === 0 ||
      entry.programs.some((p) => typeof p !== "string" || p.trim() === "")
    ) {
      return null;
    }
    programs = (entry.programs as string[]).map((p) => p.trim());
  }
  return {
    community: host,
    // Lower-cased and deduplicated, so two spellings of one key cannot sneak past.
    publishers: [...new Set((entry.publishers as string[]).map((k) => k))],
    programs: [...new Set(programs)],
  };
}

/**
 * Where a score-root record stands with this community. `accepted` only says
 * its publisher is one the community has accepted and its program is one it
 * reads: the root itself is still whatever that publisher signed.
 */
export function standingOf(
  root: { author: string; program: string },
  policy: ScorePublisherPolicy | null,
): RootStanding {
  if (policy === null) return "publisher-claim";
  const accepted =
    policy.publishers.includes(root.author.toLowerCase()) &&
    policy.programs.includes(root.program);
  return accepted ? "accepted" : "publisher-claim";
}

export type RootStanding = "accepted" | "publisher-claim";

const HOST_LOCAL = new Set(["localhost", "[::1]", "::1"]);
const isLocalHost = (host: string) =>
  HOST_LOCAL.has(host) || host.endsWith(".localhost") || host === "127.0.0.1";

/**
 * The proofs pointer a record may serve, or null when it may not. Only
 * `https` is allowed (and plain `http` on this machine, for development), so
 * no record can hand the app a `javascript:`/`data:` link or point a fetch
 * somewhere arbitrary. Null means "no pointer", not "broken link": the UI
 * says the record carries no proofs pointer only the root ships from.
 */
export function safeProofUrl(value: string | null): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol === "https:") return url.toString();
  if (url.protocol === "http:" && isLocalHost(url.hostname)) {
    return url.toString();
  }
  return null;
}

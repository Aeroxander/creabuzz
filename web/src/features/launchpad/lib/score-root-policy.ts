/**
 * Who may publish a score root this community treats as its own — and what
 * the client does before it trusts any of it.
 *
 * Score-root records (the `d = <program>:<epoch>` Merkle-root records the
 * scoring operator publishes) are signed by whoever wrote them, and the
 * query surface stores records from anyone **without checking signatures**:
 * whatever bytes a server answers with are what callers see. So before a
 * record's `pubkey` means anything, the record's own id hash and signature
 * are verified here — a forged event is dropped, never classified. That is
 * also why a server that answers for a wrong author list cannot reshape the
 * list: the author a signature proves is the only author that counts.
 *
 * The policy itself: a build names, per community (a community is a server;
 * the web client talks to one), which publisher keys and score programs it
 * has accepted. With a policy, only accepted publishers' records are fetched
 * and kept — the Nostr query is filtered by the accepted publishers, and
 * every returned record is verified, parsed and filtered again. Without a
 * policy nothing is accepted: roots are labelled as the publisher's own
 * claim, never as authoritative community reputation. The policy is per
 * community and never defaulted to the server's own key: an operator that
 * publishes with a key other than the relay's is fine as long as the build
 * accepts that key.
 *
 * Alias-free with `.ts` specifiers, so `score-root-policy.test.mjs` runs it
 * under `node --test` like its neighbours.
 */

import { verifyEvent } from "nostr-tools";

import { parseScoreRoot, type ScoreRoot } from "../models.ts";

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
 * Whether the bytes really are the event they say: the id hash matches the
 * serialization and the signature matches the id and key. Malformed input
 * (a missing or wrong-typed field) is simply not verified — never a crash,
 * and never a pass.
 */
export function verifySignedEvent(event: unknown): boolean {
  if (event === null || typeof event !== "object") return false;
  const e = event as Record<string, unknown>;
  if (
    typeof e.id !== "string" ||
    typeof e.pubkey !== "string" ||
    typeof e.sig !== "string"
  ) {
    return false;
  }
  try {
    return verifyEvent(e as never);
  } catch {
    return false;
  }
}

/**
 * The policy for the community behind `relayUrl`, or null when this build
 * configures none. Strict: malformed config is the same as no config — never a
 * partial policy that accepts a key it cannot vouch for.
 */
export function acceptedPublisherPolicy(input: {
  relayUrl: string;
  env?: { VITE_SCORE_ROOT_PUBLISHERS?: string };
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
 * The stable cache scope for one query: the community's host plus the
 * policy's accepted publishers and programs, order-normalized so two builds
 * that list the same accepts in different orders share one cache. Another
 * community's roots — or roots accepted under a different policy — never
 * stand in for this one's.
 */
export function scoreRootsQueryScope(
  relayUrl: string,
  policy: ScorePublisherPolicy | null,
): string {
  const suffix = policy
    ? [...policy.publishers].sort().join(",") +
      "|" +
      [...policy.programs].sort().join(",")
    : "no-policy";
  try {
    return `${new URL(relayUrl).host.toLowerCase()}:${suffix}`;
  } catch {
    return `:${suffix}`;
  }
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
  host !== "" &&
  (HOST_LOCAL.has(host) ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host));

const isLocalCommunity = (relayUrl: string): boolean => {
  try {
    return isLocalHost(new URL(relayUrl).hostname);
  } catch {
    return false;
  }
};

/**
 * The proofs pointer a record may serve, or null when it may not. Only
 * `https` is allowed, and plain `http` only when this machine is both
 * (a) the client's own community and (b) the pointer's host — a record from
 * a remote community naming this visitor's localhost is never followed.
 * URLs carrying embedded credentials are refused, and the pointer must not
 * pretend to be another scheme (`javascript:`, `data:`, `file:` …).
 *
 * This scheme filter is **not** containment of where a read goes: a `https`
 * pointer still points wherever its publisher wants. It goes nowhere the
 * person did not ask: the pointer is only followed on an explicit read when
 * someone opens the proofs (a click or a chosen epoch), never fetched on the
 * strength of the record alone, and the screens say where a link leads.
 */
export function safeProofUrl(
  value: string | null,
  communityUrl?: string,
): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  // An address with a username/password (or a port on a scheme that does not
  // take one parsed oddly) is not a proofs pointer; it is a credential box.
  if (url.username !== "" || url.password !== "") return null;
  if (url.protocol === "https:") return url.toString();
  if (url.protocol === "http:") {
    return isLocalCommunity(communityUrl ?? "") && isLocalHost(url.hostname)
      ? url.toString()
      : null;
  }
  return null;
}

/** The filter the score-root read sends; every field is named in the shared filter type. */
export interface ScoreRootsFilter {
  /** One kind only — the relay's p-gate needs explicit kinds. */
  kinds: number[];
  authors?: string[];
  limit?: number;
  /** Tag filters, as the shared filter type shapes them. None are sent today. */
  [tag: `#${string}`]: string[] | undefined;
}

/**
 * The read side's whole filter chain, bound to the production calls
 * `fetchScoreRoots` makes (and to the same chain in tests — the query is
 * injected, the rest is this module's real code):
 *
 * 1. the query names the accepted publishers, when there are any;
 * 2. every answer is **signature-verified before its `pubkey` is read** — a
 *    forged record is dropped here, before classification;
 * 3. the strict parser keeps a record only when its `d` coordinate names the
 *    program and epoch its own content says (`program:epoch`);
 * 4. with a policy, only accepted publishers' records survive; without one,
 *    everything readable survives labelled a publisher claim;
 * 5. the proofs pointer is filtered before anything may follow it;
 * 6. the "latest" root is not the server's first answer: newest signed
 *    record first, ties by lowest event id.
 */
export async function collectScoreRoots(input: {
  /** The community the query belongs to (the relay this client talks to). */
  relayUrl: string;
  policy: ScorePublisherPolicy | null;
  /** The score-root kind, from the shared kind table in the caller. */
  kind: number;
  /** The real query surface in production; a fixture in tests. */
  query: (filter: ScoreRootsFilter) => Promise<readonly unknown[]>;
}): Promise<ScoreRoot[]> {
  const filter: ScoreRootsFilter = { kinds: [input.kind], limit: 50 };
  // The query itself is filtered: the server only has to answer for the
  // publishers the community accepted. Because what comes back is verified,
  // a server that ignores this filter cannot pass a stranger off as one.
  if (input.policy) filter.authors = [...input.policy.publishers];
  const events = await input.query(filter);
  const roots: ScoreRoot[] = [];
  for (const event of events) {
    if (!verifySignedEvent(event)) continue;
    const parsed = parseScoreRoot(event as never);
    if (!parsed) continue;
    const root = parsed;
    root.standing = standingOf(root, input.policy);
    if (input.policy && root.standing !== "accepted") continue;
    root.proofUrl = safeProofUrl(root.indexerUrl, input.relayUrl);
    roots.push(root);
  }
  // Signed records from different publishers for the same program:epoch are
  // distinct rows (each carries its own event id), so a selection or a cached
  // proofs read can never be answered for one with the other's.
  roots.sort(
    (a, b) =>
      b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return roots;
}

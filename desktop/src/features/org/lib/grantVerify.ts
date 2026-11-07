// Client-side port of crates/buzz-core/src/org_grant.rs — NIP-ORG
// grant-chain verification. The Rust module is the source of truth; this file
// mirrors its semantics rule for rule (channel-scope path containment, verb
// entailment, root standing, expiry, depth bound) so a desktop verifier and
// the relay ingest gate agree on every chain.

export const MAX_GRANT_CHAIN_DEPTH = 32;

/** Scope declared by an org node — which verbs this node may delegate. */
export type OrgScope = {
  readBelow: boolean;
  assignBelow: boolean;
  canGrant: string[];
};

/** A resolved org node (mirror of ResolvedOrgNode in org_grant.rs). */
export type ResolvedOrgNode = {
  d: string;
  holders: string[];
  agentSeats: string[];
  scope: OrgScope;
};

/** A resolved grant (mirror of ResolvedGrant in org_grant.rs). */
export type ResolvedGrant = {
  d: string;
  issuer: string;
  grantee: string;
  via: string;
  verbs: string[];
  parentGrant?: string;
  expires?: number;
  revoked: boolean;
};

export type GrantChainError =
  | { type: "revoked"; d: string }
  | { type: "parent-grant-not-found"; d: string }
  | { type: "node-not-found"; d: string }
  | { type: "issuer-not-seated"; issuer: string; via: string }
  | { type: "attenuation-violation"; verb: string }
  | { type: "root-lacks-standing"; d: string; verb: string }
  | { type: "circular-chain"; d: string }
  | { type: "chain-depth-exceeded"; d: string }
  | { type: "expired"; d: string; expires: number };

export type GrantChainResult =
  | { ok: true }
  | { ok: false; error: GrantChainError };

/** Split a verb into name and optional argument: "read:#leadership" → ["read", "#leadership"]. */
export function splitVerb(verb: string): [string, string | undefined] {
  const pos = verb.indexOf(":");
  if (pos === -1) return [verb, undefined];
  return [verb.slice(0, pos), verb.slice(pos + 1)];
}

/** Split a channel argument into ":"-separated segments, stripping "#", dropping empties. */
function channelSegments(channel: string): string[] {
  const stripped = channel.startsWith("#") ? channel.slice(1) : channel;
  return stripped.split(":").filter((s) => s !== "");
}

/**
 * Channel-scope containment: the parent's path segments must be an exact
 * prefix of the child's. "#eng:frontend" is contained by "#eng"; "#l" is NOT
 * contained by "#leadership" (substring prefixes do not count).
 */
export function channelContainedBy(child: string, parent: string): boolean {
  const childSegs = channelSegments(child);
  const parentSegs = channelSegments(parent);
  if (parentSegs.length === 0) return false;
  if (childSegs.length < parentSegs.length) return false;
  for (let i = 0; i < parentSegs.length; i++) {
    if (childSegs[i] !== parentSegs[i]) return false;
  }
  return true;
}

const U64_MAX = 18446744073709551615n;

/** Mirror of Rust's `u64::from_str`: an optional "+", digits only, within range. */
function parseU64(text: string): bigint | null {
  if (!/^\+?\d+$/.test(text)) return null;
  const value = BigInt(text);
  return value <= U64_MAX ? value : null;
}

/**
 * Whether `child` verb is entailed by `parent` verb (NIP-ORG attenuation):
 * same name, and the child's argument no broader than the parent's.
 * - Unargued parent entails any child argument.
 * - Unargued child under a scoped parent is a widening → rejected.
 * - Channel scopes use path containment.
 * - Numeric arguments compare child ≤ parent.
 * - Anything else must match exactly.
 */
export function verbEntailedBy(child: string, parent: string): boolean {
  const [childName, childArg] = splitVerb(child);
  const [parentName, parentArg] = splitVerb(parent);
  if (childName !== parentName) return false;

  if (childArg === undefined && parentArg === undefined) return true;
  // Parent is unbounded → any child argument is a subset.
  if (childArg !== undefined && parentArg === undefined) return true;
  // Child is unbounded, parent is scoped → widening.
  if (childArg === undefined || parentArg === undefined) return false;

  if (childArg.startsWith("#") && parentArg.startsWith("#")) {
    return channelContainedBy(childArg, parentArg);
  }
  // Mirror Rust's u64::from_str: an optional "+" then digits only, so
  // "1e3" or "0x10" fall through to exact-match, not numeric comparison.
  // Values past u64::MAX fail to parse in Rust and so also fall through.
  const childNum = parseU64(childArg);
  const parentNum = parseU64(parentArg);
  if (childNum !== null && parentNum !== null) {
    return childNum <= parentNum;
  }
  // Generic: exact match.
  return childArg === parentArg;
}

/**
 * Verify a grant chain from `grantD` up to its root: no revoked or expired
 * link, every issuer seated in the node it acts through, every child verb
 * entailed by the parent grant, and the root grant's verbs covered by the
 * via node's canGrant (name AND argument). Walk is cycle-detecting and
 * bounded by MAX_GRANT_CHAIN_DEPTH parent hops. `now` is unix seconds.
 */
export function verifyGrantChain(
  grantD: string,
  now: number,
  grants: Map<string, ResolvedGrant>,
  nodes: Map<string, ResolvedOrgNode>,
): GrantChainResult {
  const visited = new Set<string>();
  let currentD = grantD;
  let hops = 0;

  for (;;) {
    if (visited.has(currentD)) {
      return { ok: false, error: { type: "circular-chain", d: currentD } };
    }
    visited.add(currentD);

    const grant = grants.get(currentD);
    if (!grant) {
      return {
        ok: false,
        error: { type: "parent-grant-not-found", d: currentD },
      };
    }
    if (grant.revoked) {
      return { ok: false, error: { type: "revoked", d: currentD } };
    }
    // A grant is valid only strictly before its expiry.
    if (grant.expires !== undefined && now >= grant.expires) {
      return {
        ok: false,
        error: { type: "expired", d: currentD, expires: grant.expires },
      };
    }

    const node = nodes.get(grant.via);
    if (!node) {
      return { ok: false, error: { type: "node-not-found", d: grant.via } };
    }
    if (
      !node.holders.includes(grant.issuer) &&
      !node.agentSeats.includes(grant.issuer)
    ) {
      return {
        ok: false,
        error: {
          type: "issuer-not-seated",
          issuer: grant.issuer,
          via: grant.via,
        },
      };
    }

    if (grant.parentGrant !== undefined) {
      const parent = grants.get(grant.parentGrant);
      if (!parent) {
        return {
          ok: false,
          error: { type: "parent-grant-not-found", d: grant.parentGrant },
        };
      }
      for (const verb of grant.verbs) {
        if (!parent.verbs.some((pv) => verbEntailedBy(verb, pv))) {
          return {
            ok: false,
            error: { type: "attenuation-violation", verb },
          };
        }
      }
      const parentNode = nodes.get(parent.via);
      if (!parentNode) {
        return { ok: false, error: { type: "node-not-found", d: parent.via } };
      }
      if (
        !parentNode.holders.includes(parent.issuer) &&
        !parentNode.agentSeats.includes(parent.issuer)
      ) {
        return {
          ok: false,
          error: {
            type: "issuer-not-seated",
            issuer: parent.issuer,
            via: parent.via,
          },
        };
      }
      hops += 1;
      if (hops > MAX_GRANT_CHAIN_DEPTH) {
        return {
          ok: false,
          error: { type: "chain-depth-exceeded", d: grant.parentGrant },
        };
      }
      currentD = grant.parentGrant;
      continue;
    }

    // Root grant: the issuer's node canGrant must entail every verb — same
    // name AND argument containment, via the same entailment function used
    // for chain attenuation.
    for (const verb of grant.verbs) {
      if (!node.scope.canGrant.some((cg) => verbEntailedBy(verb, cg))) {
        return {
          ok: false,
          error: { type: "root-lacks-standing", d: currentD, verb },
        };
      }
    }
    return { ok: true };
  }
}

/** Violating child verbs of a single parent link (UI attenuation indicator). */
export function attenuatedVerbs(
  child: ResolvedGrant,
  parent: ResolvedGrant,
): string[] {
  return child.verbs.filter(
    (verb) => !parent.verbs.some((pv) => verbEntailedBy(verb, pv)),
  );
}

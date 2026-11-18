// Grant lifecycle grouping for the delegation surface: active (in force)
// vs. revoked/expired history shown in the "Revoked &amp; expired" curtain.
// Pure and framework-free so node --test units can cover the grouping and
// expiry semantics directly (mirror of the relay-side `expires` rule in
// crates/buzz-core/src/org_grant.rs: a grant is in force only strictly
// before its expiry).
import type { OrgGrant } from "../orgModels";

export type CurtainReason = "revoked" | "expired";

export type GrantLifecycle = {
  active: OrgGrant[];
  curtain: Array<{ grant: OrgGrant; reason: CurtainReason }>;
};

export function isGrantExpired(grant: OrgGrant, now: number): boolean {
  return grant.expires !== undefined && now >= grant.expires;
}

/** A grant is in force when it is neither revoked nor expired. */
export function isGrantActive(grant: OrgGrant, now: number): boolean {
  return !grant.revoked && !isGrantExpired(grant, now);
}

/**
 * Split grants into the active chain and the curtain shelf. A revoked grant
 * is always curtain (revocation wins, whatever its expiry); an unrevoked
 * grant past its expiry is curtain as "expired". `now` is unix seconds.
 */
export function groupGrantsByLifecycle(
  grants: OrgGrant[],
  now: number,
): GrantLifecycle {
  const active: OrgGrant[] = [];
  const curtain: GrantLifecycle["curtain"] = [];
  for (const grant of grants) {
    if (grant.revoked) {
      curtain.push({ grant, reason: "revoked" });
    } else if (isGrantExpired(grant, now)) {
      curtain.push({ grant, reason: "expired" });
    } else {
      active.push(grant);
    }
  }
  // Curtain reads newest-first: the most recently revoked/expired grant is
  // the freshest history, so it leads the shelf. Equal timestamps (e.g. a
  // seed burst) tiebreak revoked-before-expired so the shelf order is
  // deterministic regardless of relay return order.
  curtain.sort((a, b) => {
    const byAge = b.grant.createdAt - a.grant.createdAt;
    if (byAge !== 0) return byAge;
    return a.reason === "revoked" ? -1 : 1;
  });
  return { active, curtain };
}

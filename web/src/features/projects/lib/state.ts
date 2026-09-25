/**
 * Project Board state machine: requests → approvals → recorded stakes.
 *
 * Everything here is pure derivation over the four event families (node
 * 37010, grant 37011, pitch 37015, join request 37016). Nothing is stored
 * client-side: the relay's event log is the store, and the rules below are
 * how a UI reads it honestly.
 *
 * Canonical resolution — copied from NIP-ORG's kind:37013 review disposal
 * (`docs/nips/NIP-ORG.md` :373-390): records sharing a `d` resolve to the
 * newest `created_at`, ties broken by the lowest event id, and a record is
 * only *considered* when its author is either the requester (an original
 * request) or the project owner (a decision) — a third party publishing into
 * the same coordinate is dropped, never canonical.
 *
 * Status precedence: approved > declined > role-removed > role-filled >
 * pending. "role-filled" (a pending request for a role someone else already
 * holds) is terminal until the founder revokes the grant or edits the pitch;
 * "superseded" versions of a thread are dropped rather than rendered.
 *
 * The pool bound — the equity model as implemented:
 * - a pitch declares roles whose percentages sum to ≤100 (`POOL_PCT`);
 * - at most one active grant per role (the grant's `d` is `<node>/<role>`,
 *   so a second approval *replaces* under NIP-33 rather than double-grants);
 * - approval additionally requires `granted + requested ≤ 100`, so an edited
 *   pitch can never make recorded stakes exceed the pool.
 *
 * Approval is one durable write (the kind:37011 grant) and decline one
 * durable write (a kind:37016 republication) — role-filled, request status
 * and pool usage derive, so a partial failure cannot tear state
 * (Review-Proven Rule 5, `AGENTS.md`).
 */

import type { JoinRequest } from "./join-request.ts";
import type { OwnershipGrant } from "./grant.ts";
import {
  POOL_PCT,
  type PitchManifest,
  type RoleDeclaration,
} from "./manifest.ts";

/** A request's place in the project's story. */
export type RequestStatus =
  | "approved"
  | "declined"
  | "role-removed"
  | "role-filled"
  | "pending";

export interface RequestState {
  request: JoinRequest;
  status: RequestStatus;
  /** The declared role, or null when the pitch no longer declares it. */
  role: RoleDeclaration | null;
  /** The grant that recorded this request's stake (approved only). */
  grant: OwnershipGrant | null;
}

export interface RoleState {
  role: RoleDeclaration;
  /** The founder's own role — taken by definition, never open to joiners. */
  isFounderRole: boolean;
  /** Active ownership grant filling the role, if any. */
  grant: OwnershipGrant | null;
  /** Joinable: declared, not the founder's, not recorded to anyone. */
  open: boolean;
}

export interface TeamMember {
  pubkey: string;
  role: RoleDeclaration;
  /** The stake row this member holds. */
  pct: number;
  /** `declared` = founder stake asserted by the pitch; `grant` = recorded 37011. */
  source: "declared" | "grant";
  /** Event that records the stake (pitch for declared, grant for recorded). */
  eventId: string;
}

export interface ProjectState {
  manifest: PitchManifest;
  founder: string;
  roles: RoleState[];
  /** Canonical requests, newest first. */
  requests: RequestState[];
  team: TeamMember[];
  /** Σ declared role percentages. */
  declaredPct: number;
  /** Σ recorded (active grant) percentages. */
  grantedPct: number;
  /** `POOL_PCT − grantedPct`, floored at 0. */
  remainingPct: number;
  /** Declared stakes exceed the pool — the pitch itself is out of bounds. */
  overPool: boolean;
  /** Requests still waiting on the founder. */
  pendingCount: number;
}

function isNewer(
  a: { createdAt: number; eventId: string },
  b: { createdAt: number; eventId: string },
): boolean {
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt;
  // NIP-ORG tie rule: lowest event id wins.
  return a.eventId < b.eventId;
}

/**
 * Drop records no authentic party could have published, then resolve each
 * `d` thread to its newest record.
 */
export function canonicalRequests(
  requests: readonly JoinRequest[],
): JoinRequest[] {
  const byKey = new Map<string, JoinRequest>();
  for (const request of requests) {
    const authentic =
      request.author === request.requester || request.author === request.owner;
    if (!authentic) continue;
    const current = byKey.get(request.key);
    if (!current || isNewer(request, current)) byKey.set(request.key, request);
  }
  return [...byKey.values()];
}

/**
 * Active ownership grants for one project, keyed by role slug.
 *
 * A grant counts only when the project's founder issued it (the person who
 * sits in the project's org node — a stranger's parallel record cannot fill
 * a role), it is not revoked, and it is the newest at its NIP-33 coordinate.
 */
export function activeRoleGrants(
  grants: readonly OwnershipGrant[],
  projectId: string,
  founder: string,
): Map<string, OwnershipGrant> {
  // Resolve each NIP-33 coordinate first (newest wins), then drop revoked:
  // a revocation is a *newer record* at the same coordinate, so filtering
  // revoked grants before the rewrite would let the superseded grant survive.
  const byKey = new Map<string, OwnershipGrant>();
  for (const grant of grants) {
    if (grant.author !== founder || grant.via !== projectId) continue;
    const current = byKey.get(grant.key);
    if (!current || isNewer(grant, current)) byKey.set(grant.key, grant);
  }
  const byRole = new Map<string, OwnershipGrant>();
  for (const grant of byKey.values()) {
    if (grant.revoked) continue;
    const current = byRole.get(grant.role);
    if (!current || isNewer(grant, current)) byRole.set(grant.role, grant);
  }
  return byRole;
}

/** Why a request cannot be approved — or that it can. */
export type ApprovalCheck = { ok: true } | { ok: false; reason: string };

/**
 * The approval guard. Every leg exists to keep the recorded map inside the
 * declared pool and the one-grant-per-role rule; removing one lets the UI
 * publish a grant the model says must not exist.
 */
export function canApprove(
  state: ProjectState,
  request: JoinRequest,
): ApprovalCheck {
  if (state.overPool) {
    return {
      ok: false,
      reason: `Declared stakes already add up to more than ${POOL_PCT}% — fix the pitch before approving anything.`,
    };
  }
  const role = state.roles.find((r) => r.role.slug === request.role);
  if (!role) {
    return {
      ok: false,
      reason: "This role is no longer declared in the pitch.",
    };
  }
  if (role.isFounderRole) {
    return { ok: false, reason: "That is the founder's own role." };
  }
  if (role.grant) {
    return {
      ok: false,
      reason:
        role.grant.grantee === request.requester
          ? "This request is already recorded as a stake."
          : `This role is already recorded to ${role.grant.grantee.slice(0, 8)}…`,
    };
  }
  if (!Number.isInteger(request.pct) || request.pct < 1) {
    return {
      ok: false,
      reason: "The requested stake is not a whole percentage.",
    };
  }
  if (request.pct > role.role.pct) {
    return {
      ok: false,
      reason: `This role targets ${role.role.pct}% — a request can ask for at most ${role.role.pct}%.`,
    };
  }
  const after = state.grantedPct + request.pct;
  if (after > POOL_PCT) {
    return {
      ok: false,
      reason: `Recording ${request.pct}% would take recorded stakes to ${after}% of a ${POOL_PCT}% pool.`,
    };
  }
  const canonical = state.requests.find((r) => r.request.key === request.key);
  if (!canonical) {
    return {
      ok: false,
      reason: "This request is no longer on this project's board.",
    };
  }
  if (canonical.request.eventId !== request.eventId) {
    return { ok: false, reason: "A newer record replaced this request." };
  }
  if (canonical.status !== "pending") {
    return {
      ok: false,
      reason:
        canonical.status === "approved"
          ? "This request is already approved."
          : canonical.status === "declined"
            ? "This request was declined."
            : "This request is no longer pending.",
    };
  }
  return { ok: true };
}

/**
 * Derive the full state of one project from its events.
 *
 * @param manifest the newest kind:37015 for `(founder, nodeId)`
 * @param requests every kind:37016 whose `owner` is this founder (already
 *   scoped by the caller — node ids are unique per author, not globally)
 * @param grants every kind:37011 the query returned; only founder-issued,
 *   non-revoked ones for this `via` count
 */
export function deriveProjectState(input: {
  manifest: PitchManifest;
  requests: readonly JoinRequest[];
  grants: readonly OwnershipGrant[];
}): ProjectState {
  const { manifest, grants } = input;
  const founder = manifest.author;
  const roleGrants = activeRoleGrants(grants, manifest.nodeId, founder);

  const roles: RoleState[] = manifest.roles.map((role) => {
    const grant = roleGrants.get(role.slug) ?? null;
    const isFounderRole = manifest.founderRole === role.slug;
    return {
      role,
      isFounderRole,
      grant,
      open: !isFounderRole && !grant,
    };
  });
  const roleBySlug = new Map(roles.map((r) => [r.role.slug, r]));

  const requests: RequestState[] = canonicalRequests(input.requests)
    .filter((r) => r.owner === founder && r.projectId === manifest.nodeId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((request) => {
      const roleState = roleBySlug.get(request.role) ?? null;
      const grant = roleGrants.get(request.role) ?? null;
      let status: RequestStatus;
      if (grant && grant.grantee === request.requester) {
        status = "approved";
      } else if (
        request.author === request.owner &&
        request.decision === "declined"
      ) {
        status = "declined";
      } else if (!roleState) {
        status = "role-removed";
      } else if (grant) {
        status = "role-filled";
      } else {
        status = "pending";
      }
      return {
        request,
        status,
        role: roleState?.role ?? null,
        grant: status === "approved" ? grant : null,
      };
    });

  const team: TeamMember[] = [];
  for (const roleState of roles) {
    if (roleState.grant) {
      team.push({
        pubkey: roleState.grant.grantee,
        role: roleState.role,
        pct: roleState.grant.pct,
        source: "grant",
        eventId: roleState.grant.eventId,
      });
    } else if (roleState.isFounderRole) {
      team.push({
        pubkey: founder,
        role: roleState.role,
        pct: roleState.role.pct,
        source: "declared",
        eventId: manifest.eventId,
      });
    }
  }

  const declaredPct = manifest.roles.reduce((n, r) => n + r.pct, 0);
  const grantedPct = [...roleGrants.values()].reduce((n, g) => n + g.pct, 0);

  return {
    manifest,
    founder,
    roles,
    requests,
    team,
    declaredPct,
    grantedPct,
    remainingPct: Math.max(0, POOL_PCT - grantedPct),
    overPool: declaredPct > POOL_PCT,
    pendingCount: requests.filter((r) => r.status === "pending").length,
  };
}

/** One board card: derived from the same events, cheap enough to recompute. */
export interface ProjectSummary {
  /** `${founder}:${projectId}` — node ids are unique per author. */
  key: string;
  projectId: string;
  founder: string;
  name: string;
  summary: string;
  /** Roles a visitor can ask to join right now. */
  openRoles: RoleDeclaration[];
  /** Roles recorded to someone (or taken by the founder). */
  filledRoles: number;
  /** Founder + recorded members. */
  members: number;
  /** Pending requests waiting on this project's founder. */
  pendingRequests: number;
  /** One of them is mine (only when `me` is given). */
  myRequestPending: boolean;
  /** True once the project's kind:37010 org node is on the relay. */
  hasNode: boolean;
  updatedAt: number;
}

function readNodeId(event: { tags: string[][] }): string | null {
  const tag = event.tags.find((t) => t[0] === "d");
  return tag?.[1] ? tag[1] : null;
}

/**
 * Build the board from the same one-shot query as the detail pages.
 * Duplicate pitches for `(founder, nodeId)` resolve newest-wins (NIP-33),
 * so an edited pitch replaces its card rather than doubling it.
 */
export function deriveBoard(input: {
  pitches: readonly PitchManifest[];
  nodes: readonly { pubkey: string; created_at: number; tags: string[][] }[];
  requests: readonly JoinRequest[];
  grants: readonly OwnershipGrant[];
  me?: string | null;
}): ProjectSummary[] {
  const newestPitch = new Map<string, PitchManifest>();
  for (const pitch of input.pitches) {
    const key = `${pitch.author}:${pitch.nodeId}`;
    const current = newestPitch.get(key);
    if (!current || isNewer(pitch, current)) newestPitch.set(key, pitch);
  }

  const nodeIds = new Set(
    input.nodes.map((node) => `${node.pubkey}:${readNodeId(node) ?? ""}`),
  );

  const summaries: ProjectSummary[] = [];
  for (const [key, pitch] of newestPitch) {
    // Scope to this founder's records: node ids are unique per author, so a
    // same-id project elsewhere on the relay must not count into this card.
    const projectRequests = input.requests.filter(
      (r) => r.projectId === pitch.nodeId && r.owner === pitch.author,
    );
    const projectGrants = input.grants.filter(
      (g) => g.via === pitch.nodeId && g.author === pitch.author,
    );
    const state = deriveProjectState({
      manifest: pitch,
      requests: projectRequests,
      grants: projectGrants,
    });
    const related = [...projectRequests, ...projectGrants];
    const updatedAt = related.reduce(
      (latest, record) => Math.max(latest, record.createdAt),
      pitch.createdAt,
    );
    summaries.push({
      key,
      projectId: pitch.nodeId,
      founder: pitch.author,
      name: pitch.name,
      summary: pitch.summary,
      openRoles: state.roles.filter((r) => r.open).map((r) => r.role),
      filledRoles: state.roles.filter((r) => !r.open).length,
      members: state.team.length,
      pendingRequests: state.pendingCount,
      myRequestPending: input.me
        ? state.requests.some(
            (r) => r.status === "pending" && r.request.requester === input.me,
          )
        : false,
      hasNode: nodeIds.has(key),
      updatedAt,
    });
  }
  return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
}

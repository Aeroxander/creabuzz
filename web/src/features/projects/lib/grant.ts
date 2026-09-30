/**
 * Ownership grant — kind:37011 (`KIND_ORG_GRANT`) with the Project Board's
 * ownership tags.
 *
 * The approval action on the board is exactly one durable write: this grant.
 * Role-filled, request-approved, and pool usage all *derive* from it (see
 * `state.ts`), so an approval can never tear state (Review-Proven Rule 5 —
 * one action, one atomic persist) and revocation is the NIP-ORG rewrite:
 * republish the same `(issuer, d)` with `revoked: true`.
 *
 * Grammar — the golden tags this client publishes:
 * - `["d", "<node>/<role>"]`      NIP-33 key: one recorded stake per role,
 *                                 so a second approval replaces rather than
 *                                 double-grants (LWW is author-keyed).
 * - `["grantee", "<hex>"]`        who the stake lands on (relay-validated).
 * - `["org", "<pct>"]`            the ownership percentage: whole 1..=100,
 *                                 bounded at ingest (`validate_org_envelope`).
 * - `["role", "<slug>"]`          which declared role it fills.
 * - `["p", "<hex>"]`              so the grantee's feed can find it.
 * Content is a verbatim `OrgGrantContent` body (`crates/buzz-sdk/src/builders.rs`):
 * `{v, issuer, grantee, via, verbs, parentGrant, expires, revoked}` — `via`
 * names the org node, `verbs: []` carries no authority (an ownership record
 * is not a capability), and a signer≠`issuer` grant is meaningless.
 *
 * Sources: `docs/nips/NIP-ORG.md` §kind:37011 (:152-187, grant grammar,
 * revocation by republication, "signed, scoped, revocable");
 * `crates/buzz-core/src/org_grant.rs` (chain verification: root grants need
 * `via`, issuer seated on the node, `verbs` ⊆ `canGrant` — empty verbs are
 * vacuously covered); `crates/buzz-relay/src/handlers/ingest.rs`
 * (`validate_org_envelope` bounds `org` and `role`).
 */

import { KIND_ORG_GRANT } from "../../../shared/constants/kinds.ts";
import { PROJECT_ID_RE, ROLE_SLUG_RE } from "./manifest.ts";

const PUBKEY_RE = /^[0-9a-f]{64}$/;

/** A parsed ownership grant (an authority grant without `org`/`role` is not one). */
export interface OwnershipGrant {
  eventId: string;
  author: string;
  /** `d`: `<node>/<role>`. */
  key: string;
  /** Org node the grant acts through (`content.via`). */
  via: string;
  role: string;
  /** Recorded stake, whole percent 1..=100. */
  pct: number;
  grantee: string;
  revoked: boolean;
  createdAt: number;
}

function tagValue(tags: string[][], name: string): string | null {
  const tag = tags.find((t) => t[0] === name);
  return tag && tag.length >= 2 && tag[1] ? tag[1] : null;
}

/**
 * Parse one kind:37011 into an ownership grant. Returns null when the event
 * is not an ownership record for a role (no `role` tag, no `org` percentage,
 * missing `via`) or its content issuer does not match the signature — a
 * grant nobody could verify must not land on a team map.
 */
export function parseOwnershipGrant(event: {
  kind: number;
  id?: string;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
}): OwnershipGrant | null {
  if (event.kind !== KIND_ORG_GRANT) return null;
  const key = tagValue(event.tags, "d");
  const role = tagValue(event.tags, "role");
  const pctTag = tagValue(event.tags, "org");
  if (!key || !role || !ROLE_SLUG_RE.test(role)) return null;
  if (!pctTag || !/^\d{1,3}$/.test(pctTag)) return null;
  const pct = Number(pctTag);
  if (pct < 1 || pct > 100) return null;

  const body = readContent(event.content);
  const via = typeof body.via === "string" ? body.via : null;
  const issuer = typeof body.issuer === "string" ? body.issuer : "";
  if (issuer !== event.pubkey) return null;
  const grantee = typeof body.grantee === "string" ? body.grantee : "";
  if (!PUBKEY_RE.test(grantee)) return null;
  // `d` = `<via>/<role>`: the key, the node, and the role must agree, so one
  // grant cannot claim two projects or fill a role it does not name.
  const segments = key.split("/");
  if (segments[segments.length - 1] !== role) return null;
  if (via !== segments.slice(0, -1).join("/")) return null;

  return {
    eventId: event.id ?? "",
    author: event.pubkey,
    key,
    via,
    role,
    pct,
    grantee,
    revoked: body.revoked === true,
    createdAt: event.created_at,
  };
}

function readContent(content: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // A non-object body yields no issuer, which fails the checks below.
  }
  return {};
}

/** Input for {@link buildOwnershipGrantTemplate}. */
export interface OwnershipGrantInput {
  /** Org-node id the grant acts through. */
  nodeId: string;
  role: string;
  pct: number;
  grantee: string;
  issuer: string;
}

/** A field-level validation failure the dialog can render inline. */
export class GrantValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrantValidationError";
  }
}

/**
 * Build the unsigned kind:37011 template for approving a join request.
 * Throws {@link GrantValidationError} instead of composing an event the relay
 * would reject — the caller signs and publishes it, exactly one write.
 */
export function buildOwnershipGrantTemplate(input: OwnershipGrantInput): {
  kind: number;
  tags: string[][];
  content: string;
} {
  const nodeId = input.nodeId.trim();
  if (!PROJECT_ID_RE.test(nodeId)) {
    throw new GrantValidationError(
      `Project id "${nodeId}" is not a valid org-node id.`,
    );
  }
  const role = input.role.trim();
  if (!ROLE_SLUG_RE.test(role)) {
    throw new GrantValidationError(
      `Role id "${role}" must be 1-12 characters of a-z, 0-9 and dashes.`,
    );
  }
  if (!Number.isInteger(input.pct) || input.pct < 1 || input.pct > 100) {
    throw new GrantValidationError(
      "A recorded stake must be a whole percentage between 1 and 100.",
    );
  }
  if (!PUBKEY_RE.test(input.grantee)) {
    throw new GrantValidationError("The grantee is not a valid pubkey.");
  }
  if (!PUBKEY_RE.test(input.issuer)) {
    throw new GrantValidationError("The issuer is not a valid pubkey.");
  }

  return {
    kind: KIND_ORG_GRANT,
    tags: [
      ["d", `${nodeId}/${role}`],
      ["grantee", input.grantee],
      ["org", String(input.pct)],
      ["role", role],
      ["p", input.grantee],
    ],
    content: JSON.stringify({
      v: 1,
      // Marks this 37011 as an ownership record, not a delegation: the relay
      // exempts it from grant-chain verification and authority views ignore it.
      type: "equity",
      issuer: input.issuer,
      grantee: input.grantee,
      via: nodeId,
      verbs: [],
      parentGrant: null,
      expires: null,
      revoked: false,
    }),
  };
}

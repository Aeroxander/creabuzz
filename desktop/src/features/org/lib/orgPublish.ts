// Pure builders for the org events the desktop publishes. Kept free of Tauri
// and relay imports so the wire shapes can be unit-tested against what the
// relay's ingest gate (crates/buzz-relay/src/handlers/org_grant_enforcement.rs)
// actually accepts.
//
// Why these exist: grants are addressed by (issuer, d) and the relay refuses a
// grant whose signer is not its `content.issuer`, and it parses every grant as a
// full body — a bare `{ "revoked": true }` is not one. A node republish must
// keep the seats and scope it does not touch, or an edit silently strips
// authority (the root's `canGrant` is its standing).

const HEX_PUBKEY = /^[0-9a-f]{64}$/i;

/** The seat's node is not among the signer's own records (never created, or someone else's). */
export class SeatNotFoundError extends Error {}

export type GrantDraft = {
  issuer: string;
  grantee: string;
  via: string;
  verbs: string[];
  parentGrant?: string;
  expires?: number;
};

/** Content for a new kind:37011 grant. The issuer is the signer, never blank. */
export function buildGrantContent(draft: GrantDraft): string {
  if (!HEX_PUBKEY.test(draft.issuer)) {
    throw new Error("A grant needs its issuer's 64-hex public key.");
  }
  return JSON.stringify({
    v: 1,
    issuer: draft.issuer.toLowerCase(),
    grantee: draft.grantee,
    via: draft.via,
    verbs: draft.verbs,
    parentGrant: draft.parentGrant,
    expires: draft.expires,
    revoked: false,
  });
}

function parseObject(content: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`The stored ${what} could not be read.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`The stored ${what} could not be read.`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Revocation is a republish of the same (issuer, d) with `revoked: true` and
 * every other field kept — never a stub. Only the issuer's own record can be
 * revoked, so a different signer is refused here rather than at the relay.
 */
export function buildGrantRevocation(existing: string, signer: string): string {
  const body = parseObject(existing, "grant");
  const issuer = typeof body.issuer === "string" ? body.issuer : "";
  if (issuer.toLowerCase() !== signer.toLowerCase()) {
    throw new Error("Only the issuer of a grant can revoke it.");
  }
  for (const key of ["grantee", "via", "verbs"]) {
    if (body[key] === undefined) {
      throw new Error(
        "The stored grant is incomplete, so it cannot be revoked.",
      );
    }
  }
  return JSON.stringify({ ...body, revoked: true });
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/**
 * Merge an agent into (or out of) a node's `agentSeats`, keeping every other
 * field — holders, parent, scope, UI hints, an onchain binding. Returns `null`
 * when nothing would change, so callers publish only real edits.
 */
export function withAgentSeat(
  existing: string,
  agent: string,
  detach = false,
): string | null {
  if (!HEX_PUBKEY.test(agent)) {
    throw new Error("An agent seat needs the agent's 64-hex public key.");
  }
  const who = agent.toLowerCase();
  const body = parseObject(existing, "org node");
  const seats = stringArray(body.agentSeats);
  const present = seats.some((s) => s.toLowerCase() === who);
  if (present === !detach) return null;
  const next = detach
    ? seats.filter((s) => s.toLowerCase() !== who)
    : [...seats, who];
  return JSON.stringify({ ...body, agentSeats: next });
}

/**
 * The tags of a kind:37010 node, matching the SDK builder: `d`, `name`, and one
 * `seat` per holder and agent seat (the relay's seat cap counts these).
 */
export function orgNodeTags(dtag: string, content: string): string[][] {
  const body = parseObject(content, "org node");
  const tags: string[][] = [["d", dtag]];
  if (typeof body.name === "string" && body.name) {
    tags.push(["name", body.name]);
  }
  for (const holder of stringArray(body.holders)) tags.push(["seat", holder]);
  for (const agent of stringArray(body.agentSeats)) tags.push(["seat", agent]);
  return tags;
}

/**
 * A `created_at` (unix seconds) strictly newer than the record being replaced.
 * NIP-33 keeps only the newest event per coordinate and drops a republish made
 * within the same second as its predecessor as a duplicate.
 */
export function nextCreatedAt(
  existingCreatedAt: number | null,
  now: number,
): number {
  return Math.max(now, existingCreatedAt === null ? 0 : existingCreatedAt + 1);
}

/**
 * Project join request — kind:37016 (`KIND_ORG_JOIN_REQUEST`).
 *
 * A requester signs a request naming a declared role and the equity % they
 * want; the founder's decline republishes the same coordinate under their own
 * key with `decision: "declined"` — the NIP-ORG kind:37013 parallel-record
 * pattern ("NIP-33 LWW is author-keyed, so a review by a signer other than
 * the original author creates a parallel record; that is the intended
 * mechanism", `docs/nips/NIP-ORG.md` :373-379). Approval is deliberately not
 * an event here: it is the kind:37011 ownership grant in `grant.ts`, the
 * single canonical equity record.
 *
 * The coordinate: `d = <node>/<role>/<requester-16>`.
 * - `requester-16` (64 bits of the requester's pubkey) gives every requester
 *   their own thread, so two people asking for the same role never collide
 *   under one `d`, and a founder declining two of them never overwrites one
 *   decline with the other.
 * - Including `<role>` keeps a person's re-request replacing their own older
 *   request for that role (LWW), which is what makes "superseded" free.
 * - `owner` (the founder's pubkey, also mirrored as the `p` tag) scopes the
 *   request to one author's project: node ids are only unique per author, so
 *   a request must name whose board it is asking to join. A record with no
 *   `owner` and no `p` tag is unattributable and is dropped rather than
 *   shown on a stranger's board.
 *
 * Sources: `crates/buzz-core/src/kind.rs` (`KIND_ORG_JOIN_REQUEST = 37016`);
 * `crates/buzz-relay/src/handlers/ingest.rs` `validate_org_envelope` (one
 * `d` ≤64 chars, JSON-object body, `role` tag slug `[a-z0-9-]{1,12}`,
 * `p` unvalidated by design); `docs/nips/NIP-ORG.md` (:381-390) for the
 * parallel-record resolution rule copied here (newest `created_at` wins,
 * ties broken by lowest event id).
 */

import { KIND_ORG_JOIN_REQUEST } from "../../../shared/constants/kinds.ts";
import { PROJECT_ID_RE, ROLE_SLUG_RE } from "./manifest.ts";

const PUBKEY_RE = /^[0-9a-f]{64}$/;
const REQUESTER_DISCRIMINATOR_LEN = 16;

/** A parsed join request (or the founder's decline of one). */
export interface JoinRequest {
  eventId: string;
  /** Who published this record: the requester, or the founder declining. */
  author: string;
  /** `d`: `<node>/<role>/<requester-16>`. */
  key: string;
  /** Project id (`content.project`). */
  projectId: string;
  /** The founder whose project this joins (`content.owner`, else `p` tag). */
  owner: string;
  /** Whose stake this is (`content.requester`, else the original author). */
  requester: string;
  role: string;
  /** Requested stake, whole percent 1..=100. */
  pct: number;
  note: string;
  /** `"declined"` when the founder said so; unknown decisions read as no decision. */
  decision: "declined" | null;
  createdAt: number;
}

function tagValue(tags: string[][], name: string): string | null {
  const tag = tags.find((t) => t[0] === name);
  return tag && tag.length >= 2 && tag[1] ? tag[1] : null;
}

function readContent(content: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // A non-object body yields no fields; the checks below drop it.
  }
  return {};
}

/** Parse one kind:37016 event. Returns null when the record is unusable: no
 * coordinate, no attributable project, no valid role or percentage. */
export function parseJoinRequest(event: {
  kind: number;
  id?: string;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
}): JoinRequest | null {
  if (event.kind !== KIND_ORG_JOIN_REQUEST) return null;
  const key = tagValue(event.tags, "d");
  if (!key || key.length > 64) return null;
  const body = readContent(event.content);

  const projectId = typeof body.project === "string" ? body.project : "";
  if (!PROJECT_ID_RE.test(projectId)) return null;
  const role = typeof body.role === "string" ? body.role : "";
  if (!ROLE_SLUG_RE.test(role)) return null;
  const pctTag = typeof body.pct === "string" ? body.pct : null;
  if (!pctTag || !/^\d{1,3}$/.test(pctTag)) return null;
  const pct = Number(pctTag);
  if (pct < 1 || pct > 100) return null;

  const owner =
    (typeof body.owner === "string" && PUBKEY_RE.test(body.owner)
      ? body.owner
      : null) ??
    tagValue(event.tags, "p") ??
    null;
  if (!owner) return null;
  const requester =
    (typeof body.requester === "string" && PUBKEY_RE.test(body.requester)
      ? body.requester
      : null) ?? event.pubkey;

  return {
    eventId: event.id ?? "",
    author: event.pubkey,
    key,
    projectId,
    owner,
    requester,
    role,
    pct,
    note: typeof body.note === "string" ? body.note : "",
    decision: body.decision === "declined" ? "declined" : null,
    createdAt: event.created_at,
  };
}

/** Input for {@link buildJoinRequestTemplate}. */
export interface JoinRequestInput {
  projectId: string;
  /** Founder pubkey — whose project is being joined. */
  owner: string;
  requester: string;
  role: string;
  pct: number;
  note: string;
}

/** A field-level validation failure the dialog can render inline. */
export class JoinRequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JoinRequestValidationError";
  }
}

/** The `d` coordinate for a (project, role, requester) thread. */
export function joinRequestKey(
  projectId: string,
  role: string,
  requester: string,
): string {
  return `${projectId}/${role}/${requester.slice(0, REQUESTER_DISCRIMINATOR_LEN)}`;
}

/** Build the unsigned kind:37016 template a requester publishes. */
export function buildJoinRequestTemplate(input: JoinRequestInput): {
  kind: number;
  tags: string[][];
  content: string;
} {
  const projectId = input.projectId.trim();
  if (!PROJECT_ID_RE.test(projectId)) {
    throw new JoinRequestValidationError("That is not a valid project id.");
  }
  const role = input.role.trim();
  if (!ROLE_SLUG_RE.test(role)) {
    throw new JoinRequestValidationError(
      `Role id "${role}" must be 1-12 characters of a-z, 0-9 and dashes.`,
    );
  }
  if (!PUBKEY_RE.test(input.owner)) {
    throw new JoinRequestValidationError("The project owner is not a pubkey.");
  }
  if (!PUBKEY_RE.test(input.requester)) {
    throw new JoinRequestValidationError("Your identity is not a pubkey yet.");
  }
  if (!Number.isInteger(input.pct) || input.pct < 1 || input.pct > 100) {
    throw new JoinRequestValidationError(
      "Ask for a whole percentage between 1 and 100.",
    );
  }
  const note = input.note.trim();
  if (!note || note.length > 500) {
    throw new JoinRequestValidationError(
      "Add a short note (1-500 characters) saying why you.",
    );
  }
  const key = joinRequestKey(projectId, role, input.requester);
  if (key.length > 64) {
    throw new JoinRequestValidationError(
      "This request's coordinate is too long — shorten the project id.",
    );
  }

  return {
    kind: KIND_ORG_JOIN_REQUEST,
    tags: [
      ["d", key],
      ["role", role],
      ["p", input.owner],
    ],
    content: JSON.stringify({
      v: 1,
      project: projectId,
      owner: input.owner,
      role,
      pct: String(input.pct),
      note,
      requester: input.requester,
    }),
  };
}

/**
 * Build the founder's decline: the same record (so it resolves as the same
 * thread), re-signed under the founder's key, carrying the requester's
 * identity forward. One write; the newest record wins.
 */
export function buildDeclineTemplate(request: JoinRequest): {
  kind: number;
  tags: string[][];
  content: string;
} {
  if (!PUBKEY_RE.test(request.owner)) {
    throw new JoinRequestValidationError("The project owner is not a pubkey.");
  }
  return {
    kind: KIND_ORG_JOIN_REQUEST,
    tags: [
      ["d", request.key],
      ["role", request.role],
      ["p", request.owner],
    ],
    content: JSON.stringify({
      v: 1,
      project: request.projectId,
      owner: request.owner,
      role: request.role,
      pct: String(request.pct),
      note: request.note,
      requester: request.requester,
      decision: "declined",
    }),
  };
}

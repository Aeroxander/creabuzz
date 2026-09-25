/**
 * Project pitch / team manifest — kind:37015 (`KIND_ORG_PITCH`).
 *
 * A Project Board entry is an org node from day one plus this record: the
 * node carries the seat structure (NIP-ORG 37010: `name`, `kind`, `holders`,
 * `ui.blurb` — but no free-text pitch and no equity declaration), and this
 * d-tagged pitch carries the prose and the declared roles the board renders.
 *
 * Sources (all cited, READ-ONLY):
 * - `docs/nips/NIP-ORG.md` — the 37010 node shape (:114-150) is what the
 *   pitch reuses for identity (same `d`, same author); 37011 is the "signed,
 *   scoped, revocable" grant whose republication under the same `(issuer, d)`
 *   revokes it (:152-187) — the revocation semantics a recorded stake
 *   inherits; org records are community-level and global-only (:110-112).
 * - `crates/buzz-core/src/kind.rs` — `KIND_ORG_PITCH = 37015`,
 *   `KIND_ORG_JOIN_REQUEST = 37016` (registered kinds, NIP-33).
 * - `crates/buzz-relay/src/handlers/ingest.rs` `validate_org_envelope` /
 *   `validate_org_role_tag` — the ingest bounds this grammar must satisfy:
 *   role slug 1..=12 chars of `[a-z0-9-]`, label 1..=64 chars, percentage a
 *   whole number 1..=100, at most 64 `role` tags, one `name` tag ≤128 chars,
 *   one `d` ≤64 chars, JSON-object content ≤16 KB.
 * - `docs/nips/NIP-LP.md` (:55-125) — the launch record's `pitch` content
 *   field and `["team", <hex-pubkey>, <role>]` tags are the tag-with-role
 *   grammar style the `role` tag follows; content prose lives in content,
 *   indexable structure in tags.
 * - `docs/dao-launchpad-plan.md` §9 / `docs/next-gen-launchpad-plan.md` §7.5,
 *   §9 — compliance is project-owned ("creabuzz is a coordination +
 *   infrastructure layer"): what this module records is a claim, and the UI
 *   says so next to every stake.
 *
 * The pool bound: declared role percentages must sum to ≤100. One project's
 * equity cannot be declared twice, so a manifest that breaks the bound is
 * refused at build time and flagged (never hidden) on read.
 */

import { KIND_ORG_PITCH } from "../../../shared/constants/kinds.ts";

/** Project id (`d` of the org node and the pitch). Relay caps `d` at 64; the join-request `d` needs room for `/<role>/<requester-16>`. */
export const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** Role slug: the identity shared by manifest tag, join request, and grant. */
export const ROLE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,11}$/;

/** UI caps (the relay allows 64 role tags / 128-char names; the board is stricter). */
export const MAX_ROLES = 16;
export const MAX_NAME_LEN = 128;
export const MAX_SUMMARY_LEN = 200;
export const MAX_DESCRIPTION_LEN = 8000;
/** The equity pool one project can declare or grant. */
export const POOL_PCT = 100;

/** One declared role: a seat and the stake it targets. */
export interface RoleDeclaration {
  /** Stable identity across request and grant (`[a-z0-9-]{1,12}`). */
  slug: string;
  label: string;
  /** Target stake for the role, 1..=100 — the ceiling a join request may ask for. */
  pct: number;
}

/** A parsed kind:37015 pitch. */
export interface PitchManifest {
  eventId: string;
  author: string;
  /** `d`: the project's org-node id. */
  nodeId: string;
  name: string;
  summary: string;
  description: string;
  /** Slug of the role the founder holds (taken, never open to joiners). */
  founderRole: string | null;
  roles: RoleDeclaration[];
  createdAt: number;
  /** Declared percentages exceed the pool — render, never trust the sum. */
  overPool: boolean;
}

function tagValue(tags: string[][], name: string): string | null {
  const tag = tags.find((t) => t[0] === name);
  return tag && tag.length >= 2 && tag[1] ? tag[1] : null;
}

function contentObject(content: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed content still surfaces the tag-declared structure.
  }
  return {};
}

/** Sum of declared stakes — the pool usage. */
export function declaredPool(roles: readonly RoleDeclaration[]): number {
  return roles.reduce((total, role) => total + role.pct, 0);
}

/**
 * Parse one kind:37015 event. Returns null only when the record has no
 * identity (`d`): a pitch without a project id cannot be placed on the board.
 * Malformed content or an unreadable `role` tag fails open — the project
 * still renders with the roles that parsed, so a broken body cannot hide a
 * pitch (index-org.ts convention).
 */
export function parsePitch(event: {
  kind: number;
  id?: string;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
}): PitchManifest | null {
  if (event.kind !== KIND_ORG_PITCH) return null;
  const nodeId = tagValue(event.tags, "d");
  if (!nodeId) return null;
  const body = contentObject(event.content);

  const roles: RoleDeclaration[] = [];
  const seen = new Set<string>();
  for (const tag of event.tags) {
    if (tag[0] !== "role") continue;
    const slug = tag[1];
    const label = tag[2];
    const pct = tag[3];
    if (!slug || !ROLE_SLUG_RE.test(slug) || seen.has(slug)) continue;
    if (!label || typeof label !== "string" || label.length > 64) continue;
    if (!/^\d{1,3}$/.test(pct ?? "")) continue;
    const pctValue = Number(pct);
    if (pctValue < 1 || pctValue > 100) continue;
    seen.add(slug);
    roles.push({ slug, label, pct: pctValue });
  }

  const founderRole =
    typeof body.founderRole === "string" && seen.has(body.founderRole)
      ? body.founderRole
      : null;

  return {
    eventId: event.id ?? "",
    author: event.pubkey,
    nodeId,
    name: tagValue(event.tags, "name") ?? nodeId,
    summary: typeof body.summary === "string" ? body.summary : "",
    description: typeof body.description === "string" ? body.description : "",
    founderRole,
    roles,
    createdAt: event.created_at,
    overPool: declaredPool(roles) > POOL_PCT,
  };
}

/** Input for {@link buildPitchTemplate}. */
export interface PitchInput {
  nodeId: string;
  name: string;
  summary: string;
  description: string;
  founderRole: string;
  roles: RoleDeclaration[];
}

/** A field-level validation failure the dialog can render inline. */
export class PitchValidationError extends Error {
  readonly field: "nodeId" | "name" | "summary" | "description" | "roles";

  constructor(
    field: "nodeId" | "name" | "summary" | "description" | "roles",
    message: string,
  ) {
    super(message);
    this.name = "PitchValidationError";
    this.field = field;
  }
}

/** Slug candidate for a project id (`slugify("My App") === "my-app"`). */
export function slugify(name: string): string | null {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return PROJECT_ID_RE.test(slug) ? slug : null;
}

/** A role declaration that satisfies both the UI caps and the relay bounds. */
function validateRole(role: RoleDeclaration, field: "roles"): void {
  if (!ROLE_SLUG_RE.test(role.slug)) {
    throw new PitchValidationError(
      field,
      `Role id "${role.slug}" must be 1-12 characters of a-z, 0-9 and dashes.`,
    );
  }
  const label = role.label.trim();
  if (!label || label.length > 64) {
    throw new PitchValidationError(
      field,
      `Role "${role.slug}" needs a label of 1-64 characters.`,
    );
  }
  if (!Number.isInteger(role.pct) || role.pct < 1 || role.pct > 100) {
    throw new PitchValidationError(
      field,
      `Role "${role.slug}" needs a whole percentage between 1 and 100.`,
    );
  }
}

/**
 * Build the unsigned kind:37015 template (sign → publish, like every other
 * write in this client). Throws {@link PitchValidationError} with a
 * field-level message so the dialog can show it in place instead of a toast.
 */
export function buildPitchTemplate(input: PitchInput): {
  kind: number;
  tags: string[][];
  content: string;
} {
  const nodeId = input.nodeId.trim();
  if (!PROJECT_ID_RE.test(nodeId)) {
    throw new PitchValidationError(
      "nodeId",
      "Project id must be 1-32 characters of a-z, 0-9 and dashes.",
    );
  }
  const name = input.name.trim();
  if (!name || name.length > MAX_NAME_LEN) {
    throw new PitchValidationError(
      "name",
      `Name must be 1-${MAX_NAME_LEN} characters.`,
    );
  }
  const summary = input.summary.trim();
  if (!summary || summary.length > MAX_SUMMARY_LEN) {
    throw new PitchValidationError(
      "summary",
      `The one-line pitch must be 1-${MAX_SUMMARY_LEN} characters.`,
    );
  }
  if (input.description.length > MAX_DESCRIPTION_LEN) {
    throw new PitchValidationError(
      "description",
      `Description must be at most ${MAX_DESCRIPTION_LEN} characters.`,
    );
  }
  if (input.roles.length === 0 || input.roles.length > MAX_ROLES) {
    throw new PitchValidationError(
      "roles",
      `Declare between 1 and ${MAX_ROLES} roles.`,
    );
  }
  const seen = new Set<string>();
  for (const role of input.roles) {
    validateRole(role, "roles");
    if (seen.has(role.slug)) {
      throw new PitchValidationError(
        "roles",
        `Role "${role.slug}" is declared twice.`,
      );
    }
    seen.add(role.slug);
  }
  const founderRole = input.founderRole.trim();
  if (!seen.has(founderRole)) {
    throw new PitchValidationError(
      "roles",
      "Pick which declared role you take as the founder.",
    );
  }
  const pool = declaredPool(input.roles);
  if (pool > POOL_PCT) {
    throw new PitchValidationError(
      "roles",
      `Declared stakes add up to ${pool}% — a project can declare at most ${POOL_PCT}%.`,
    );
  }

  const tags: string[][] = [
    ["d", nodeId],
    ["name", name],
    ...input.roles.map((role): string[] => [
      "role",
      role.slug,
      role.label.trim(),
      String(role.pct),
    ]),
  ];
  const content: Record<string, unknown> = {
    v: 1,
    summary,
    founderRole,
  };
  const description = input.description.trim();
  if (description) content.description = description;
  return { kind: KIND_ORG_PITCH, tags, content: JSON.stringify(content) };
}

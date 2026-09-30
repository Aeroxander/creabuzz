/**
 * How much one person's vote counts in the feed.
 *
 * The weight is earned the same way the relay counts reviews (NIP-ORG reviewer
 * rule): work matters once someone with org authority has accepted it.
 *
 * - An org authority holder — a community admin, or a human seated in an
 *   anchored org node — counts 2.
 * - A contributor whose work an authority holder accepted counts 1, plus 0.25
 *   per further accepted piece, up to 2.
 * - Everyone else counts 0.2. A newcomer's vote still shows; a thousand fresh
 *   keys just cannot outvote a handful of people with a track record.
 *
 * Admins are derived from root org nodes: the relay only accepts a root node
 * from a community admin, so a root node's author is an admin. Agent seats
 * never confer authority (`isAuthorityHolder`), and self-review never counts.
 *
 * Pure and alias-free: `trust-weight.test.mjs` drives it under `node --test`.
 */

import {
  isAuthorityHolder,
  type OrgGraph,
  type StoredOrgGrant,
  type StoredOrgNode,
} from "../../fleet/lib/orgAuthority.ts";
import {
  KIND_CONTRIBUTION_RECORD,
  KIND_ORG_GRANT,
  KIND_ORG_NODE,
} from "../../../shared/constants/kinds.ts";
import type { SignedEventLike } from "./feed-events.ts";

export const NEWCOMER_WEIGHT = 0.2;
export const CONTRIBUTOR_WEIGHT = 1;
export const PER_EXTRA_ACCEPTED = 0.25;
export const MAX_WEIGHT = 2;

function dTag(event: SignedEventLike): string | null {
  const tag = event.tags.find((t) => t[0] === "d");
  return tag && typeof tag[1] === "string" && tag[1] !== "" ? tag[1] : null;
}

function jsonObject(content: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(content);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];

/** Build the community's org graph from its 37010 / 37011 events. */
export function orgGraphFromEvents(
  events: readonly SignedEventLike[],
): OrgGraph {
  const nodes: StoredOrgNode[] = [];
  const grants: StoredOrgGrant[] = [];
  for (const event of events) {
    const d = dTag(event);
    const body = jsonObject(event.content);
    if (!d || !body) continue;
    if (event.kind === KIND_ORG_NODE) {
      const scope =
        body.scope !== null && typeof body.scope === "object"
          ? (body.scope as Record<string, unknown>)
          : {};
      nodes.push({
        author: event.pubkey.toLowerCase(),
        createdAt: event.created_at,
        eventId: event.id.toLowerCase(),
        d,
        parent:
          typeof body.parent === "string" && body.parent !== ""
            ? body.parent
            : null,
        holders: strings(body.holders).map((h) => h.toLowerCase()),
        agentSeats: strings(body.agentSeats).map((h) => h.toLowerCase()),
        canGrant: strings(scope.canGrant),
      });
    } else if (event.kind === KIND_ORG_GRANT) {
      if (typeof body.issuer !== "string" || typeof body.grantee !== "string") {
        continue;
      }
      grants.push({
        author: event.pubkey.toLowerCase(),
        createdAt: event.created_at,
        eventId: event.id.toLowerCase(),
        d,
        issuer: body.issuer.toLowerCase(),
        grantee: body.grantee.toLowerCase(),
        via: typeof body.via === "string" ? body.via : "",
        verbs: strings(body.verbs),
        parentGrant:
          typeof body.parentGrant === "string" ? body.parentGrant : null,
        expires: typeof body.expires === "number" ? body.expires : null,
        revoked: body.revoked === true,
      });
    }
  }
  const admins = [
    ...new Set(nodes.filter((n) => n.parent === null).map((n) => n.author)),
  ];
  return { admins, nodes, grants };
}

/**
 * Accepted contributions per contributor. A contribution is accepted when a
 * DIFFERENT key that holds org authority published the same record (`d`)
 * with `reviewStatus: "accepted"` after the contributor first published it.
 */
export function acceptedContributions(
  graph: OrgGraph,
  records: readonly SignedEventLike[],
): Map<string, number> {
  const firstBy = new Map<string, { author: string; at: number }>();
  const sorted = records
    .filter((e) => e.kind === KIND_CONTRIBUTION_RECORD)
    .slice()
    .sort((a, b) => a.created_at - b.created_at);
  for (const event of sorted) {
    const d = dTag(event);
    if (d && !firstBy.has(d)) {
      firstBy.set(d, {
        author: event.pubkey.toLowerCase(),
        at: event.created_at,
      });
    }
  }
  const authority = new Map<string, boolean>();
  const holds = (pubkey: string) => {
    let known = authority.get(pubkey);
    if (known === undefined) {
      known = isAuthorityHolder(graph, pubkey);
      authority.set(pubkey, known);
    }
    return known;
  };
  const accepted = new Set<string>();
  for (const event of sorted) {
    const d = dTag(event);
    const first = d ? firstBy.get(d) : undefined;
    if (!d || !first) continue;
    const reviewer = event.pubkey.toLowerCase();
    if (reviewer === first.author || event.created_at < first.at) continue;
    if (jsonObject(event.content)?.reviewStatus !== "accepted") continue;
    if (holds(reviewer)) accepted.add(d);
  }
  const counts = new Map<string, number>();
  for (const d of accepted) {
    const author = (firstBy.get(d) as { author: string }).author;
    counts.set(author, (counts.get(author) ?? 0) + 1);
  }
  return counts;
}

/** The weight function the tally uses. */
export function voteWeights(
  graph: OrgGraph,
  records: readonly SignedEventLike[],
): (pubkey: string) => number {
  const accepted = acceptedContributions(graph, records);
  const cache = new Map<string, number>();
  return (pubkey: string) => {
    const key = pubkey.toLowerCase();
    const known = cache.get(key);
    if (known !== undefined) return known;
    let weight = NEWCOMER_WEIGHT;
    if (isAuthorityHolder(graph, key)) {
      weight = MAX_WEIGHT;
    } else {
      const count = accepted.get(key) ?? 0;
      if (count > 0) {
        weight = Math.min(
          MAX_WEIGHT,
          CONTRIBUTOR_WEIGHT + PER_EXTRA_ACCEPTED * (count - 1),
        );
      }
    }
    cache.set(key, weight);
    return weight;
  };
}

/**
 * The helper seats of a project's organization: which are open, which are
 * filled, and the record that fills or empties one. Alias-free;
 * `helper-seats.test.mjs` drives it under `node --test`.
 *
 * A template gives every helper a seat named `seat-<persona id>` under the
 * founder's seat, vacant until a helper takes it. Running a helper in this tab
 * (or anywhere) is only half of it: the seat is what the organization chart,
 * its budget and the rest of the team see, so taking a seat is a record the
 * project's owner signs.
 */

import { type OrgNodeEntry, orgNodeKey } from "./index-org.ts";

const KIND_ORG_NODE = 37010;

/** One helper seat. */
export interface HelperSeat {
  /** The org node id (`seat-writer`). */
  nodeId: string;
  /** The author-qualified key of the node, to find it again. */
  key: string;
  /** The persona this seat is for (`writer`), or null for a seat made by hand. */
  personaId: string | null;
  /** The seat's name: "Head of Story", or the helper's name. */
  title: string;
  /** Pubkeys of the helpers in the seat. */
  occupants: string[];
}

/** Every helper seat, vacant ones first, then by name. */
export function helperSeats(byKey: Record<string, OrgNodeEntry>): HelperSeat[] {
  const seats: HelperSeat[] = [];
  for (const entry of Object.values(byKey)) {
    if (entry.kind !== "agent_seat") continue;
    seats.push({
      nodeId: entry.id,
      key: orgNodeKey(entry.pubkey, entry.id),
      personaId: entry.id.startsWith("seat-")
        ? entry.id.slice("seat-".length)
        : null,
      title: entry.name,
      occupants: entry.agentSeats,
    });
  }
  return seats.sort(
    (a, b) =>
      Number(a.occupants.length > 0) - Number(b.occupants.length > 0) ||
      a.title.localeCompare(b.title),
  );
}

/** A seat in words: open, or who is in it and whether they are online. */
export function describeSeat(
  seat: HelperSeat,
  agents: ReadonlyMap<string, { name: string; alive: boolean }>,
): { state: "open" | "online" | "offline"; text: string } {
  if (seat.occupants.length === 0) {
    return { state: "open", text: "Open seat" };
  }
  const known = seat.occupants
    .map((pubkey) => agents.get(pubkey))
    .filter(
      (agent): agent is { name: string; alive: boolean } => agent !== undefined,
    );
  const live = known.find((agent) => agent.alive);
  if (live) return { state: "online", text: `${live.name} · online` };
  const name = known[0]?.name ?? "A helper";
  return { state: "offline", text: `${name} · offline` };
}

/** A record to sign and send. */
export interface SeatDraft {
  kind: number;
  tags: string[][];
  content: string;
}

/**
 * The seat with `agentPubkey` put in it or taken out. Everything else about the
 * seat stays as it was; the record replaces the old one (same author, same id).
 * Returns null when there is nothing to change.
 */
export function seatUpdate(
  entry: OrgNodeEntry,
  agentPubkey: string,
  change: "fill" | "empty",
): SeatDraft | null {
  const pubkey = agentPubkey.toLowerCase();
  const has = entry.agentSeats.includes(pubkey);
  if (change === "fill" && has) return null;
  if (change === "empty" && !has) return null;
  const agentSeats =
    change === "fill"
      ? [...entry.agentSeats, pubkey]
      : entry.agentSeats.filter((p) => p !== pubkey);
  return {
    kind: KIND_ORG_NODE,
    content: JSON.stringify({
      v: 1,
      name: entry.name,
      kind: "agent_seat",
      ...(entry.parent ? { parent: entry.parent } : {}),
      holders: entry.holders,
      agentSeats,
      scope: entry.scope ?? {
        readBelow: false,
        assignBelow: false,
        canGrant: [],
      },
    }),
    tags: [
      ["d", entry.id],
      ["name", entry.name],
      ...entry.holders.map((p) => ["seat", p]),
      ...agentSeats.map((p) => ["seat", p]),
    ],
  };
}
